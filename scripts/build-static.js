// Builds the static website (GitHub Pages) into dist/.
//   npm run build            -> dist/
//   npm run build -- --serve -> also serves it at http://localhost:4332 to try it out
//
// dist/ = the app/ files + data.json (every day, question and cheat sheet),
// with window.SYS_STATIC set so the app runs without the Node server.
// If supabase.config.json has a url and anonKey, the site saves to Supabase behind a sign-in
// (window.SYS_SUPABASE); otherwise it saves in each visitor's browser.
const fs = require('fs');
const path = require('path');
const catalog = require('../lib/catalog');
const store = require('../lib/store');

const ROOT = catalog.ROOT;
const OUT = path.join(ROOT, 'dist');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// GitHub Pages lets browsers cache files for 10 minutes, and a hard refresh doesn't reach modules the
// app imports later (static-api.js, cloud.js). So right after a deploy a browser can run new code with
// old modules. Every app file reference gets ?v=<hash of the app files>, so a new build always loads
// as one matching set. (Same as ../leet/scripts/build-static.js.)
const appFiles = fs.readdirSync(path.join(ROOT, 'app')).sort();
const version = require('crypto').createHash('sha1')
  .update(appFiles.map((f) => f + read(ROOT, 'app', f)).join('\0')).digest('hex').slice(0, 10);
const bust = (src) => src.replace(/(['"])(\.\/)?([\w-]+\.(?:js|css))\1/g, (m, q, dot, name) =>
  (appFiles.includes(name) ? `${q}${dot || ''}${name}?v=${version}${q}` : m));

for (const f of appFiles) {
  if (f.endsWith('.js')) fs.writeFileSync(path.join(OUT, f), bust(read(ROOT, 'app', f)));
  else fs.copyFileSync(path.join(ROOT, 'app', f), path.join(OUT, f));
}
const supabase = readSupabaseConfig();
const flags = `window.SYS_STATIC = true;${supabase ? ` window.SYS_SUPABASE = ${JSON.stringify(supabase)};` : ''}`;
const html = bust(read(OUT, 'index.html')).replace(
  `<script type="module" src="app.js?v=${version}"></script>`,
  `<script>${flags}</script>\n  <script type="module" src="app.js?v=${version}"></script>`,
);
if (!html.includes('SYS_STATIC')) throw new Error('Could not mark index.html as static');
if (!html.includes(`style.css?v=${version}`)) throw new Error('Could not version style.css in index.html');
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '.nojekyll'), ''); // serve files as-is on GitHub Pages

// Browser-only mode starts a first visit from your local progress and answers.
// With Supabase they live in your account instead, and stay out of the public data.json.
let seedProgress = null;
if (!supabase) try { seedProgress = JSON.parse(read(ROOT, 'data', 'progress.json')); } catch {}

const bundle = {
  builtAt: new Date().toISOString(),
  tracks: catalog.TRACKS,
  days: catalog.listDays().map((d) => catalog.readDay(d.id)),
  cheatsheets: catalog.listCheatsheets(),
  seedProgress,
  seedAnswers: supabase ? {} : store.allAnswers(),
};
fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify(bundle));
const kb = Math.round(fs.statSync(path.join(OUT, 'data.json')).size / 1024);
console.log(`🫧 Built dist/ — ${bundle.days.length} days, ${bundle.cheatsheets.length} cheat sheets (data.json ${kb} KB)`);
console.log(supabase ? `   Saves to Supabase (${supabase.url}), sign-in required` : '   Saves in the browser (supabase.config.json is empty)');

function readSupabaseConfig() {
  let cfg = {};
  try { cfg = JSON.parse(read(ROOT, 'supabase.config.json')); } catch {}
  const url = process.env.SUPABASE_URL || cfg.url;
  const anonKey = process.env.SUPABASE_ANON_KEY || cfg.anonKey;
  return url && anonKey ? { url, anonKey } : null;
}

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
