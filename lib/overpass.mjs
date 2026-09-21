// Леса и населённые пункты из OSM через Overpass API. Ответы кэшируются на диске.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const CACHE_DIR = path.join(process.cwd(), 'data', 'cache');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cached(key, produce) {
  const file = path.join(CACHE_DIR, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {}
  const value = await produce();
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
  return value;
}

/** Запрос к Overpass с переходом на запасные зеркала и паузами при троттлинге. */
async function query(ql, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          // Заголовки только ASCII: кириллица в user-agent роняет fetch.
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'borowiki/1.0 (personal hobby project)' },
          body: new URLSearchParams({ data: ql }),
          signal: AbortSignal.timeout(180_000),
        });
        if (res.status === 429 || res.status === 504) throw new Error(`перегружен: HTTP ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        lastError = e;
      }
    }
    await sleep((attempt + 1) * 5000);
  }
  throw lastError;
}

/** Замкнутые контуры [[lon, lat], ...] из ответа Overpass (way и внешние кольца relation). */
function toPolygons(elements) {
  const polys = [];
  for (const el of elements) {
    const name = el.tags?.name || null;
    if (el.type === 'way' && el.geometry?.length >= 4) {
      polys.push({ id: `w${el.id}`, name, ring: el.geometry.map((g) => [g.lon, g.lat]) });
    } else if (el.type === 'relation' && el.members) {
      // Внешние отрезки мультиполигона сшиваем в кольца по совпадающим концам.
      const segs = el.members.filter((m) => m.role === 'outer' && m.geometry?.length >= 2).map((m) => m.geometry.map((g) => [g.lon, g.lat]));
      const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
      while (segs.length) {
        let ring = segs.shift();
        let extended = true;
        while (extended && key(ring[0]) !== key(ring[ring.length - 1])) {
          extended = false;
          for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            if (key(s[0]) === key(ring[ring.length - 1])) { ring = ring.concat(s.slice(1)); segs.splice(i, 1); extended = true; break; }
            if (key(s[s.length - 1]) === key(ring[ring.length - 1])) { ring = ring.concat(s.slice().reverse().slice(1)); segs.splice(i, 1); extended = true; break; }
          }
        }
        if (ring.length >= 4) polys.push({ id: `r${el.id}`, name, ring });
      }
    }
  }
  return polys;
}

/** Лесные полигоны в прямоугольнике (с небольшим запасом по краям). */
export async function forestsInBbox({ minLat, minLon, maxLat, maxLon }, padDeg = 0.05) {
  const b = [
    (minLat - padDeg).toFixed(3), (minLon - padDeg).toFixed(3),
    (maxLat + padDeg).toFixed(3), (maxLon + padDeg).toFixed(3),
  ].join(',');

  const ql = `[out:json][timeout:180];
(
  way["landuse"="forest"](${b});
  way["natural"="wood"](${b});
  relation["landuse"="forest"](${b});
  relation["natural"="wood"](${b});
);
out geom qt;`;

  const data = await cached(`forest:${b}`, () => query(ql));
  return toPolygons(data.elements || []);
}

/** Именованные лесные массивы поблизости: name на большом полигоне или на охраняемой территории. */
export async function namedForestAreas({ minLat, minLon, maxLat, maxLon }, padDeg = 0.25) {
  const b = [
    (minLat - padDeg).toFixed(3), (minLon - padDeg).toFixed(3),
    (maxLat + padDeg).toFixed(3), (maxLon + padDeg).toFixed(3),
  ].join(',');

  const ql = `[out:json][timeout:180];
(
  relation["boundary"="protected_area"]["name"](${b});
  relation["leisure"="nature_reserve"]["name"](${b});
  way["leisure"="nature_reserve"]["name"](${b});
  relation["landuse"="forest"]["name"](${b});
  way["landuse"="forest"]["name"](${b});
  relation["natural"="wood"]["name"](${b});
  way["natural"="wood"]["name"](${b});
);
out geom qt;`;

  const data = await cached(`named:${b}`, () => query(ql));
  return toPolygons(data.elements || []).filter((p) => p.name);
}

/** Населённые пункты в прямоугольнике — для подписи «у <деревни>». */
export async function placesInBbox({ minLat, minLon, maxLat, maxLon }, padDeg = 0.2) {
  const b = [
    (minLat - padDeg).toFixed(3), (minLon - padDeg).toFixed(3),
    (maxLat + padDeg).toFixed(3), (maxLon + padDeg).toFixed(3),
  ].join(',');

  const ql = `[out:json][timeout:120];
node["place"~"^(city|town|village|hamlet)$"]["name"](${b});
out body qt;`;

  const data = await cached(`places:${b}`, () => query(ql));
  const rank = { city: 0, town: 1, village: 2, hamlet: 3 };
  return (data.elements || [])
    .filter((e) => e.tags?.name)
    .map((e) => ({ name: e.tags.name, lat: e.lat, lon: e.lon, rank: rank[e.tags.place] ?? 4 }));
}
