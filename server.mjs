// Локальный сервер: отдаёт страницу, хранит отметки, обновляет данные по расписанию.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, 'public');
const FINDS = path.join(ROOT, 'data', 'finds.json');
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

function runUpdate(reason) {
  if (updating) return;
  updating = true;
  console.log(`[update] старт (${reason})`);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'update.mjs')], { stdio: 'inherit' });
  child.on('exit', (code) => {
    updating = false;
    console.log(`[update] завершено с кодом ${code}`);
  });
  child.on('error', (e) => {
    updating = false;
    console.error('[update] не запустилось:', e.message);
  });
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
      'cache-control': file.endsWith('.json') ? 'no-store' : 'no-cache',
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
