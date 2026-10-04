// Browser "server" for the static website (GitHub Pages).
// Content comes from data.json (built by scripts/build-static.js from the repo). Everything you
// change — answers, feedback, progress, cheat sheet edits — is saved in this browser's localStorage.
// Use Backup / Restore in the sidebar to move it between devices.
import * as shared from './shared.js';

const KEY = 'sys:site:v1';

let data = null; // the built bundle
let store = null; // { progress, answers: {dayId: doc}, cheats: {id: md}, newCheats: [{id, markdown}] }

const titleOf = (md, fallback) => (md.match(/^#\s+(.+)$/m) || [])[1]?.trim() || fallback;

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch (err) {
    throw new Error(`Couldn't save in this browser (${err.message}). Use Backup to download your work.`);
  }
}

async function init() {
  if (data) return;
  const res = await fetch('data.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Couldn't load the study content (HTTP ${res.status})`);
  data = await res.json();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  store = {
    // first visit: start from the progress and answers committed in the repo
    progress: shared.normalizeProgress(saved?.progress ?? data.seedProgress ?? {}),
    answers: saved?.answers || data.seedAnswers || {},
    cheats: saved?.cheats || {},
    newCheats: saved?.newCheats || [],
  };
}

const dayMeta = ({ lesson, questions, ...meta }) => meta;
const docOf = (id) => shared.normalizeAnswers(store.answers[id]);

function summaries() {
  const out = {};
  for (const d of data.days) if (store.answers[d.id]) out[d.id] = shared.answerSummary(store.answers[d.id], d.questionCount);
  return out;
}

// ---------- cheat sheets ----------
function cheatsheets() {
  const base = data.cheatsheets.map((c) => {
    const markdown = store.cheats[c.id] ?? c.markdown;
    return { id: c.id, title: titleOf(markdown, c.title), markdown };
  });
  const extra = store.newCheats.map((c) => ({ id: c.id, title: titleOf(c.markdown, c.id), markdown: c.markdown }));
  return [...base, ...extra].sort((a, b) => a.id.localeCompare(b.id));
}

function createCheatsheet(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'notes';
  const nums = cheatsheets().map((c) => parseInt(c.id, 10)).filter((n) => !Number.isNaN(n));
  const id = `${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')}-${slug}`;
  store.newCheats.push({ id, markdown: `# ${title}\n\n## First note\nOne line about what it is.\n` });
  persist();
  return id;
}

// ---------- the "routes" (mirror server.js) ----------
function notFound(what) {
  const err = new Error(`${what} not found`);
  err.status = 404;
  return err;
}

export async function handle(path, { method = 'GET', body } = {}) {
  await init();
  const parts = path.split('/').filter(Boolean);
  const [resource] = parts;

  if (resource === 'state') {
    return { tracks: data.tracks, days: data.days.map(dayMeta), progress: store.progress, summaries: summaries() };
  }

  if (resource === 'days' && parts[1]) {
    const id = parts[1];
    const day = data.days.find((d) => d.id === id);
    if (!day) throw notFound('Day');
    const action = parts[2];
    if (!action) return { ...day, answers: docOf(id), file: 'saved in this browser' };
    if (action === 'answers' && method === 'PUT') {
      store.answers[id] = shared.saveAnswers(store.progress, docOf(id), body.answers);
      persist();
      return { answers: store.answers[id], progress: store.progress };
    }
    if (action === 'feedback' && method === 'PUT') {
      store.answers[id] = shared.saveFeedback(store.progress, docOf(id), body);
      persist();
      return { answers: store.answers[id], progress: store.progress };
    }
  }

  if (resource === 'recall') {
    return data.days
      .filter((d) => store.progress.days[d.id]?.done)
      .flatMap((d) => d.questions.map((q) => ({ key: `${d.id}#${q.id}`, dayId: d.id, dayNumber: d.number, dayTitle: d.title, track: d.track, question: q })));
  }

  if (resource === 'progress' && method === 'POST') {
    shared.applyProgress(store.progress, body);
    persist();
    return store.progress;
  }

  if (resource === 'cheatsheets') {
    if (!parts[1] && method === 'GET') return cheatsheets();
    if (!parts[1] && method === 'POST') return { id: createCheatsheet(String(body.title).trim().slice(0, 60)) };
    if (parts[1] && method === 'PUT') {
      const extra = store.newCheats.find((c) => c.id === parts[1]);
      if (extra) extra.markdown = body.markdown;
      else if (data.cheatsheets.some((c) => c.id === parts[1])) store.cheats[parts[1]] = body.markdown;
      else throw notFound('Cheat sheet');
      persist();
      return { saved: true };
    }
  }

  if (resource === 'sync') {
    return { ok: false, message: 'On the website your work is saved in this browser. Use ⬇️ Backup to download a copy.' };
  }

  throw notFound('Page');
}

// ---------- backup / restore ----------
export async function exportBackup() {
  await init();
  const blob = new Blob([JSON.stringify({ app: 'systems-study', version: 1, exportedAt: new Date().toISOString(), ...store }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `systems-study-backup-${shared.today()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importBackup(text) {
  await init();
  const obj = JSON.parse(text);
  if (!obj || obj.app !== 'systems-study' || !obj.progress) throw new Error("That file doesn't look like a Systems Study backup.");
  store = {
    progress: shared.normalizeProgress(obj.progress),
    answers: obj.answers || {},
    cheats: obj.cheats || {},
    newCheats: obj.newCheats || [],
  };
  persist();
}
