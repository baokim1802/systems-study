// Checks every day folder against CONTENT_GUIDE.md.
//   npm run check
const fs = require('fs');
const path = require('path');
const catalog = require('../lib/catalog');

const trackIds = new Set(catalog.TRACKS.map((t) => t.id));
const problems = [];
const warn = [];
let questions = 0;

for (const name of fs.readdirSync(catalog.DAYS_DIR).sort()) {
  const dir = path.join(catalog.DAYS_DIR, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  const bad = (msg) => problems.push(`${name}: ${msg}`);
  if (!/^\d{2}-[a-z0-9-]+$/.test(name)) bad('folder name should look like 14-http');
  let day;
  try {
    day = JSON.parse(fs.readFileSync(path.join(dir, 'day.json'), 'utf8'));
  } catch (err) {
    bad(`day.json: ${err.message}`);
    continue;
  }
  const lessonFile = path.join(dir, 'lesson.md');
  const lesson = fs.existsSync(lessonFile) ? fs.readFileSync(lessonFile, 'utf8') : null;
  if (!lesson) bad('lesson.md is missing');
  else {
    const h1 = (lesson.match(/^#\s+(.+)$/m) || [])[1]?.trim();
    if (h1 !== day.title) bad(`title "${day.title}" != lesson heading "${h1}"`);
    const lines = lesson.split('\n').length;
    if (lines < 100) warn.push(`${name}: lesson is short (${lines} lines)`);
    if ((lesson.match(/^```/gm) || []).length % 2) bad('lesson.md has an unclosed ``` code fence');
  }
  if (!trackIds.has(day.track)) bad(`unknown track "${day.track}"`);
  if (!Number.isFinite(day.minutes)) bad('minutes should be a number');
  if (!day.summary) bad('summary is missing');
  const qs = day.questions || [];
  if (qs.length < 4 || qs.length > 7) bad(`has ${qs.length} questions (expected 5–6)`);
  qs.forEach((q, i) => {
    const where = `${q.id || `question ${i + 1}`}`;
    questions++;
    if (q.id !== `q${i + 1}`) bad(`${where}: id should be q${i + 1}`);
    if (!catalog.KINDS.includes(q.kind)) bad(`${where}: unknown kind "${q.kind}"`);
    if (!catalog.LEVELS.includes(q.level)) bad(`${where}: unknown level "${q.level}"`);
    if (!q.prompt || typeof q.prompt !== 'string') bad(`${where}: prompt is missing`);
    if (!Array.isArray(q.keyPoints) || q.keyPoints.length < 2) bad(`${where}: needs keyPoints (3–6)`);
    for (const f of ['prompt', 'hint', 'answer']) {
      if (q[f] && (q[f].match(/^```/gm) || []).length % 2) bad(`${where}: ${f} has an unclosed code fence`);
    }
  });
}

const days = catalog.listDays();
for (const w of warn) console.log(`⚠️  ${w}`);
if (problems.length) {
  for (const p of problems) console.log(`❌ ${p}`);
  console.log(`\n${problems.length} problem(s) in ${days.length} days.`);
  process.exit(1);
}
console.log(`🫧 All good: ${days.length} days, ${questions} questions.`);
