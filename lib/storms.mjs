// Кадры молний → проходы гроз: над какой ячейкой сетки, когда и с какой силой.
//
// Единица — не «гроза целиком» (фронт может идти над регионом восемь часов),
// а проход грозы над конкретной ячейкой сетки. Именно это спрашивает пользователь:
// где именно была гроза и в какое время.
import { CLUSTER, GRID } from './config.mjs';
import { pixelToLonLat } from './lightning.mjs';

/** Шкала кадра 0..100 → ступень палитры 0..6. */
const step = (intensity) => Math.round((intensity / 100) * 6);

/**
 * @param {Array<{time:string, lit:number[][]}>} frames кадры за окно наблюдения
 * @returns {Array<{x:number,y:number,lon:number,lat:number,startMs:number,endMs:number,acc:number,peak:number}>}
 */
export function buildPasses(frames) {
  const sorted = frames.slice().sort((a, b) => a.time.localeCompare(b.time));
  const gapMs = CLUSTER.gapMinutes * 60_000;

  // Для каждой ячейки — её собственная история вспышек.
  const open = new Map(); // key → текущий незакрытый проход
  const done = [];

  for (const f of sorted) {
    const ms = Date.parse(f.time);
    for (const [x, y, i] of f.lit) {
      const w = step(i);
      const key = y * GRID.width + x;
      let p = open.get(key);
      if (p && ms - p.endMs > gapMs) {
        done.push(p);
        p = null;
      }
      if (!p) {
        p = { x, y, startMs: ms, endMs: ms, acc: 0, peak: 0 };
        open.set(key, p);
      }
      p.acc += w;
      if (w > p.peak) p.peak = w;
      // Время прохода считаем по кадрам с заметной вспышкой, а не по слабому ореолу.
      if (w > 0) {
        if (!p.strongStartMs) p.strongStartMs = ms;
        p.strongEndMs = ms;
      }
      p.endMs = ms;
    }
  }
  done.push(...open.values());

  return done
    .filter((p) => p.acc >= CLUSTER.minAccum && p.peak >= CLUSTER.minPeak)
    .map((p) => {
      const { lon, lat } = pixelToLonLat(p.x, p.y);
      return {
        x: p.x, y: p.y, lon, lat,
        startMs: p.strongStartMs ?? p.startMs,
        endMs: p.strongEndMs ?? p.endMs,
        acc: p.acc,
        peak: p.peak,
      };
    });
}

/**
 * Связные области среди ячеек (сосед в пределах linkCells) — внутри одного набора.
 * @returns {Array<Array>} группы ячеек
 */
export function connectedComponents(cells) {
  const byKey = new Map(cells.map((c) => [c.y * GRID.width + c.x, c]));
  const seen = new Set();
  const out = [];
  const r = CLUSTER.linkCells;

  for (const start of cells) {
    const startKey = start.y * GRID.width + start.x;
    if (seen.has(startKey)) continue;
    const group = [];
    const stack = [start];
    seen.add(startKey);

    while (stack.length) {
      const c = stack.pop();
      group.push(c);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (!dx && !dy) continue;
          const key = (c.y + dy) * GRID.width + (c.x + dx);
          if (seen.has(key) || !byKey.has(key)) continue;
          seen.add(key);
          stack.push(byKey.get(key));
        }
      }
    }
    out.push(group);
  }
  return out;
}

/** Проходы, пересекающиеся по времени с запасом gapMinutes, считаются одной грозой. */
export function groupByTime(passes) {
  const gapMs = CLUSTER.gapMinutes * 60_000;
  const sorted = passes.slice().sort((a, b) => a.startMs - b.startMs);
  const groups = [];
  let cur = null;

  for (const p of sorted) {
    if (!cur || p.startMs - cur.endMs > gapMs) {
      cur = { startMs: p.startMs, endMs: p.endMs, items: [] };
      groups.push(cur);
    }
    cur.items.push(p);
    if (p.endMs > cur.endMs) cur.endMs = p.endMs;
  }
  return groups;
}
