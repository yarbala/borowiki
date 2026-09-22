// Сбор данных для одной области: леса обзорного слоя + грозы за неделю.
//
//   node scripts/collect-region.mjs krakov
//
// Другие области не трогает: у каждой свои кадры и свои готовые файлы.
// Общие для всех — тайлы лесов (они нарезаны по миру) и кэш погоды (он по координатам).
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadRegions } from '../lib/config.mjs';

const ROOT = process.cwd();
const log = (...m) => console.log('[region]', ...m);

function run(script, args = [], slug) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      stdio: 'inherit',
      // Так сборка работает с нужной областью, не переключая активную.
      env: { ...process.env, BOROWIKI_REGION: slug },
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script}: код ${code}`))));
    child.on('error', reject);
  });
}

async function main() {
  const slug = process.argv[2];
  if (!slug) throw new Error('укажите имя области');

  const { regions } = loadRegions();
  const region = regions.find((r) => r.slug === slug);
  if (!region) throw new Error(`область ${slug} не найдена в data/regions.json`);

  log(`собираю область «${region.label}» (${region.lat}, ${region.lon}) + ${region.radiusKm} км`);

  log('леса региона…');
  await run('build-forests.mjs', [], slug);

  log('грозы за неделю (это дольше всего)…');
  await run('update.mjs', [], slug);

  log(`готово: область «${region.label}» собрана`);
}

main().catch((e) => {
  console.error('[region] ошибка:', e.message);
  process.exit(1);
});
