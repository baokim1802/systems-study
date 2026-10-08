// Browser "server" for the static website (GitHub Pages).
// Content comes from data.json (built by scripts/build-static.js from the repo). Everything you
// change — answers, feedback, notes, progress, cheat sheet edits — is saved:
//   - in your Supabase account when supabase.config.json is filled in (sign in on any device), or
//   - in this browser's localStorage otherwise (use Backup / Restore to move it between devices).
import * as shared from './shared.js';
import * as cloud from './cloud.js';
import { createClient } from './supa.js';

const KEY = 'sys:site:v1';
const SESSION_KEY = 'sys:supabase:session';
const RELOAD_AFTER_MS = 15_000; // pick up changes from your other devices when you come back to the tab

let data = null; // the built bundle
let store = null; // { progress, answers: {dayId: doc}, cheats: {id: md}, newCheats: [{id, markdown}] }
let loadedAt = 0;

const config = window.SYS_SUPABASE;
let db = null;

/** The Supabase client, or null when the site keeps everything in this browser. */
export function cloudClient() {
  if (!config?.url || !config?.anonKey) return null;
  db ||= createClient({
    url: config.url,
    anonKey: config.anonKey,
    storage: {
      load() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } },
      save(s) { try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch {} },
    },
  });
  return db;
}

const titleOf = (md, fallback) => (md.match(/^#\s+(.+)$/m) || [])[1]?.trim() || fallback;

function readLocal() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch (err) {
    throw new Error(`Couldn't save in this browser (${err.message}). Use Backup to download your work.`);
  }
}

function fromSaved(saved) {
  return {
    progress: shared.normalizeProgress(saved?.progress ?? {}),
    answers: saved?.answers || {},
    cheats: saved?.cheats || {},
    newCheats: saved?.newCheats || [],
  };
}

async function loadFromCloud() {
  const { store: s, rowCount } = await cloud.loadStore(db);
  store = s;
  loadedAt = Date.now();
  // A brand-new account on a browser that already has work in it: offer to copy it up.
  const local = readLocal();
  if (!rowCount && local?.progress && confirm('This browser has study work saved in it. Copy it into your account?')) {
    store = fromSaved(local);
    await cloud.saveStore(db, db.user.id, store);
  }
}

async function init() {
  if (!data) {
    const res = await fetch('data.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Couldn't load the study content (HTTP ${res.status})`);
    data = await res.json();
  }
  if (cloudClient()) {
    if (!db.user) throw Object.assign(new Error('Please sign in.'), { status: 401 });
    if (!store) await loadFromCloud();
    return;
  }
  if (store) return;
  // first visit: start from the progress and answers committed in the repo
  const saved = readLocal();
  store = fromSaved({ ...saved, progress: saved?.progress ?? data.seedProgress, answers: saved?.answers || data.seedAnswers });
}

/**
 * Make a change. `mutate` edits the in-memory store; `rows()` names the table rows it touched.
 * In the browser-only mode the whole store goes to localStorage; with Supabase only those rows
 * are written, plus today's activity counters through bump_activity.
 */
async function commit(mutate, rows = () => []) {
  const day = shared.today();
  const before = { ...store.progress.activity[day] };
  const result = mutate();
  if (!db) {
    persist();
    return result;
  }
  const delta = cloud.activityDelta(day, before, store.progress.activity[day]);
  try {
    await Promise.all([cloud.writeRows(db, rows()), delta && db.rpc('bump_activity', delta)]);
  } catch (err) {
    loadedAt = 0; // what's in memory may not match the database now: reload next time
    throw err;
  }
  return result;
}

const uid = () => db?.user?.id;
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

async function createCheatsheet(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'notes';
  const nums = cheatsheets().map((c) => parseInt(c.id, 10)).filter((n) => !Number.isNaN(n));
  const id = `${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')}-${slug}`;
  const markdown = `# ${title}\n\n## First note\nOne line about what it is.\n`;
  await commit(() => store.newCheats.push({ id, markdown }), () => [cloud.cheatRows(uid(), id, markdown, true)]);
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
    if (db && Date.now() - loadedAt > RELOAD_AFTER_MS) await loadFromCloud();
    return { tracks: data.tracks, days: data.days.map(dayMeta), progress: store.progress, summaries: summaries() };
  }

  if (resource === 'days' && parts[1]) {
    const id = parts[1];
    const day = data.days.find((d) => d.id === id);
    if (!day) throw notFound('Day');
    const action = parts[2];
    if (!action) return { ...day, answers: docOf(id), file: db ? 'your account' : 'saved in this browser' };
    if (action === 'answers' && method === 'PUT') {
      await commit(
        () => (store.answers[id] = shared.saveAnswers(store.progress, docOf(id), body.answers)),
        () => [cloud.answerRows(uid(), id, store.answers[id], Object.keys(body.answers || {}))],
      );
      return { answers: store.answers[id], progress: store.progress };
    }
    if (action === 'feedback' && method === 'PUT') {
      const oldScored = Object.keys(docOf(id).scores); // scores that disappear get set back to null
      await commit(
        () => (store.answers[id] = shared.saveFeedback(store.progress, docOf(id), body)),
        () => {
          const doc = store.answers[id];
          const qids = [...new Set([...oldScored, ...Object.keys(doc.scores), ...Object.keys(doc.answers)])];
          return [cloud.answerRows(uid(), id, doc, qids), cloud.feedbackRows(uid(), id, doc)];
        },
      );
      return { answers: store.answers[id], progress: store.progress };
    }
    if (action === 'notes' && method === 'PUT') {
      await commit(
        () => (store.answers[id] = shared.saveNotes(docOf(id), body)),
        () => [cloud.noteRows(uid(), id, store.answers[id])],
      );
      return { answers: store.answers[id] };
    }
  }

  if (resource === 'recall') {
    return data.days
      .filter((d) => store.progress.days[d.id]?.done)
      .flatMap((d) => d.questions.map((q) => ({ key: `${d.id}#${q.id}`, dayId: d.id, dayNumber: d.number, dayTitle: d.title, track: d.track, question: q })));
  }

  if (resource === 'progress' && method === 'POST') {
    await commit(
      () => shared.applyProgress(store.progress, body),
      () => {
        if (body.type === 'day') return [cloud.dayRows(uid(), store.progress, [body.id])];
        if (body.type === 'recall') return [cloud.recallRows(uid(), store.progress, [body.id])];
        return [cloud.profileRows(uid(), store.progress)];
      },
    );
    return store.progress;
  }

  if (resource === 'cheatsheets') {
    if (!parts[1] && method === 'GET') return cheatsheets();
    if (!parts[1] && method === 'POST') return { id: await createCheatsheet(String(body.title).trim().slice(0, 60)) };
    if (parts[1] && method === 'PUT') {
      const sid = parts[1];
      const extra = store.newCheats.find((c) => c.id === sid);
      if (!extra && !data.cheatsheets.some((c) => c.id === sid)) throw notFound('Cheat sheet');
      await commit(
        () => (extra ? (extra.markdown = body.markdown) : (store.cheats[sid] = body.markdown)),
        () => [cloud.cheatRows(uid(), sid, body.markdown, !!extra)],
      );
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
  store = fromSaved(obj);
  if (db) await cloud.saveStore(db, uid(), store);
  else persist();
}
