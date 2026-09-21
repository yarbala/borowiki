// Погода из Open-Meteo (без ключа): сколько дождя дала гроза и что было после.
//
// Лимит бесплатного тарифа считается «взвешенно»: одна пачка из 100 точек
// на 6 переменных за 39 дней стоит примерно 167 вызовов из 600 в минуту.
// Поэтому точки округляются до шага сетки модели (0,02°), дублируются один раз
// и результат кэшируется на сутки.
import fs from 'node:fs/promises';
import path from 'node:path';

const CACHE_DIR = path.join(process.cwd(), 'data', 'cache');
const API = 'https://api.open-meteo.com/v1/forecast';
const DAILY = 'precipitation_sum,temperature_2m_max,temperature_2m_min,weather_code,et0_fao_evapotranspiration,soil_moisture_0_to_7cm_mean';

/** Столько точек в одной пачке: URL остаётся заметно короче предела в ~8 КБ. */
const BATCH = 100;
export const PAST_DAYS = 31;
export const FORECAST_DAYS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const snap = (v) => +(Math.round(v / 0.02) * 0.02).toFixed(2);

/**
 * Погода для набора точек. Ключ кэша — округлённые координаты и дата.
 * @param {Array<{lat:number, lon:number}>} points
 * @returns {Promise<Map<string, object>>} ключ `lat,lon` округлённых координат → daily
 */
export async function fetchDaily(points, { today = new Date().toISOString().slice(0, 10) } = {}) {
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

  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    // Запятые не кодируем: URLSearchParams превратил бы их в %2C и утроил длину.
    const url =
      `${API}?latitude=${chunk.map((p) => p.lat).join(',')}` +
      `&longitude=${chunk.map((p) => p.lon).join(',')}` +
      `&daily=${DAILY}&timezone=Europe%2FWarsaw&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}`;

    let data;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 429) {
        await sleep(61_000);
        continue;
      }
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      data = await res.json();
      break;
    }
    if (!data) throw new Error('Open-Meteo не ответил после повторов');

    // Ответ — массив в порядке запроса; связь с точкой только по индексу.
    const list = Array.isArray(data) ? data : [data];
    chunk.forEach((p, j) => {
      if (list[j]?.daily) cache[`${p.lat},${p.lon}`] = list[j].daily;
    });

    if (i + BATCH < missing.length) await sleep(1500);
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(cache));
  await pruneCache(today);

  const out = new Map();
  for (const k of keyed.keys()) if (cache[k]) out.set(k, cache[k]);
  return out;
}

/** Погода за прошлые дни больше не нужна: держим только последние двое суток. */
async function pruneCache(today) {
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 2);
  const min = `weather-${cutoff.toISOString().slice(0, 10)}.json`;
  try {
    for (const f of await fs.readdir(CACHE_DIR)) {
      if (f.startsWith('weather-') && f < min) await fs.unlink(path.join(CACHE_DIR, f));
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

;

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
