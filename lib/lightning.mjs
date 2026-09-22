// Загрузка кадров молний из публичного WMS EUMETSAT (MTG Lightning Imager) с кэшем на диске.
import fs from 'node:fs/promises';
import path from 'node:path';
import { decodePng } from './png.mjs';
import { BBOX, FRAMES_DIR, GRID, WMS } from './config.mjs';

/** Шкала YlOrRd, которой GeoServer раскрашивает слой: от слабых вспышек к сильным. */
const RAMP = [
  [255, 255, 178], [254, 217, 118], [254, 178, 76],
  [253, 141, 60], [252, 78, 42], [227, 26, 28], [177, 0, 38],
];

/** Полупрозрачные пиксели — сглаживание на краях ячеек, а не сами вспышки. */
const ALPHA_MIN = 128;

/** Сколько запусков подряд пытаться загрузить один и тот же кадр, прежде чем считать его пробелом. */
const MAX_ATTEMPTS = 2;

/** Цвет пикселя → интенсивность 0..1 по положению на шкале. */
export function colorToIntensity(r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < RAMP.length; i++) {
    const [rr, gg, bb] = RAMP[i];
    const d = (r - rr) ** 2 + (g - gg) ** 2 + (b - bb) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best / (RAMP.length - 1);
}

export function pixelToLonLat(x, y) {
  return {
    lon: BBOX.minLon + ((x + 0.5) / GRID.width) * (BBOX.maxLon - BBOX.minLon),
    lat: BBOX.maxLat - ((y + 0.5) / GRID.height) * (BBOX.maxLat - BBOX.minLat),
  };
}

export function frameUrl(timeIso) {
  const p = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1',
    request: 'GetMap',
    layers: WMS.layer,
    styles: '',
    srs: 'EPSG:4326',
    bbox: `${BBOX.minLon},${BBOX.minLat},${BBOX.maxLon},${BBOX.maxLat}`,
    width: String(GRID.width),
    height: String(GRID.height),
    format: 'image/png',
    transparent: 'true',
    time: timeIso,
  });
  return `${WMS.base}?${p}`;
}

/** Метки времени кадров (шаг 5 мин, выровнены по часам) в интервале [from, to]. */
export function frameTimes(from, to) {
  const stepMs = WMS.stepMinutes * 60_000;
  const start = Math.ceil(from.getTime() / stepMs) * stepMs;
  const out = [];
  for (let t = start; t <= to.getTime(); t += stepMs) out.push(new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  return out;
}

const dayOf = (iso) => iso.slice(0, 10);
const hhmmOf = (iso) => iso.slice(11, 13) + iso.slice(14, 16);

async function readDay(day) {
  try {
    return JSON.parse(await fs.readFile(path.join(FRAMES_DIR, `${day}.json`), 'utf8'));
  } catch {
    return {};
  }
}

async function writeDay(day, data) {
  await fs.mkdir(FRAMES_DIR, { recursive: true });
  // Через временный файл: прерванная сборка (в том числе отменённая из браузера)
  // иначе оставила бы обрезанный JSON, и день кадров пришлось бы качать заново.
  const file = path.join(FRAMES_DIR, `${day}.json`);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(data));
  await fs.rename(`${file}.tmp`, file);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Один кадр → массив [x, y, intensity0_100] только по «горящим» пикселям. */
export async function fetchFrame(timeIso, { attempts = 3, timeoutMs = 45_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(frameUrl(timeIso), { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('пустой ответ');
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('png')) throw new Error(`не изображение: ${ct} ${buf.toString('utf8', 0, 200)}`);

      const { width, height, data } = decodePng(buf);
      const lit = [];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i + 3] < ALPHA_MIN) continue;
          const intensity = colorToIntensity(data[i], data[i + 1], data[i + 2]);
          // Самая бледная ступень — широкий ореол вокруг грозы. В расчёте силы он весит ноль,
          // поэтому не храним его вовсе: кэш кадров меньше втрое.
          if (intensity <= 0) continue;
          lit.push([x, y, Math.round(intensity * 100)]);
        }
      }
      return lit;
    } catch (e) {
      lastError = e;
      if (attempt < attempts) await sleep(attempt * 1500);
    }
  }
  throw lastError;
}

/**
 * Кадры за интервал: недостающие докачиваются, уже загруженные берутся из кэша.
 * @returns {Promise<{frames: Array<{time:string, lit:number[][]}>, fetched:number, cached:number, failed:string[]}>}
 */
export async function loadFrames(from, to, { concurrency = 6, onProgress } = {}) {
  const times = frameTimes(from, to);
  const byDay = new Map();
  for (const t of times) {
    const d = dayOf(t);
    if (!byDay.has(d)) byDay.set(d, await readDay(d));
  }

  // В кэше массив — успешно загруженный кадр, число — сколько раз попытка сорвалась.
  // В данных сервиса попадаются постоянные пробелы (стабильный 502 на конкретные метки времени),
  // и без этого счётчика каждый запуск снова бился бы в одни и те же кадры.
  const attemptsOf = (t) => {
    const v = byDay.get(dayOf(t))[hhmmOf(t)];
    return typeof v === 'number' ? v : v === undefined ? 0 : -1;
  };

  const missing = times.filter((t) => {
    const a = attemptsOf(t);
    return a >= 0 && a < MAX_ATTEMPTS;
  });
  const skipped = times.filter((t) => attemptsOf(t) >= MAX_ATTEMPTS).length;

  const failed = [];
  let done = 0;

  const queue = missing.slice();
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      const day = byDay.get(dayOf(t));
      try {
        day[hhmmOf(t)] = await fetchFrame(t);
      } catch (e) {
        day[hhmmOf(t)] = attemptsOf(t) + 1;
        failed.push(`${t}: ${e.message}`);
      }
      done++;
      if (onProgress && done % 25 === 0) onProgress(done, missing.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, worker));

  for (const [day, data] of byDay) await writeDay(day, data);

  const all = times.map((t) => ({ time: t, lit: byDay.get(dayOf(t))[hhmmOf(t)] }));

  return {
    frames: all.filter((f) => Array.isArray(f.lit) && f.lit.length > 0),
    /** Самый свежий успешно загруженный кадр — по нему видно, насколько данные актуальны. */
    latest: all.filter((f) => Array.isArray(f.lit)).map((f) => f.time).pop() || null,
    fetched: missing.length - failed.length,
    cached: times.length - missing.length - skipped,
    failed,
    skipped,
  };
}

/** Удаляет кэш кадров за дни старше указанной даты. */
export async function pruneFrames(before) {
  const cutoff = before.toISOString().slice(0, 10);
  let removed = 0;
  try {
    for (const f of await fs.readdir(FRAMES_DIR)) {
      if (f.endsWith('.json') && f.slice(0, 10) < cutoff) {
        await fs.unlink(path.join(FRAMES_DIR, f));
        removed++;
      }
    }
  } catch {}
  return removed;
}
