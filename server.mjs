// Локальный сервер: отдаёт страницу, хранит отметки, обновляет данные по расписанию.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { LIGHTNING_START, REGIONS_FILE, isCalendarDate, loadRegions, slugify } from './lib/config.mjs';
import { earliestWeatherDate, fetchStormForecast, localDate } from './lib/weather.mjs';
import { loadForestMask } from './lib/forestmask.mjs';

/** Прогноз гроз по областям: {slug → {at, data}}. Живёт три часа. */
const forecastCache = new Map();

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const FINDS = path.join(ROOT, 'data', 'finds.json');
const PORT = +(process.env.PORT || 8080);

/**
 * Областей может быть несколько, и данные у каждой свои. Какая активна — решает
 * файл data/regions.json; сервер перечитывает его при каждом обращении, чтобы
 * переключение в настройках срабатывало сразу.
 */
const regionsState = () => loadRegions();
const activeRegion = () => {
  const { active, regions } = regionsState();
  return regions.find((r) => r.slug === active) || regions[0];
};
const regionDir = (slug) => path.join(PUBLIC, 'data', 'regions', slug);
const historyDir = () => path.join(regionDir(activeRegion().slug), 'history');

async function saveRegions(state) {
  await fs.mkdir(path.dirname(REGIONS_FILE), { recursive: true });
  const tmp = `${REGIONS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, REGIONS_FILE);
}

/** Как часто проверять, не пора ли обновить данные. */
const CHECK_MS = 15 * 60_000;
/** Данные старше этого срока обновляем. */
const MAX_AGE_MS = 60 * 60_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- отметки ----------

async function readFinds() {
  try {
    return JSON.parse(await fs.readFile(FINDS, 'utf8'));
  } catch {
    return {};
  }
}

async function writeFinds(data) {
  await fs.mkdir(path.dirname(FINDS), { recursive: true });
  await fs.writeFile(FINDS, JSON.stringify(data, null, 2));
}

// ---------- обновление данных ----------

/**
 * Текущая сборка: {child, date} или null. Дата и процесс хранятся вместе —
 * иначе обработчик выхода одного процесса стирал состояние другого.
 */
let running = null;

/**
 * Чем закончилась последняя сборка: {date, ok, error, at}. Без этого упавшая
 * сборка снимка выглядела в браузере точно так же, как удачная — плашка просто
 * исчезала, и человек ждал файл, которого уже не будет.
 */
let lastRun = null;

const buildingDate = () => running?.date || null;

function runUpdate(reason, args = [], date = null, script = 'update.mjs', kind = 'update') {
  if (running) return false;
  console.log(`[update] старт (${reason})`);
  // Вывод перехватываем, чтобы показывать ход сборки в браузере: семь минут
  // без единого признака работы выглядят как сломанное приложение.
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running = { child, date, kind, startedAt: Date.now(), progress: null };
  let cancelled = false;
  running.cancel = () => { cancelled = true; child.kill('SIGTERM'); };
  const watch = (stream) => stream.on('data', (buf) => {
    process.stdout.write(buf);
    const line = buf.toString().split(/[\r\n]+/).filter(Boolean).pop();
    if (line && running?.child === child) running.progress = line.replace(/^\[update\]\s*/, '').slice(0, 120);
  });
  watch(child.stdout);
  watch(child.stderr);
  const done = (msg, error) => {
    if (running?.child === child) running = null;
    lastRun = { date, ok: !error, error: error || null, at: new Date().toISOString() };
    console.log(`[update] ${msg}`);
  };
  child.on('exit', (code) => done(
    `завершено с кодом ${code}`,
    code === 0 || cancelled ? null : `сборка завершилась с ошибкой (код ${code}) — подробности в окне, где запущен сервер`,
  ));
  child.on('error', (e) => done(`не запустилось: ${e.message}`, `не удалось запустить сборку: ${e.message}`));
  return true;
}

/** Проверка даты для режима истории: существует ли такой день и есть ли за него данные. */
function checkHistoryDate(date) {
  if (!isCalendarDate(date)) throw new Error('нужна существующая дата вида ГГГГ-ММ-ДД');
  if (date > localDate()) throw new Error('это дата в будущем');
  if (date < LIGHTNING_START) throw new Error(`молнии есть только с ${LIGHTNING_START}`);
  const earliest = earliestWeatherDate();
  if (date < earliest) throw new Error(`погода есть примерно за три последних месяца — снимок раньше ${earliest} собрать не из чего`);
  return date;
}

async function historyDates() {
  try {
    return (await fs.readdir(historyDir()))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Состояние данных для строки в браузере. Файл на 900 КБ разбираем только когда
 * он изменился, иначе опрос раз в полминуты читал бы его впустую.
 */
let dataInfo = { mtimeMs: 0, generatedAt: null, spots: 0 };

async function currentData() {
  const file = path.join(regionDir(activeRegion().slug), 'spots.json');
  try {
    const st = await fs.stat(file);
    if (st.mtimeMs !== dataInfo.mtimeMs) {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      dataInfo = { mtimeMs: st.mtimeMs, generatedAt: raw.generatedAt, spots: raw.spots?.length || 0 };
    }
  } catch {
    dataInfo = { mtimeMs: 0, generatedAt: null, spots: 0 };
  }
  return dataInfo;
}

async function dataAgeMs() {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(regionDir(activeRegion().slug), 'spots.json'), 'utf8'));
    if (raw.demo) return 0; // демо-данные не устаревают
    return Date.now() - new Date(raw.generatedAt).getTime();
  } catch {
    return Infinity;
  }
}

async function maybeUpdate(reason) {
  const age = await dataAgeMs();
  if (age > MAX_AGE_MS) runUpdate(`${reason}, данным ${age === Infinity ? 'нет' : Math.round(age / 60000) + ' мин'}`);
}

// ---------- HTTP ----------

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  // Страница просит просто data/spots.json — отдаём файл выбранной области.
  // Так переключение области не требует от страницы знать её имя.
  if (rel.startsWith('data/') && !rel.startsWith('data/regions/')) {
    rel = `data/regions/${activeRegion().slug}/${rel.slice('data/'.length)}`;
  }
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('403');
    return;
  }
  try {
    // Кэш с проверкой: браузер хранит файл, но каждый раз спрашивает, не изменился ли он.
    // Прежний «на сутки без проверки» оставлял на экране леса прежнего региона после
    // `npm run region`, а «не хранить вовсе» заставлял качать 3 МБ при каждой загрузке.
    const st = await fs.stat(file);
    const tag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    const headers = {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      etag: tag,
      'last-modified': st.mtime.toUTCString(),
    };
    if (req.headers['if-none-match'] === tag) {
      res.writeHead(304, headers).end();
      return;
    }
    const body = await fs.readFile(file);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Не найдено');
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (pathname === '/api/finds') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify(await readFinds()));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1e5) req.destroy();
      });
      req.on('end', async () => {
        try {
          const { id, kind, ...rest } = JSON.parse(body || '{}');
          if (!id) throw new Error('нет id');
          const finds = await readFinds();
          if (kind == null) delete finds[id];
          else finds[id] = { kind, ...rest };
          await writeFinds(finds);
          res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'content-type': MIME['.json'] }).end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  if (pathname === '/api/history') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({
        dates: await historyDates(),
        building: buildingDate(),
        progress: running?.progress || null,
        startedAt: running?.startedAt || null,
        lastRun,
      }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', async () => {
        try {
          const date = checkHistoryDate(JSON.parse(body || '{}').date);
          const dates = await historyDates();
          if (dates.includes(date)) {
            res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({ ready: true }));
            return;
          }
          // Занято может быть и обычным обновлением — у него даты нет, и раньше
          // браузер получал building: null и рапортовал о сборке, которой не было.
          if (running) {
            const busyWith = buildingDate();
            throw new Error(busyWith
              ? `сейчас собирается ${busyWith} — дождитесь окончания`
              : 'сейчас идёт обычное обновление данных, попробуйте через минуту');
          }
          runUpdate(`история на ${date}`, [`--date=${date}`], date);
          res.writeHead(202, { 'content-type': MIME['.json'] }).end(JSON.stringify({ building: date }));
        } catch (e) {
          res.writeHead(400, { 'content-type': MIME['.json'] }).end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  /**
   * Список областей: показать, переключиться, добавить новую, удалить лишнюю.
   * Области лежат рядом и не мешают друг другу — добавление Кракова не трогает
   * вроцлавские данные.
   */
  if (pathname === '/api/regions') {
    if (req.method === 'GET') {
      const { active, regions } = regionsState();
      const list = await Promise.all(regions.map(async (r) => {
        let ready = false, generatedAt = null, spots = 0;
        try {
          const raw = JSON.parse(await fs.readFile(path.join(regionDir(r.slug), 'spots.json'), 'utf8'));
          ready = true;
          generatedAt = raw.generatedAt;
          spots = raw.spots?.length || 0;
        } catch {}
        return { ...r, ready, generatedAt, spots, active: r.slug === active };
      }));
      res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({ active, regions: list }));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', async () => {
        try {
          const { action, slug, lat, lon, label, radiusKm } = JSON.parse(body || '{}');
          const state = regionsState();

          if (action === 'switch') {
            if (!state.regions.some((r) => r.slug === slug)) throw new Error('такой области нет');
            await saveRegions({ ...state, active: slug });
            res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({ active: slug }));
            return;
          }

          if (action === 'remove') {
            if (state.regions.length < 2) throw new Error('это единственная область — удалять нечего');
            const rest = state.regions.filter((r) => r.slug !== slug);
            if (rest.length === state.regions.length) throw new Error('такой области нет');
            if (running) throw new Error('дождитесь окончания сборки');
            await saveRegions({ active: state.active === slug ? rest[0].slug : state.active, regions: rest });
            // Данные убираем в сторону, а не стираем: вернуть дешевле, чем собрать заново.
            const stash = path.join(ROOT, 'data', 'removed', `${slug}-${Date.now()}`);
            await fs.mkdir(path.dirname(stash), { recursive: true });
            await fs.rename(regionDir(slug), stash).catch(() => {});
            res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({ removed: slug, stash }));
            return;
          }

          if (action === 'add') {
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
              throw new Error('нужны координаты новой области');
            }
            const r = Math.round(Number(radiusKm) || 200);
            if (r < 50 || r > 300) throw new Error('радиус области — от 50 до 300 км');
            if (running) throw new Error('сейчас идёт другая сборка, попробуйте через минуту');

            const name = String(label || '').trim().slice(0, 60) || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
            const newSlug = slugify(name, lat, lon);
            if (state.regions.some((x) => x.slug === newSlug)) throw new Error(`область «${name}» уже есть в списке`);

            const region = { slug: newSlug, label: name, lat: +lat.toFixed(4), lon: +lon.toFixed(4), radiusKm: r };
            // Записываем сразу, но активной не делаем: пока данных нет, показывать нечего.
            await saveRegions({ active: state.active, regions: [...state.regions, region] });
            runUpdate(`сбор области ${name}`, [newSlug], null, 'collect-region.mjs', 'region');
            res.writeHead(202, { 'content-type': MIME['.json'] }).end(JSON.stringify({ adding: region }));
            return;
          }

          throw new Error('неизвестное действие');
        } catch (e) {
          res.writeHead(400, { 'content-type': MIME['.json'] }).end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  /**
   * Где ожидаются грозы в ближайшие три дня. Спрашивается только по нажатию
   * кнопки в приложении; ответ держим три часа, чтобы повторные нажатия не
   * тратили лимит впустую.
   */
  if (pathname === '/api/forecast' && req.method === 'GET') {
    try {
      const region = activeRegion();
      const cached = forecastCache.get(region.slug);
      if (cached && Date.now() - cached.at < 3 * 3600_000) {
        res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify(cached.data));
        return;
      }
      // Прямоугольник считаем здесь, а не берём из настроек: после переключения
      // области настройки, прочитанные при запуске сервера, уже не те.
      const dLat = region.radiusKm / 111.32;
      const dLon = region.radiusKm / (111.32 * Math.cos((region.lat * Math.PI) / 180));
      const bbox = {
        minLat: region.lat - dLat, maxLat: region.lat + dLat,
        minLon: region.lon - dLon, maxLon: region.lon + dLon,
      };
      const inForest = await loadForestMask(path.join(regionDir(region.slug), 'forests.json'));
      if (!inForest) throw new Error('слой лесов для этой области не собран');
      const data = await fetchStormForecast(bbox, { keep: inForest });
      const slug = region.slug;
      forecastCache.set(slug, { at: Date.now(), data });
      console.log(`[прогноз] ${slug}: ${data.cells.length} мест с грозой из ${data.points} точек леса`);
      res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'content-type': MIME['.json'] }).end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Состояние для строки «данные загружены / обновляются»: страница спрашивает
  // раз в полминуты и сама подхватывает свежие данные, когда сервер их пересобрал.
  if (pathname === '/api/status' && req.method === 'GET') {
    const info = await currentData();
    res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({
      generatedAt: info.generatedAt,
      spots: info.spots,
      updating: !!running && !buildingDate(),
      kind: running?.kind || null,
      building: buildingDate(),
      progress: running?.progress || null,
      startedAt: running?.startedAt || null,
      lastRun,
    }));
    return;
  }

  // Отмена сборки: снимок пишется через переименование, поэтому прерванная
  // сборка не оставляет после себя ни обрезанного файла, ни следов.
  if (pathname === '/api/history/cancel' && req.method === 'POST') {
    const was = buildingDate();
    if (running) running.cancel();
    res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({ cancelled: was }));
    return;
  }

  if (pathname === '/api/update' && req.method === 'POST') {
    runUpdate('запрошено вручную');
    res.writeHead(202, { 'content-type': MIME['.json'] }).end(JSON.stringify({ started: true }));
    return;
  }

  await serveStatic(req, res, pathname);
});

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`borowiki: http://localhost:${PORT}`);
  for (const a of localAddresses()) console.log(`  с телефона: ${a}`);
  if (process.env.NO_AUTO_UPDATE !== '1') {
    await maybeUpdate('старт');
    setInterval(() => maybeUpdate('расписание'), CHECK_MS);
  }
});
