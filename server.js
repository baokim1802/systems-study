// 🫧 Systems Study — tiny zero-dependency server for the study GUI.
//   npm start            -> http://localhost:4331
//   npm start -- --open  -> also opens your browser

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const catalog = require('./lib/catalog');
const store = require('./lib/store');
const { sync } = require('./scripts/sync');

const PORT = Number(process.env.PORT) || 4331;
const HOST = process.env.HOST || '127.0.0.1';
const APP_DIR = path.join(__dirname, 'app');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

let shared; // app/shared.js, loaded at startup

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function summaries(days) {
  const docs = store.allAnswers();
  const out = {};
  for (const d of days) if (docs[d.id]) out[d.id] = shared.answerSummary(docs[d.id], d.questionCount);
  return out;
}

/** Questions from finished days, for the Recall page. */
function recallCards(progress) {
  const cards = [];
  for (const d of catalog.listDays()) {
    if (!progress.days[d.id]?.done) continue;
    for (const q of catalog.readDay(d.id).questions) {
      cards.push({ key: `${d.id}#${q.id}`, dayId: d.id, dayNumber: d.number, dayTitle: d.title, track: d.track, question: q });
    }
  }
  return cards;
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const [resource] = parts;

  if (resource === 'state' && req.method === 'GET') {
    const days = catalog.listDays();
    return send(res, 200, { tracks: catalog.TRACKS, days, progress: store.loadProgress(), summaries: summaries(days) });
  }

  if (resource === 'days' && parts[1]) {
    const id = parts[1];
    const day = catalog.readDay(id);
    if (!day) return send(res, 404, { error: 'Day not found' });
    const action = parts[2];

    if (!action && req.method === 'GET') {
      return send(res, 200, { ...day, answers: store.loadAnswers(id), file: path.relative(catalog.ROOT, path.join(store.ANSWERS_DIR, `${id}.json`)) });
    }
    if (action === 'answers' && req.method === 'PUT') {
      const { answers } = await readBody(req);
      if (!answers || typeof answers !== 'object') return send(res, 400, { error: 'answers must be an object' });
      const progress = store.loadProgress();
      const doc = shared.saveAnswers(progress, store.loadAnswers(id), answers);
      store.saveAnswersDoc(id, doc);
      store.saveProgress(progress);
      return send(res, 200, { answers: doc, progress });
    }
    if (action === 'feedback' && req.method === 'PUT') {
      const body = await readBody(req);
      if (typeof body.feedback !== 'string') return send(res, 400, { error: 'feedback must be a string' });
      const progress = store.loadProgress();
      const doc = shared.saveFeedback(progress, store.loadAnswers(id), body);
      store.saveAnswersDoc(id, doc);
      store.saveProgress(progress);
      return send(res, 200, { answers: doc, progress });
    }
  }

  if (resource === 'recall' && req.method === 'GET') {
    return send(res, 200, recallCards(store.loadProgress()));
  }

  if (resource === 'progress' && req.method === 'POST') {
    const progress = shared.applyProgress(store.loadProgress(), await readBody(req));
    return send(res, 200, store.saveProgress(progress));
  }

  if (resource === 'cheatsheets' && !parts[1] && req.method === 'GET') {
    return send(res, 200, catalog.listCheatsheets());
  }
  if (resource === 'cheatsheets' && !parts[1] && req.method === 'POST') {
    const { title } = await readBody(req);
    if (typeof title !== 'string' || !title.trim()) return send(res, 400, { error: 'title is required' });
    return send(res, 200, { id: catalog.createCheatsheet(title.trim().slice(0, 60)) });
  }
  if (resource === 'cheatsheets' && parts[1] && req.method === 'PUT') {
    const { markdown } = await readBody(req);
    if (typeof markdown !== 'string') return send(res, 400, { error: 'markdown must be a string' });
    return catalog.saveCheatsheet(parts[1], markdown) ? send(res, 200, { saved: true }) : send(res, 404, { error: 'Cheat sheet not found' });
  }

  if (resource === 'sync' && req.method === 'POST') {
    return send(res, 200, sync());
  }

  return send(res, 404, { error: 'Not found' });
}

function serveStatic(res, pathname) {
  const file = path.join(APP_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(APP_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    serveStatic(res, decodeURIComponent(url.pathname));
  } catch (err) {
    send(res, err.status || 500, { error: err.message });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  🫧 Systems Study is already running at http://localhost:${PORT}\n`);
    process.exit(0);
  }
  throw err;
});

store.init().then((s) => {
  shared = s;
  server.listen(PORT, HOST, () => {
    const link = `http://localhost:${PORT}`;
    console.log(`\n  🫧 Systems Study is running at \x1b[38;5;117m${link}\x1b[0m\n     (Ctrl+C to stop)\n`);
    if (process.argv.includes('--open')) {
      spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [link], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
  });
});
