// Геометрия: расстояния, попадание точки в полигон, упрощение контура.

export function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Градусы на километр по широте и долготе на данной широте. */
export function degPerKm(lat) {
  return { lat: 1 / 110.574, lon: 1 / (111.32 * Math.cos((lat * Math.PI) / 180)) };
}

/** Луч вправо; ring — массив [lon, lat]. */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Квадрат расстояния от точки до отрезка в градусах, с поправкой на сжатие долготы. */
function distToSegmentDeg(px, py, ax, ay, bx, by, kx) {
  const dx = (bx - ax) * kx, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? (((px - ax) * kx * dx + (py - ay) * dy) / len2) : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = (ax + (bx - ax) * t - px) * kx, cy = ay + (by - ay) * t - py;
  return cx * cx + cy * cy;
}

/** Расстояние от точки до контура (0, если точка внутри), км. */
export function distanceToRingKm(lon, lat, ring) {
  if (pointInRing(lon, lat, ring)) return 0;
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = distToSegmentDeg(lon, lat, ring[j][0], ring[j][1], ring[i][0], ring[i][1], kx);
    if (d < best) best = d;
  }
  return Math.sqrt(best) * 110.574;
}

/** Упрощение Рамера — Дугласа — Пекера; tolerance в градусах. */
export function simplifyRing(ring, tolerance) {
  if (ring.length < 4) return ring;
  const kx = Math.cos((ring[0][1] * Math.PI) / 180);
  const tol2 = tolerance * tolerance;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distToSegmentDeg(
        ring[i][0], ring[i][1],
        ring[first][0], ring[first][1],
        ring[last][0], ring[last][1],
        kx,
      );
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  return ring.filter((_, i) => keep[i]);
}

/** Центр и радиус (м), покрывающий все точки [lat, lon]. */
export function centroidAndRadius(points) {
  let sLat = 0, sLon = 0;
  for (const p of points) { sLat += p[0]; sLon += p[1]; }
  const lat = sLat / points.length, lon = sLon / points.length;
  let maxKm = 0;
  for (const p of points) {
    const d = haversineKm(lat, lon, p[0], p[1]);
    if (d > maxKm) maxKm = d;
  }
  return { lat, lon, radiusM: Math.round(maxKm * 1000) };
}

/** Площадь кольца [lon, lat] в км². */
export function ringAreaKm2(ring) {
  const kx = 111.32 * Math.cos((ring[0][1] * Math.PI) / 180);
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * kx) * (ring[i][1] * 110.574) - (ring[i][0] * kx) * (ring[j][1] * 110.574);
  }
  return Math.abs(a / 2);
}
