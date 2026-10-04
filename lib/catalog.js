// Discovers the daily lessons and cheat sheets on disk.
//
//   days/14-http/lesson.md   the reading
//   days/14-http/day.json    title, track, minutes, summary, questions
//
// See CONTENT_GUIDE.md for the format.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DAYS_DIR = path.join(ROOT, 'days');
const CHEATSHEETS_DIR = path.join(ROOT, 'cheatsheets');

const TRACKS = [
  { id: 'foundations', icon: '🧠', title: 'How a computer works' },
  { id: 'networking', icon: '🌐', title: 'Networking' },
  { id: 'data', icon: '🗄️', title: 'Data & databases' },
  { id: 'scale', icon: '🧱', title: 'Building blocks of scale' },
  { id: 'distributed', icon: '🕸️', title: 'Distributed systems' },
  { id: 'production', icon: '🛠️', title: 'Production: security, ops & cloud' },
  { id: 'design', icon: '🏗️', title: 'Design case studies' },
];
const KINDS = ['concept', 'scenario', 'math', 'code', 'design'];
const LEVELS = ['warm-up', 'core', 'stretch'];

function prettify(slug) {
  return slug.replace(/^\d+-/, '').split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function titleFromMarkdown(md, fallback) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function dayDir(id) {
  const dir = path.join(DAYS_DIR, id);
  return /^[\w-]+$/.test(id) && isInside(DAYS_DIR, dir) && fs.existsSync(path.join(dir, 'day.json')) ? dir : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Every day's metadata (no lesson text, no questions), in order. */
function listDays() {
  if (!fs.existsSync(DAYS_DIR)) return [];
  return fs
    .readdirSync(DAYS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(DAYS_DIR, d.name, 'day.json')))
    .map((d) => d.name)
    .sort()
    .map((id) => {
      let meta = {};
      try { meta = readJson(path.join(DAYS_DIR, id, 'day.json')); } catch {}
      return {
        id,
        number: parseInt(id, 10) || 0,
        title: meta.title || prettify(id),
        track: meta.track || 'foundations',
        minutes: meta.minutes || 30,
        summary: meta.summary || '',
        questionCount: (meta.questions || []).length,
      };
    });
}

/** One day with its lesson markdown and questions, or null. */
function readDay(id) {
  const dir = dayDir(id);
  if (!dir) return null;
  const meta = readJson(path.join(dir, 'day.json'));
  const lessonFile = path.join(dir, 'lesson.md');
  return {
    ...listDays().find((d) => d.id === id),
    lesson: fs.existsSync(lessonFile) ? fs.readFileSync(lessonFile, 'utf8') : '',
    questions: meta.questions || [],
  };
}

/** All cheat sheets with their markdown (they're small, so send everything at once). */
function listCheatsheets() {
  if (!fs.existsSync(CHEATSHEETS_DIR)) return [];
  return fs
    .readdirSync(CHEATSHEETS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const id = f.replace(/\.md$/, '');
      const markdown = fs.readFileSync(path.join(CHEATSHEETS_DIR, f), 'utf8');
      return { id, title: titleFromMarkdown(markdown, prettify(id)), markdown };
    });
}

/** Overwrite one cheat sheet file. Returns false if the id isn't a safe, existing file name. */
function saveCheatsheet(id, markdown) {
  const file = path.join(CHEATSHEETS_DIR, `${id}.md`);
  if (!/^[\w-]+$/.test(id) || !fs.existsSync(file)) return false;
  fs.writeFileSync(file, markdown.endsWith('\n') ? markdown : markdown + '\n');
  return true;
}

/** Create a new cheat sheet file named NN-slug.md (numbered after the last one). */
function createCheatsheet(title) {
  fs.mkdirSync(CHEATSHEETS_DIR, { recursive: true });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'notes';
  const nums = fs.readdirSync(CHEATSHEETS_DIR).map((f) => parseInt(f, 10)).filter((n) => !Number.isNaN(n));
  const id = `${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')}-${slug}`;
  fs.writeFileSync(path.join(CHEATSHEETS_DIR, `${id}.md`), `# ${title}\n\n## First note\nOne line about what it is.\n`);
  return id;
}

/** Find a day by id ("14-http"), number ("14" or "14"), or part of its slug ("http"). */
function findDay(query) {
  const q = String(query).toLowerCase();
  const all = listDays();
  const n = /^\d+$/.test(q) ? Number(q) : null;
  return all.find((d) => d.id === q) || (n != null && all.find((d) => d.number === n)) || all.find((d) => d.id.includes(q)) || null;
}

module.exports = {
  ROOT, DAYS_DIR, CHEATSHEETS_DIR, TRACKS, KINDS, LEVELS,
  listDays, readDay, dayDir, findDay, listCheatsheets, saveCheatsheet, createCheatsheet, prettify,
};
