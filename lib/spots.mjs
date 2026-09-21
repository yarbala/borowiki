// Проходы гроз + леса OSM → «пятна»: часть леса, над которой прошла гроза.
import { CLUSTER, GRID_DEG, SPOT } from './config.mjs';
import { connectedComponents, groupByTime } from './storms.mjs';
import { loadAround } from './forest.mjs';
import { centroidAndRadius, distanceToRingKm, haversineKm, pointInRing, simplifyRing } from './geo.mjs';

/** Пятна крупнее этого режем на части, чтобы каждое оставалось конкретным местом. */
const CHUNK_DEG = 0.08;

/** Площадь одной ячейки сетки на данной широте, км². */
const cellAreaKm2 = (lat) => GRID_DEG * 110.574 * GRID_DEG * 111.32 * Math.cos((lat * Math.PI) / 180);

/** Площадь кольца [lon, lat] в км². */
function ringAreaKm2(ring) {
  const kx = 111.32 * Math.cos((ring[0][1] * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * kx) * (ring[i][1] * 110.574) - (ring[i][0] * kx) * (ring[j][1] * 110.574);
  }
  return Math.abs(a / 2);
}

/** Сбор под грибы запрещён в национальных парках и резерватах. */
const isStrictlyProtected = (klass) => /national_park|nature_reserve/i.test(klass || '');

export async function buildSpots(passes, log = () => {}) {
  if (!passes.length) return [];

  const { forests, places, parks } = await loadAround(passes, log);
  if (!forests.length) {
    log('лесных контуров не получено — пятна построить не из чего');
    return [];
  }

  const slackDeg = SPOT.forestSlackM / 111_320;
  const slackKm = SPOT.forestSlackM / 1000;

  /** Лес под точкой: сначала строго внутри, потом ближайший в пределах допуска. */
  function forestAt(lon, lat) {
    let near = null, nearDist = Infinity;
    for (const f of forests) {
      if (lat < f.minLat - slackDeg || lat > f.maxLat + slackDeg || lon < f.minLon - slackDeg || lon > f.maxLon + slackDeg) continue;
      if (pointInRing(lon, lat, f.ring)) return f;
      const d = distanceToRingKm(lon, lat, f.ring);
      if (d < nearDist) { nearDist = d; near = f; }
    }
    return nearDist <= slackKm ? near : null;
  }

  function parkAt(lon, lat) {
    for (const p of parks) {
      if (lat < p.minLat || lat > p.maxLat || lon < p.minLon || lon > p.maxLon) continue;
      if (pointInRing(lon, lat, p.ring)) return p;
    }
    return null;
  }

  function nearestPlace(lat, lon) {
    let best = null, bestScore = Infinity;
    for (const p of places) {
      const d = haversineKm(lat, lon, p.lat, p.lon);
      // Небольшой бонус крупным пунктам: деревня в двух километрах понятнее хутора в одном.
      const score = d + p.rank * 0.8;
      if (score < bestScore) { bestScore = score; best = { ...p, dist: d }; }
    }
    return best && best.dist <= 25 ? best : null;
  }

  const spots = [];
  let idSeq = 0;

  groupByTime(passes).forEach((storm, si) => {
    // Ячейки этой грозы, попавшие в лес, разложенные по лесным контурам.
    const byForest = new Map();
    for (const cell of storm.items) {
      const forest = forestAt(cell.lon, cell.lat);
      if (!forest) continue;
      if (!byForest.has(forest.id)) byForest.set(forest.id, { forest, cells: [] });
      byForest.get(forest.id).cells.push(cell);
    }

    for (const { forest, cells } of byForest.values()) {
      for (const group of connectedComponents(cells)) {
        if (group.length < CLUSTER.minCells) continue;

        const chunks = new Map();
        for (const c of group) {
          const k = `${Math.floor(c.lat / CHUNK_DEG)}|${Math.floor(c.lon / CHUNK_DEG)}`;
          if (!chunks.has(k)) chunks.set(k, []);
          chunks.get(k).push(c);
        }

        for (const chunk of chunks.values()) {
          if (chunk.length < CLUSTER.minCells) continue;

          const { lat, lon, radiusM } = centroidAndRadius(chunk.map((c) => [c.lat, c.lon]));
          const place = nearestPlace(lat, lon);
          const park = parkAt(lon, lat);
          const forestArea = ringAreaKm2(forest.ring);

          spots.push({
            id: `s${++idSeq}`,
            stormIndex: si,
            forest: park && !isStrictlyProtected(park.klass) ? park.name : place ? `Лес у ${place.name}` : 'Лес',
            place: place?.name || null,
            placeDistKm: place ? Math.round(place.dist * 10) / 10 : null,
            protectedArea: park ? { name: park.name, strict: isStrictlyProtected(park.klass) } : null,
            lat: +lat.toFixed(4),
            lon: +lon.toFixed(4),
            radiusM: Math.max(SPOT.minRadiusM, Math.min(SPOT.maxRadiusM, radiusM + 1100)),
            cells: chunk.length,
            areaKm2: Math.round(chunk.length * cellAreaKm2(lat) * 10) / 10,
            acc: chunk.reduce((s, c) => s + c.acc, 0),
            peak: Math.max(...chunk.map((c) => c.peak)),
            startMs: Math.min(...chunk.map((c) => c.startMs)),
            endMs: Math.max(...chunk.map((c) => c.endMs)),
            outline: outlineFor(forest, forestArea),
          });
        }
      }
    }
  });

  return spots.sort((a, b) => b.acc - a.acc);
}

/** Контур леса для карты: только если он не слишком тяжёлый. */
function outlineFor(forest, areaKm2) {
  if (areaKm2 > 600) return null;
  const ring = simplifyRing(forest.ring, 0.0008);
  return ring.length <= 400 ? ring.map(([lon, lat]) => [+lon.toFixed(5), +lat.toFixed(5)]) : null;
}
