// Локальный сервер: отдаёт страницу, хранит отметки, обновляет данные по расписанию.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { LIGHTNING_START, isCalendarDate } from './lib/config.mjs';
import { earliestWeatherDate, localDate } from './lib/weather.mjs';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const FINDS = path.join(ROOT, 'data', 'finds.json');
const HISTORY = path.join(PUBLIC, 'data', 'history');
const PORT = +(process.env.PORT || 8080);

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

function runUpdate(reason, args = [], date = null) {
  if (running) return false;
  console.log(`[update] старт (${reason})`);
  // Вывод перехватываем, чтобы показывать ход сборки в браузере: семь минут
  // без единого признака работы выглядят как сломанное приложение.
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'update.mjs'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running = { child, date, startedAt: Date.now(), progress: null };
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
    return (await fs.readdir(HISTORY))
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
  const file = path.join(PUBLIC, 'data', 'spots.json');
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
    const raw = JSON.parse(await fs.readFile(path.join(PUBLIC, 'data', 'spots.json'), 'utf8'));
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
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
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

  // Состояние для строки «данные загружены / обновляются»: страница спрашивает
  // раз в полминуты и сама подхватывает свежие данные, когда сервер их пересобрал.
  if (pathname === '/api/status' && req.method === 'GET') {
    const info = await currentData();
    res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({
      generatedAt: info.generatedAt,
      spots: info.spots,
      updating: !!running && !buildingDate(),
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
