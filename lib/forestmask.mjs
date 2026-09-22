// Быстрая проверка «точка в лесу» по готовому слою public/data/forests.json.
//
// Слой собирается один раз (`npm run forests`) и покрывает весь регион,
// поэтому дождь можно считать только там, где есть лес.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pointInRing } from './geo.mjs';
import { REGION_DATA_DIR } from './config.mjs';

const FILE = path.join(REGION_DATA_DIR, 'forests.json');

/** Шаг ячейки индекса, градусы. */
const CELL = 0.05;

/**
 * @param {string} [file] слой лесов другой области: сервер после переключения
 *   должен читать её файл, а не тот, что был активен при его запуске.
 * @returns {Promise<(lat:number, lon:number)=>boolean>} проверка точки, либо null,
 *   если слой лесов ещё не собран.
 */
export async function loadForestMask(file = FILE) {
  let rings;
  try {
    const gj = JSON.parse(await fs.readFile(file, 'utf8'));
    rings = gj.features.flatMap((f) =>
      f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.map((p) => p[0]) : [f.geometry.coordinates[0]],
    );
  } catch {
    return null;
  }

  const buckets = new Map();
  for (const ring of rings) {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const [lon, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    const y0 = Math.floor(minLat / CELL), y1 = Math.floor(maxLat / CELL);
    const x0 = Math.floor(minLon / CELL), x1 = Math.floor(maxLon / CELL);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = `${y}|${x}`;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(ring);
      }
    }
  }

  return (lat, lon) => {
    const near = buckets.get(`${Math.floor(lat / CELL)}|${Math.floor(lon / CELL)}`);
    if (!near) return false;
    for (const ring of near) if (pointInRing(lon, lat, ring)) return true;
    return false;
  };
}
