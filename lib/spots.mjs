// Проходы гроз + леса OSM → «пятна»: часть леса, над которой прошла гроза.
import { CLUSTER, GRID_DEG, SPOT } from './config.mjs';
import { connectedComponents, groupByTime } from './storms.mjs';
import { loadAround } from './forest.mjs';
import { centroidAndRadius, distanceToRingKm, haversineKm, pointInRing, simplifyRing } from './geo.mjs';

/** Пятна крупнее этого режем на части, чтобы каждое оставалось конкретным местом (~5 км). */
const CHUNK_DEG = 0.05;

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

  const forestIndex = buildIndex(forests, slackDeg);
  const parkIndex = buildIndex(parks, 0);
  const placeIndex = buildPointIndex(places);

  /** Лес под точкой: сначала строго внутри, потом ближайший в пределах допуска. */
  function forestAt(lon, lat) {
    let near = null, nearDist = Infinity;
    for (const f of forestIndex(lon, lat)) {
      if (lat < f.minLat - slackDeg || lat > f.maxLat + slackDeg || lon < f.minLon - slackDeg || lon > f.maxLon + slackDeg) continue;
      if (pointInRing(lon, lat, f.ring)) return f;
      const d = distanceToRingKm(lon, lat, f.ring);
      if (d < nearDist) { nearDist = d; near = f; }
    }
    return nearDist <= slackKm ? near : null;
  }

  function parkAt(lon, lat) {
    for (const p of parkIndex(lon, lat)) {
      if (lat < p.minLat || lat > p.maxLat || lon < p.minLon || lon > p.maxLon) continue;
      if (pointInRing(lon, lat, p.ring)) return p;
    }
    return null;
  }

  function nearestPlace(lat, lon) {
    let best = null, bestScore = Infinity;
    for (const p of placeIndex(lon, lat)) {
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
    // Ячейки этой грозы, попавшие в лес. Привязка к конкретному полигону здесь не нужна:
    // один и тот же лес приходит из нескольких тайлов разрезанным, и группировка по
    // полигонам породила бы дубликаты соседних пятен.
    const inForest = [];
    for (const cell of storm.items) {
      const forest = forestAt(cell.lon, cell.lat);
      if (forest) inForest.push({ ...cell, forest });
    }

    for (const group of connectedComponents(inForest)) {
      if (group.length < CLUSTER.minCells) continue;

      // Крупный след режем на части, чтобы пятно оставалось конкретным местом.
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
        // Контур берём у леса под центром пятна — он и подписан на карте.
        const forest = forestAt(lon, lat) || chunk[0].forest;

        spots.push({
          id: `s${++idSeq}`,
          stormIndex: si,
          forest: park && !isStrictlyProtected(park.klass) ? park.name : place ? `Лес у ${place.name}` : 'Лес',
          place: place?.name || null,
          placeDistKm: place ? Math.round(place.dist * 10) / 10 : null,
          protectedArea: park ? { name: park.name, strict: isStrictlyProtected(park.klass) } : null,
          lat: +lat.toFixed(4),
          lon: +lon.toFixed(4),
          radiusM: Math.max(SPOT.minRadiusM, Math.min(SPOT.maxRadiusM, Math.round(radiusM + 900))),
          cells: chunk.length,
          areaKm2: Math.round(chunk.length * cellAreaKm2(lat) * 10) / 10,
          acc: chunk.reduce((s, c) => s + c.acc, 0),
          peak: Math.max(...chunk.map((c) => c.peak)),
          startMs: Math.min(...chunk.map((c) => c.startMs)),
          endMs: Math.max(...chunk.map((c) => c.endMs)),
          outline: outlineFor(forest, ringAreaKm2(forest.ring)),
        });
      }
    }
  });

  return spots.sort((a, b) => b.acc - a.acc);
}

/** Шаг ячейки пространственного индекса, градусы. */
const INDEX_DEG = 0.05;
const cellKey = (lon, lat) => `${Math.floor(lat / INDEX_DEG)}|${Math.floor(lon / INDEX_DEG)}`;

/** Индекс полигонов по ячейкам: без него перебор тысяч контуров на тысячи точек не укладывается в время. */
function buildIndex(polys, slackDeg) {
  const buckets = new Map();
  for (const p of polys) {
    const y0 = Math.floor((p.minLat - slackDeg) / INDEX_DEG), y1 = Math.floor((p.maxLat + slackDeg) / INDEX_DEG);
    const x0 = Math.floor((p.minLon - slackDeg) / INDEX_DEG), x1 = Math.floor((p.maxLon + slackDeg) / INDEX_DEG);
    // Очень большой контур попал бы в сотни ячеек — такие держим в общем списке.
    if ((y1 - y0 + 1) * (x1 - x0 + 1) > 400) {
      if (!buckets.has('*')) buckets.set('*', []);
      buckets.get('*').push(p);
      continue;
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = `${y}|${x}`;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(p);
      }
    }
  }
  const big = buckets.get('*') || [];
  return (lon, lat) => (buckets.get(cellKey(lon, lat)) || []).concat(big);
}

/** То же для точек: смотрим свою ячейку и соседние, чтобы не потерять пункт за границей. */
function buildPointIndex(points) {
  const buckets = new Map();
  for (const p of points) {
    const k = cellKey(p.lon, p.lat);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }
  return (lon, lat) => {
    const y = Math.floor(lat / INDEX_DEG), x = Math.floor(lon / INDEX_DEG);
    const out = [];
    // Радиус в 5 ячеек ≈ 25 км — столько же, сколько допуск в nearestPlace.
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const b = buckets.get(`${y + dy}|${x + dx}`);
        if (b) out.push(...b);
      }
    }
    return out;
  };
}

/** Контур леса для карты: только если он не слишком тяжёлый. */
function outlineFor(forest, areaKm2) {
  if (areaKm2 > 600) return null;
  const ring = simplifyRing(forest.ring, 0.0008);
  return ring.length <= 400 ? ring.map(([lon, lat]) => [+lon.toFixed(5), +lat.toFixed(5)]) : null;
}
