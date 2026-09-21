// Локальный сервер: отдаёт страницу, хранит отметки, обновляет данные по расписанию.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

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

let updating = false;

/** Дата, которую сейчас собираем для режима истории, либо null. */
let buildingDate = null;

function runUpdate(reason, args = []) {
  if (updating) return false;
  updating = true;
  console.log(`[update] старт (${reason})`);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'update.mjs'), ...args], { stdio: 'inherit' });
  child.on('exit', (code) => {
    updating = false;
    buildingDate = null;
    console.log(`[update] завершено с кодом ${code}`);
  });
  child.on('error', (e) => {
    updating = false;
    buildingDate = null;
    console.error('[update] не запустилось:', e.message);
  });
  return true;
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
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // Локальное приложение: кэшируем только тяжёлый слой лесов, он не меняется.
      'cache-control': file.endsWith('forests.json') ? 'public, max-age=86400' : 'no-store',
    });
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
      res.writeHead(200, { 'content-type': MIME['.json'] })
        .end(JSON.stringify({ dates: await historyDates(), building: buildingDate }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', async () => {
        try {
          const { date } = JSON.parse(body || '{}');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('нужна дата вида ГГГГ-ММ-ДД');
          const dates = await historyDates();
          if (dates.includes(date)) {
            res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({ ready: true }));
            return;
          }
          if (buildingDate) {
            res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify({ building: buildingDate }));
            return;
          }
          buildingDate = date;
          if (!runUpdate(`история на ${date}`, [`--date=${date}`])) {
            buildingDate = null;
            throw new Error('сейчас идёт другое обновление, попробуйте через минуту');
          }
          res.writeHead(202, { 'content-type': MIME['.json'] }).end(JSON.stringify({ building: date }));
        } catch (e) {
          res.writeHead(400, { 'content-type': MIME['.json'] }).end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
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
