// Погода из Open-Meteo (без ключа): сколько дождя дала гроза и что было после.
//
// Лимит бесплатного тарифа считается «взвешенно»: пачка из 100 точек на 6 переменных
// за 38 дней стоит около 280 вызовов из 600 в минуту. Поэтому паузу между пачками
// считаем по фактическому весу запроса, а не подбираем на глаз.
import fs from 'node:fs/promises';
import path from 'node:path';
import { RAIN_MIN_MM, RAIN_STEP_DEG, WEATHER_CACHE_DIR } from './config.mjs';

/** Кэш погоды общий: он привязан к координатам, а не к области. */
const CACHE_DIR = WEATHER_CACHE_DIR;
const API = 'https://api.open-meteo.com/v1/forecast';
const DAILY = 'precipitation_sum,temperature_2m_max,temperature_2m_min,weather_code,et0_fao_evapotranspiration,soil_moisture_0_to_7cm_mean';
const DAILY_VARS = DAILY.split(',').length;

/** Столько точек в одной пачке: URL остаётся заметно короче предела в ~8 КБ. */
const BATCH = 100;
/** Взвешенных вызовов в минуту на бесплатном тарифе. */
const MINUTE_LIMIT = 600;

/** Окно вокруг даты снимка: месяц до (график) и неделя после (дождь после грозы). */
export const WINDOW_BEFORE = 30;
export const WINDOW_AFTER = 7;
/** Глубже этого Open-Meteo по адресу forecast не отдаёт ничего. */
export const MAX_PAST_DAYS = 92;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const snap = (v) => +(Math.round(v / 0.02) * 0.02).toFixed(2);

/** Дата в местном поясе, ГГГГ-ММ-ДД. Шведская локаль даёт ровно такой формат. */
export const localDate = (d = new Date(), tz = 'Europe/Warsaw') =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const shiftDate = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);

/**
 * Окно запроса для даты снимка. Раньше окно всегда отсчитывалось от сегодняшнего
 * числа, и снимок месячной давности оставался вовсе без погоды.
 */
export function weatherWindow(today) {
  const start = shiftDate(today, -WINDOW_BEFORE);
  const depthDays = daysBetween(start, localDate());
  return { start, end: shiftDate(today, WINDOW_AFTER), depthDays, ok: depthDays <= MAX_PAST_DAYS };
}

/** Самая ранняя дата, для которой погода ещё есть. */
export const earliestWeatherDate = () => shiftDate(localDate(), -(MAX_PAST_DAYS - WINDOW_BEFORE));

/** Вес запроса в единицах лимита: столько «вызовов» он стоит. */
const weightOf = (points, days, vars) => points * Math.max(1, days / 14) * Math.max(1, vars / 10);

/** Пауза, после которой такой же запрос снова укладывается в минутный лимит. */
const paceMs = (weight) => Math.min(60_000, Math.max(1000, Math.ceil((weight / MINUTE_LIMIT) * 60_000)));

/**
 * Один запрос к Open-Meteo с разбором отказов.
 *
 * Минутный лимит пережидаем, любой другой отказ считаем окончательным: суточный
 * лимит снимется только завтра, а неизвестную причину бессмысленно долбить
 * повторами. Причину берём из поля `reason` ответа, а не ищем слово в тексте:
 * в самом запросе есть `&daily=`, и подстрочный поиск ловил бы собственный URL.
 */
async function askOpenMeteo(url, { deadline }) {
  let last = 'нет ответа';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });

    if (res.status === 429) {
      const body = await res.text();
      let reason = body.slice(0, 200);
      try { reason = JSON.parse(body).reason || reason; } catch {}
      if (!/minut/i.test(reason)) {
        throw new Error(/dai|day/i.test(reason)
          ? 'исчерпан суточный лимит Open-Meteo — повторите завтра'
          : `Open-Meteo отказал: ${reason}`);
      }
      if (Date.now() + 61_000 > deadline) throw new Error(`Open-Meteo держит минутный лимит дольше отведённого времени: ${reason}`);
      await sleep(61_000);
      last = reason;
      continue;
    }

    // 502/503/504 — служба временно недоступна. Это проходит само за секунды,
    // и ронять из-за него всю сборку незачем.
    if (res.status >= 500) {
      const pause = 5000 * attempt;
      if (attempt === 4 || Date.now() + pause > deadline) throw new Error(`Open-Meteo не отвечает: HTTP ${res.status}`);
      await sleep(pause);
      last = `HTTP ${res.status}`;
      continue;
    }

    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = await res.json();
    if (data?.error) throw new Error(`Open-Meteo: ${data.reason || 'ошибка'}`);
    return data;
  }
  throw new Error(`Open-Meteo не ответил после повторов: ${last}`);
}

/**
 * Погода для набора точек. Ключ кэша — округлённые координаты и дата снимка.
 * @param {Array<{lat:number, lon:number}>} points
 * @param {{today?:string, prune?:boolean}} opts
 * @returns {Promise<Map<string, object>>} ключ `lat,lon` округлённых координат → daily
 */
export async function fetchDaily(points, { today = localDate(), prune = false } = {}) {
  const win = weatherWindow(today);
  if (!win.ok) {
    throw new Error(`Open-Meteo отдаёт погоду примерно за ${MAX_PAST_DAYS} последних дней, `
      + `а для ${today} нужна глубина ${win.depthDays}. Снимки глубже ${earliestWeatherDate()} собрать нельзя.`);
  }

  const keyed = new Map();
  for (const p of points) {
    const lat = snap(p.lat), lon = snap(p.lon);
    keyed.set(`${lat},${lon}`, { lat, lon });
  }

  const cacheFile = path.join(CACHE_DIR, `weather-${today}.json`);
  let cache = {};
  try {
    cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  } catch {}

  const missing = [...keyed.entries()].filter(([k]) => !cache[k]).map(([, v]) => v);
  const windowDays = WINDOW_BEFORE + WINDOW_AFTER + 1;
  const deadline = Date.now() + 15 * 60_000;

  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    // Запятые не кодируем: URLSearchParams превратил бы их в %2C и утроил длину.
    const url =
      `${API}?latitude=${chunk.map((p) => p.lat).join(',')}` +
      `&longitude=${chunk.map((p) => p.lon).join(',')}` +
      `&daily=${DAILY}&timezone=Europe%2FWarsaw&start_date=${win.start}&end_date=${win.end}`;

    const data = await askOpenMeteo(url, { deadline });

    // Ответ — массив в порядке запроса; связь с точкой только по индексу.
    const list = Array.isArray(data) ? data : [data];
    chunk.forEach((p, j) => {
      if (list[j]?.daily) cache[`${p.lat},${p.lon}`] = list[j].daily;
    });

    if (i + BATCH < missing.length) await sleep(paceMs(weightOf(chunk.length, windowDays, DAILY_VARS)));
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(cache));
  if (prune) await pruneCache();

  const out = new Map();
  for (const k of keyed.keys()) if (cache[k]) out.set(k, cache[k]);
  return out;
}

/**
 * Чистка кэша. Вызывается только из обычного обновления: раньше сборка снимка за
 * прошлую дату удаляла кэш соседних снимков, и их пересборка начиналась с нуля.
 * Дневную погоду держим двое суток, сетку дождя — месяц (по времени файла).
 */
async function pruneCache() {
  const weatherMin = `weather-${shiftDate(localDate(), -2)}.json`;
  const rainMaxAgeMs = 30 * 86400_000;
  try {
    for (const f of await fs.readdir(CACHE_DIR)) {
      const full = path.join(CACHE_DIR, f);
      if (f.startsWith('weather-') && f < weatherMin) await fs.unlink(full);
      else if (f.startsWith('rain-')) {
        const st = await fs.stat(full);
        if (Date.now() - st.mtimeMs > rainMaxAgeMs) await fs.unlink(full);
      }
    }
  } catch {}
}

/** Часовые данные за один день — чтобы назвать час грозы и её осадки. */
export async function fetchHourly(lat, lon, date) {
  const url = `${API}?latitude=${snap(lat)}&longitude=${snap(lon)}&hourly=precipitation,weather_code&timezone=Europe%2FWarsaw&start_date=${date}&end_date=${date}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Open-Meteo hourly HTTP ${res.status}`);
  return (await res.json()).hourly;
}

/**
 * Измеренные данные для карточки: дождь в грозу, дождь после, температура, график.
 * Никаких прогнозов — только то, что даёт Open-Meteo.
 * @param {object} daily ответ Open-Meteo (daily)
 * @param {string} stormDate дата грозы, ГГГГ-ММ-ДД (местная)
 * @param {string} today
 */
export function analyse(daily, stormDate, today) {
  const days = daily.time;
  const s = days.indexOf(stormDate);
  const t0 = days.indexOf(today);
  if (s < 0 || t0 < 0) return null;

  const sum = (arr, from, to) => {
    let v = 0;
    for (let i = Math.max(0, from); i <= Math.min(arr.length - 1, to); i++) v += arr[i] ?? 0;
    return v;
  };

  const stormMm = daily.precipitation_sum[s] ?? 0;

  const chartFrom = Math.max(0, t0 - 29);
  const recentTemps = daily.temperature_2m_max.slice(Math.max(0, t0 - 6), t0 + 1).filter((v) => v != null);

  return {
    stormMm: Math.round(stormMm * 10) / 10,
    sinceStormMm: Math.round(sum(daily.precipitation_sum, s + 1, t0) * 10) / 10,
    daysSince: t0 - s,
    tempRange: recentTemps.length ? [Math.round(Math.min(...recentTemps)), Math.round(Math.max(...recentTemps))] : null,
    chart: {
      startDate: days[chartFrom],
      rain: daily.precipitation_sum.slice(chartFrom, t0 + 1).map((v) => Math.round((v ?? 0) * 10) / 10),
      temp: daily.temperature_2m_max.slice(chartFrom, t0 + 1).map((v) => Math.round(v ?? 0)),
      storm: daily.weather_code.slice(chartFrom, t0 + 1).map((c) => c >= 95 && c <= 99),
    },
  };
}

/** Короткий отпечаток области: кэш дождя, снятый для другого региона, не подойдёт. */
const bboxTag = (b) => [b.minLat, b.minLon, b.maxLat, b.maxLon].map((v) => v.toFixed(2)).join('_');

/**
 * Сетка осадков над лесом — контроль для проверки гипотезы: видно, где дождь
 * был такой же, но молний не было.
 *
 * Считаем не сумму за неделю, а **самый сильный дождь за окно и его день** —
 * чтобы сравнивать с грозой, которая тоже событие в конкретный момент.
 * Слабее RAIN_MIN_MM не сохраняем: карта такие капли всё равно не рисует.
 *
 * @returns {Promise<{stepDeg:number, minMm:number, from:string, to:string,
 *   cells:Array<[number,number,number,number,number,string]>}>}
 *   [lat, lon, мм в сильнейший день, суток назад от конца окна, мм за всё окно, дата дня]
 */
export async function fetchRainGrid(bbox, { stepDeg = RAIN_STEP_DEG, from, to, keep = () => true } = {}) {
  const points = [];
  for (let lat = bbox.minLat + stepDeg / 2; lat < bbox.maxLat; lat += stepDeg) {
    for (let lon = bbox.minLon + stepDeg / 2; lon < bbox.maxLon; lon += stepDeg) {
      const p = { lat: +lat.toFixed(3), lon: +lon.toFixed(3) };
      // Точки вне леса не запрашиваем вовсе: и трафик меньше, и лимит бережём.
      if (keep(p.lat, p.lon)) points.push(p);
    }
  }

  // Даты берём в том же поясе, в котором просим данные: около полуночи по Варшаве
  // UTC-дата уже другая, и последние сутки выпадали из окна целиком.
  const fromDate = localDate(from);
  const toDate = localDate(to);
  const today = localDate();

  // Ключ включает область: после `npm run region` кэш прежнего региона не подойдёт.
  const cacheFile = path.join(CACHE_DIR, `rain-${bboxTag(bbox)}-${fromDate}_${toDate}-${stepDeg}.json`);
  try {
    const st = await fs.stat(cacheFile);
    // Сутки, которые ещё идут, продолжают накапливать дождь — такой кэш быстро стареет.
    const fresh = toDate < today || Date.now() - st.mtimeMs < 3 * 3600_000;
    if (fresh) {
      const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (cached.minMm === RAIN_MIN_MM) return cached;
    }
  } catch {}

  const cells = [];
  const windowDays = daysBetween(fromDate, toDate) + 1;
  const deadline = Date.now() + 15 * 60_000;

  for (let i = 0; i < points.length; i += BATCH) {
    const chunk = points.slice(i, i + BATCH);
    const url =
      `${API}?latitude=${chunk.map((p) => p.lat).join(',')}` +
      `&longitude=${chunk.map((p) => p.lon).join(',')}` +
      `&daily=precipitation_sum&timezone=Europe%2FWarsaw&start_date=${fromDate}&end_date=${toDate}`;

    const data = await askOpenMeteo(url, { deadline });

    const list = Array.isArray(data) ? data : [data];
    chunk.forEach((p, j) => {
      const daily = list[j]?.daily?.precipitation_sum;
      if (!daily) return;
      const days = list[j].daily.time || [];
      let total = 0, maxMm = 0, maxIdx = -1;
      daily.forEach((v, k) => {
        const mm = v ?? 0;
        total += mm;
        if (mm > maxMm) { maxMm = mm; maxIdx = k; }
      });
      if (maxMm < RAIN_MIN_MM) return;
      const day = maxIdx >= 0 ? days[maxIdx] || toDate : toDate;
      cells.push([
        p.lat,
        p.lon,
        Math.round(maxMm * 10) / 10,
        Math.max(0, daysBetween(day, toDate)),
        Math.round(total * 10) / 10,
        day,
      ]);
    });

    if (i + BATCH < points.length) await sleep(paceMs(weightOf(chunk.length, windowDays, 1)));
  }

  const result = { stepDeg, minMm: RAIN_MIN_MM, from: fromDate, to: toDate, cells };
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(result));
  return result;
}
