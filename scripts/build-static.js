// Builds the static website (GitHub Pages) into dist/.
//   npm run build            -> dist/
//   npm run build -- --serve -> also serves it at http://localhost:4332 to try it out
//
// dist/ = the app/ files + data.json (every day, question and cheat sheet),
// with window.SYS_STATIC set so the app runs without the Node server.
const fs = require('fs');
const path = require('path');
const catalog = require('../lib/catalog');
const store = require('../lib/store');

const ROOT = catalog.ROOT;
const OUT = path.join(ROOT, 'dist');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const f of fs.readdirSync(path.join(ROOT, 'app'))) {
  fs.copyFileSync(path.join(ROOT, 'app', f), path.join(OUT, f));
}
const html = read(OUT, 'index.html').replace(
  '<script type="module" src="app.js"></script>',
  '<script>window.SYS_STATIC = true;</script>\n  <script type="module" src="app.js"></script>',
);
if (!html.includes('SYS_STATIC')) throw new Error('Could not mark index.html as static');
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '.nojekyll'), ''); // serve files as-is on GitHub Pages

let seedProgress = null;
try { seedProgress = JSON.parse(read(ROOT, 'data', 'progress.json')); } catch {}

const bundle = {
  builtAt: new Date().toISOString(),
  tracks: catalog.TRACKS,
  days: catalog.listDays().map((d) => catalog.readDay(d.id)),
  cheatsheets: catalog.listCheatsheets(),
  seedProgress,
  seedAnswers: store.allAnswers(),
};
fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify(bundle));
const kb = Math.round(fs.statSync(path.join(OUT, 'data.json')).size / 1024);
console.log(`🫧 Built dist/ — ${bundle.days.length} days, ${bundle.cheatsheets.length} cheat sheets (data.json ${kb} KB)`);

if (process.argv.includes('--serve')) {
  const http = require('http');
  const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
  const port = Number(process.env.PORT) || 4332;
  http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(OUT, rel);
    if (!file.startsWith(OUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  }).listen(port, () => console.log(`   Serving the website build at http://localhost:${port}`));
}
