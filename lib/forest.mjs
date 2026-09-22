// Леса, населённые пункты и охраняемые территории из векторных тайлов OpenFreeMap (данные OSM).
//
// Тайлы вместо Overpass: отвечают за сотни миллисекунд, не имеют лимитов и не падают под нагрузкой.
// Геометрия в тайле обрезана по его границе — для проверки «точка внутри леса» это не мешает.
import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeTile, featureProps, lonLatToTile, ringArea, tileToLonLat } from './mvt.mjs';

const CACHE_DIR = path.join(process.cwd(), 'data', 'tiles');

/** z11: тайл ~12×19 км, контур леса детализирован до нескольких метров. */
export const ZOOM = 11;

let tileTemplate = null;

async function template() {
  if (tileTemplate) return tileTemplate;
  const res = await fetch('https://tiles.openfreemap.org/planet', { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`OpenFreeMap TileJSON HTTP ${res.status}`);
  const json = await res.json();
  tileTemplate = json.tiles[0];
  return tileTemplate;
}

async function fetchTile(z, x, y) {
  const file = path.join(CACHE_DIR, `${z}-${x}-${y}.pbf`);
  try {
    return await fs.readFile(file);
  } catch {}

  const url = (await template()).replace('{z}', z).replace('{x}', x).replace('{y}', y);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return Buffer.alloc(0); // над морем тайла может не быть
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(CACHE_DIR, { recursive: true });
      // Через временный файл: оборванная запись оставила бы обрезанный тайл,
      // и он читался бы из кэша вечно — с неполными контурами лесов.
      await fs.writeFile(`${file}.tmp`, buf);
      await fs.rename(`${file}.tmp`, file);
      return buf;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw lastError;
}

function ringsToLonLat(layer, feature, z, x, y) {
  const out = [];
  for (const ring of feature.geometry) {
    // По спецификации MVT v2 внешнее кольцо имеет положительную площадь, дырки — отрицательную.
    if (ring.length < 4 || ringArea(ring) <= 0) continue;
    out.push(ring.map(([px, py]) => tileToLonLat(z, x, y, layer.extent, px, py)));
  }
  return out;
}

function bboxOf(ring) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lon, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

const parsed = new Map();

/**
 * Содержимое одного тайла: леса, населённые пункты, охраняемые территории.
 * @returns {Promise<{forests:Array, places:Array, parks:Array}>}
 */
export async function tileData(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (parsed.has(key)) return parsed.get(key);

  const buf = await fetchTile(z, x, y);
  const result = { forests: [], places: [], parks: [] };

  if (buf.length) {
    const layers = decodeTile(buf);

    const landcover = layers.get('landcover');
    if (landcover) {
      let n = 0;
      for (const f of landcover.features) {
        if (featureProps(landcover, f).class !== 'wood') continue;
        for (const ring of ringsToLonLat(landcover, f, z, x, y)) {
          result.forests.push({ id: `${key}:f${n++}`, ring, ...bboxOf(ring) });
        }
      }
    }

    const place = layers.get('place');
    if (place) {
      const rank = { city: 0, town: 1, village: 2, hamlet: 3 };
      for (const f of place.features) {
        const p = featureProps(place, f);
        if (!p.name || !(p.class in rank) || !f.geometry[0]?.[0]) continue;
        const [lon, lat] = tileToLonLat(z, x, y, place.extent, f.geometry[0][0][0], f.geometry[0][0][1]);
        result.places.push({ name: p.name, lat, lon, rank: rank[p.class] });
      }
    }

    const park = layers.get('park');
    if (park) {
      let n = 0;
      for (const f of park.features) {
        const p = featureProps(park, f);
        if (!p.name) continue;
        for (const ring of ringsToLonLat(park, f, z, x, y)) {
          result.parks.push({ id: `${key}:p${n++}`, name: p.name, klass: p.class || null, ring, ...bboxOf(ring) });
        }
      }
    }
  }

  parsed.set(key, result);
  return result;
}

/**
 * Данные по всем тайлам, покрывающим точки.
 * Геометрия в тайле обрезана по его границе, поэтому у самого края берём и соседний тайл —
 * но только там, где это действительно нужно, иначе тайлов становится втрое больше.
 */
export async function loadAround(points, log = () => {}, { padKm = 2, concurrency = 8 } = {}) {
  const tiles = new Set();
  for (const p of points) {
    const dLat = padKm / 110.574;
    const dLon = padKm / (111.32 * Math.cos((p.lat * Math.PI) / 180));
    for (const [la, lo] of [[0, 0], [dLat, dLon], [dLat, -dLon], [-dLat, dLon], [-dLat, -dLon]]) {
      const t = lonLatToTile(ZOOM, p.lon + lo, p.lat + la);
      tiles.add(`${t.x}|${t.y}`);
    }
  }

  const forests = [], places = [], parks = [];
  let failed = 0;
  const queue = [...tiles];

  const worker = async () => {
    while (queue.length) {
      const [x, y] = queue.shift().split('|').map(Number);
      try {
        const d = await tileData(ZOOM, x, y);
        forests.push(...d.forests);
        places.push(...d.places);
        parks.push(...d.parks);
      } catch (e) {
        failed++;
        log(`тайл ${ZOOM}/${x}/${y}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, worker));

  log(`тайлов: ${tiles.size} (ошибок ${failed}) · лесных контуров ${forests.length} · пунктов ${places.length} · охраняемых территорий ${parks.length}`);
  return { forests, places, parks };
}
