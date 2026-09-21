// Полное обновление данных: молнии → грозы над лесом → погода → public/data/spots.json
//
// Запуск:
//   node scripts/update.mjs                 последние 7 суток
//   node scripts/update.mjs --demo          неделя с сильными грозами (для проверки интерфейса)
//   node scripts/update.mjs --demo=2026-06-21 --days=7
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_RADIUS_KM, DAYS, HOME, TZ } from '../lib/config.mjs';
import { loadFrames, pruneFrames } from '../lib/lightning.mjs';
import { buildPasses } from '../lib/storms.mjs';
import { buildSpots } from '../lib/spots.mjs';
import { analyse, fetchDaily, snap } from '../lib/weather.mjs';

const OUT = path.join(process.cwd(), 'public', 'data', 'spots.json');

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const arg = (name) => {
  const a = process.argv.find((v) => v === `--${name}` || v.startsWith(`--${name}=`));
  return a === undefined ? null : a.includes('=') ? a.split('=')[1] : '';
};

const log = (...m) => console.log('[update]', ...m);

/** Дата и время в местном поясе. */
function local(ms) {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => +parts.find((p) => p.type === t).value;
  const hh = String(get('hour')).padStart(2, '0');
  const mm = String(get('minute')).padStart(2, '0');
  const y = get('year'), m = get('month'), d = get('day');
  return {
    date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    time: `${hh}:${mm}`,
    dayLabel: `${d} ${MONTHS[m - 1]}`,
  };
}

const plural = (n, f) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? f[0] : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? f[1] : f[2];
};


async function main() {
  const demo = arg('demo');
  const days = +(arg('days') || DAYS);

  // Демо-неделя по умолчанию: 27 августа – 3 сентября 2026, четыре грозовых дня над регионом.
  // Она же укладывается в 31 день истории Open-Meteo, поэтому у пятен есть осадки и оценки.
  const now = demo === null ? new Date() : new Date(`${demo || '2026-09-03'}T21:55:00Z`);
  const from = new Date(now.getTime() - days * 86400_000);

  log(demo === null ? `режим: последние ${days} суток` : `режим: демо-неделя по ${now.toISOString().slice(0, 10)}`);
  log(`окно: ${from.toISOString()} .. ${now.toISOString()}`);

  // 1. Молнии
  const t0 = Date.now();
  const { frames, latest, fetched, cached, failed, skipped } = await loadFrames(from, now, {
    concurrency: 10,
    onProgress: (d, t) => process.stdout.write(`\r[update] кадры: ${d}/${t}`),
  });
  if (fetched) process.stdout.write('\n');
  log(`кадров с молниями: ${frames.length} (загружено ${fetched}, из кэша ${cached}, не удалось ${failed.length}) за ${Math.round((Date.now() - t0) / 1000)} с`);
  if (failed.length) log('не загрузились:', failed.slice(0, 3).join('; '), failed.length > 3 ? `…ещё ${failed.length - 3}` : '');
  if (skipped) log(`пробелов в данных сервиса (больше не перезапрашиваем): ${skipped}`);

  // 2. Проходы гроз над ячейками сетки
  const passes = buildPasses(frames);
  log(`проходов грозы над ячейками: ${passes.length}`);

  // 3. Пересечение с лесами OSM
  const { spots, forests } = passes.length ? await buildSpots(passes, (m) => log(' ', m)) : { spots: [], forests: [] };
  log(`пятен «гроза над лесом»: ${spots.length}, лесных контуров под грозой: ${forests.length}`);

  // 4. Погода и оценка
  const today = local(now.getTime()).date;
  let weather = new Map();
  if (spots.length) {
    weather = await fetchDaily(spots.map((s) => ({ lat: s.lat, lon: s.lon })), { today });
    log(`погода получена для ${weather.size} точек`);
  }

  const ready = [];
  for (const sp of spots) {
    const daily = weather.get(`${snap(sp.lat)},${snap(sp.lon)}`);
    if (!daily) continue;
    const when = local(sp.startMs);
    const a = analyse(daily, when.date, today);
    if (!a) continue;

    ready.push({
      id: sp.id,
      forest: sp.forest,
      place: sp.place,
      protectedArea: sp.protectedArea,
      lat: sp.lat,
      lon: sp.lon,
      radiusM: sp.radiusM,
      forestId: sp.forestId,
      acc: sp.acc,
      stormId: `st${sp.stormIndex}`,
      startUtc: new Date(sp.startMs).toISOString(),
      endUtc: new Date(sp.endMs).toISOString(),
      dayLabel: when.dayLabel,
      time: when.time === local(sp.endMs).time ? when.time : `${when.time}–${local(sp.endMs).time}`,
      agoDays: a.daysSince,
      agoText: a.daysSince === 0 ? 'сегодня' : `${a.daysSince} ${plural(a.daysSince, ['день', 'дня', 'дней'])} назад`,
      strikesText: `${sp.areaKm2} км² · сила ${sp.peak} из 6`,
      rainMm: a.stormMm,
      rainText: `${a.stormMm} мм`,
      sinceRainText: a.sinceStormMm > 0 ? `${a.sinceStormMm} мм` : 'сухо',
      tempText: a.tempRange ? `днём ${a.tempRange[0]}–${a.tempRange[1]} °C` : '—',
      chart: a.chart,
    });
  }

  // Самые свежие грозы наверх: по ним и планируется поездка.
  ready.sort((a, b) => a.agoDays - b.agoDays || b.acc - a.acc);

  // Каждому лесному контуру — давность грозы, которая по нему прошла: карта красит лес
  // по свежести. Если своего пятна нет, берём ближайшее той же грозы.
  const byForestId = new Map();
  for (const r of ready) {
    const cur = byForestId.get(r.forestId);
    if (!cur || r.agoDays < cur.agoDays) byForestId.set(r.forestId, r);
  }
  for (const f of forests) {
    let best = byForestId.get(f.id);
    if (!best) {
      const [lon, lat] = f.ring[0];
      let bestKm = Infinity;
      for (const r of ready) {
        const km = Math.hypot((r.lat - lat) * 110.6, (r.lon - lon) * 111.3 * Math.cos((lat * Math.PI) / 180));
        if (km < bestKm) { bestKm = km; best = r; }
      }
      if (bestKm > 8) best = null;
    }
    f.agoDays = best ? best.agoDays : null;
    f.spotId = best ? best.id : null;
  }

  // 5. Слой разрядов: где молнии были вообще, включая поля
  const strikes = passes
    .slice()
    .sort((a, b) => b.acc - a.acc)
    .slice(0, 4000)
    .map((p) => [
      +p.lat.toFixed(3),
      +p.lon.toFixed(3),
      Math.max(0, Math.round((now.getTime() - p.endMs) / 86400_000)),
    ]);

  const payload = {
    generatedAt: new Date().toISOString(),
    dataThrough: latest || now.toISOString(),
    windowFrom: from.toISOString(),
    windowDays: days,
    demo: demo !== null,
    demoLabel: demo !== null ? `${local(from.getTime()).dayLabel} – ${local(now.getTime()).dayLabel}` : null,
    home: { lat: HOME.lat, lon: HOME.lon, label: HOME.label },
    dataRadiusKm: DATA_RADIUS_KM,
    forests,
    spots: ready,
    strikes,
    stats: {
      frames: frames.length,
      passes: passes.length,
      spotsBeforeWeather: spots.length,
      failedFrames: failed.length,
    },
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(payload));
  const size = (await fs.stat(OUT)).size;
  log(`записано ${OUT} (${Math.round(size / 1024)} КБ), пятен: ${ready.length}`);

  if (demo === null) {
    const removed = await pruneFrames(new Date(Date.now() - (days + 2) * 86400_000));
    if (removed) log(`удалено старых файлов кадров: ${removed}`);
  }
}

main().catch((e) => {
  console.error('[update] ошибка:', e);
  process.exit(1);
});
