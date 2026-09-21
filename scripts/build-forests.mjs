// Слой всех лесов региона → public/data/forests.json
//
// В векторных тайлах слой леса пустой на мелком масштабе: лес появляется только
// при приближении. Чтобы весь радиус 200 км было видно сразу, собираем леса один раз
// в отдельный файл — упрощённые контуры, мелкие массивы отброшены.
//
// Запуск: npm run forests   (нужен один раз, файл потом не меняется)
import fs from 'node:fs/promises';
import path from 'node:path';
import { BBOX } from '../lib/config.mjs';
import { ZOOM, tileData } from '../lib/forest.mjs';
import { lonLatToTile } from '../lib/mvt.mjs';
import { ringAreaKm2, simplifyRing } from '../lib/geo.mjs';

const OUT = path.join(process.cwd(), 'public', 'data', 'forests.json');

/** На обзоре массивы мельче этого — меньше пикселя; вблизи их рисует подложка. */
const MIN_AREA_KM2 = 0.4;
/**
 * Упрощение ~300 м. Файл нужен только для обзора (до z9): там пиксель — это 600 м и больше.
 * С приближения z8 лес рисуется уже из самих векторных тайлов, во всех подробностях.
 */
const SIMPLIFY_DEG = 0.003;

const log = (...m) => console.log('[forests]', ...m);

async function main() {
  const min = lonLatToTile(ZOOM, BBOX.minLon, BBOX.maxLat);
  const max = lonLatToTile(ZOOM, BBOX.maxLon, BBOX.minLat);

  const tiles = [];
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) tiles.push([x, y]);
  }
  log(`тайлов z${ZOOM} на регион: ${tiles.length}`);

  const rings = [];
  let done = 0, failed = 0;
  const queue = tiles.slice();

  const worker = async () => {
    while (queue.length) {
      const [x, y] = queue.shift();
      try {
        const d = await tileData(ZOOM, x, y);
        for (const f of d.forests) {
          const area = ringAreaKm2(f.ring);
          if (area < MIN_AREA_KM2) continue;
          const ring = simplifyRing(f.ring, SIMPLIFY_DEG);
          if (ring.length < 4) continue;
          rings.push(ring.map(([lon, lat]) => [+lon.toFixed(4), +lat.toFixed(4)]));
        }
      } catch (e) {
        failed++;
      }
      if (++done % 100 === 0) process.stdout.write(`\r[forests] тайлов: ${done}/${tiles.length}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  process.stdout.write('\n');

  log(`контуров: ${rings.length}, точек: ${rings.reduce((a, r) => a + r.length, 0)}, тайлов не прочиталось: ${failed}`);

  // Один MultiPolygon вместо тысяч объектов: карта рисует его одной заливкой.
  const payload = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) } }],
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(payload));
  log(`записано ${OUT} (${Math.round((await fs.stat(OUT)).size / 1024)} КБ)`);
}

main().catch((e) => {
  console.error('[forests] ошибка:', e);
  process.exit(1);
});
