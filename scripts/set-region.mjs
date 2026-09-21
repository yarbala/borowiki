// Перенос области данных в другое место.
//
//   npm run region -- Гродно
//   npm run region -- "Варшава" 150
//   npm run region -- 53.6884,23.8258 200
//
// Находит координаты, записывает data/region.json, чистит кэш кадров (он привязан
// к прямоугольнику старого региона) и пересобирает леса и грозы.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const REGION_FILE = path.join(ROOT, 'data', 'region.json');

const log = (...m) => console.log('[region]', ...m);

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=ru&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'borowiki/1.0 (personal hobby project)', accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const [hit] = await res.json();
  if (!hit) throw new Error(`не нашлось: ${query}`);
  return { lat: +(+hit.lat).toFixed(4), lon: +(+hit.lon).toFixed(4), label: hit.name || query };
}

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script)], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} завершился с кодом ${code}`))));
    child.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('Укажите место: npm run region -- Гродно [радиус_км]');
    process.exit(1);
  }

  const maybeRadius = Number(args[args.length - 1]);
  const radiusKm = Number.isFinite(maybeRadius) && maybeRadius >= 20 && maybeRadius <= 400 ? maybeRadius : 200;
  const query = (Number.isFinite(maybeRadius) ? args.slice(0, -1) : args).join(' ');

  // Координаты можно задать и напрямую: «53.6884,23.8258».
  const direct = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  const home = direct
    ? { lat: +(+direct[1]).toFixed(4), lon: +(+direct[2]).toFixed(4), label: `${direct[1]}, ${direct[2]}` }
    : await geocode(query);

  log(`новая область: ${home.label} (${home.lat}, ${home.lon}) + ${radiusKm} км`);

  await fs.mkdir(path.dirname(REGION_FILE), { recursive: true });
  await fs.writeFile(REGION_FILE, JSON.stringify({ home, radiusKm }, null, 2));

  // Кадры молний хранятся в координатах сетки старого прямоугольника — они больше не годятся.
  const frames = path.join(ROOT, 'data', 'frames');
  try {
    const files = await fs.readdir(frames);
    for (const f of files) await fs.unlink(path.join(frames, f));
    log(`кэш кадров очищен: ${files.length} файлов`);
  } catch {}

  // Сетка дождя тоже привязана к прямоугольнику. Ключ кэша теперь включает область,
  // но старые файлы (без области в имени) убираем, чтобы не занимали место зря.
  const cache = path.join(ROOT, 'data', 'cache');
  try {
    const stale = (await fs.readdir(cache)).filter((f) => /^rain-\d{4}-/.test(f));
    for (const f of stale) await fs.unlink(path.join(cache, f));
    if (stale.length) log(`кэш осадков прежнего региона очищен: ${stale.length} файлов`);
  } catch {}

  log('собираем леса региона…');
  await run('build-forests.mjs');

  log('собираем грозы за неделю (это дольше всего — около 7 минут)…');
  await run('update.mjs');

  log('готово. Перезагрузите страницу в браузере.');
}

main().catch((e) => {
  console.error('[region] ошибка:', e.message);
  process.exit(1);
});
