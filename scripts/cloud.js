// Copy your study data between Supabase and the files on this computer.
//   npm run pull            Supabase -> answers/*.json + data/progress.json (the local app and /grade use these)
//   npm run push            answers/*.json + data/progress.json -> Supabase (adds and overwrites, never deletes)
//   npm run push -- 14      only day 14's answers, feedback and notes (after /grade 14)
//   npm run pull -- logout  forget the saved sign-in
//
// Needs supabase.config.json. Signs in with your email and password the first time
// (or SUPABASE_EMAIL / SUPABASE_PASSWORD) and keeps the session in .supabase-session.json (git ignores it).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const catalog = require('../lib/catalog');
const store = require('../lib/store');

const ROOT = catalog.ROOT;
const SESSION_FILE = path.join(ROOT, '.supabase-session.json');

function readConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase.config.json'), 'utf8')); } catch {}
  const url = process.env.SUPABASE_URL || cfg.url;
  const anonKey = process.env.SUPABASE_ANON_KEY || cfg.anonKey;
  if (!url || !anonKey) fail('Fill in "url" and "anonKey" in supabase.config.json first (Supabase → Project Settings → API).');
  return { url, anonKey };
}

const sessionStorage = {
  load() { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return null; } },
  save(s) {
    if (s) fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    else fs.rmSync(SESSION_FILE, { force: true });
  },
};

async function signIn(db) {
  if (db.user) return db.user;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const lines = rl[Symbol.asyncIterator](); // buffers lines, so piped input works too
  let muted = false;
  rl._writeToOutput = (s) => { if (!muted) process.stdout.write(s); }; // muted: don't echo the password
  const ask = async (question, hidden = false) => {
    process.stdout.write(question);
    muted = hidden;
    const { value = '' } = await lines.next();
    muted = false;
    if (hidden) process.stdout.write('\n');
    return value.trim();
  };
  const email = process.env.SUPABASE_EMAIL || await ask('Email: ');
  const password = process.env.SUPABASE_PASSWORD || await ask('Password: ', true);
  rl.close();
  try {
    const user = await db.signIn(email, password);
    console.log(`🔑 Signed in as ${user.email} (saved in .supabase-session.json)`);
    return user;
  } catch (err) {
    fail(err.status === 400 ? 'Wrong email or password. (Invited with a link only? Choose a password with "Forgot password?" on the website.)' : err.message);
  }
}

function fail(msg) {
  console.error('🥺 ' + msg);
  process.exit(1);
}

async function pull(db, cloud) {
  const { store: s } = await cloud.loadStore(db);
  store.saveProgress(s.progress);
  let n = 0;
  for (const [id, doc] of Object.entries(s.answers)) {
    if (!catalog.dayDir(id)) { console.warn(`   skipped ${id}: no such day in days/`); continue; }
    store.saveAnswersDoc(id, doc);
    n++;
  }
  console.log(`⬇️  Pulled your progress and ${n} day(s) of answers into answers/ and data/progress.json`);
}

async function pushAll(db, cloud, uid) {
  const local = { progress: store.loadProgress(), answers: store.allAnswers() };
  await cloud.saveStore(db, uid, local, { cheats: false }); // cheat sheets are files in cheatsheets/ locally
  console.log(`⬆️  Pushed your progress and ${Object.keys(local.answers).length} day(s) of answers to Supabase`);
}

async function pushDay(db, cloud, shared, uid, query) {
  const meta = catalog.findDay(query);
  if (!meta) fail(`No day matches "${query}".`);
  const doc = store.loadAnswers(meta.id);
  const [before] = await db.select('day_feedback', `select=graded_at&day_id=eq.${encodeURIComponent(meta.id)}`);
  await cloud.writeRows(db, cloud.docRows(uid, meta.id, doc));
  // graded for the first time: count it in today's activity, like the app does
  if (doc.gradedAt && !before?.graded_at) await db.rpc('bump_activity', cloud.activityDelta(shared.today(), {}, { graded: 1 }));
  console.log(`⬆️  Pushed day ${meta.id}: answers${doc.gradedAt ? ', feedback and scores' : ''}${doc.notes ? ', notes' : ''}`);
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  const shared = await store.init();
  const { createClient } = await import('../app/supa.js');
  const cloud = await import('../app/cloud.js');
  const db = createClient({ ...readConfig(), storage: sessionStorage });

  if (arg === 'logout') {
    await db.signOut();
    return console.log('👋 Signed out');
  }
  const { id: uid } = await signIn(db);
  try {
    if (cmd === 'pull') await pull(db, cloud);
    else if (cmd === 'push' && arg) await pushDay(db, cloud, shared, uid, arg);
    else if (cmd === 'push') await pushAll(db, cloud, uid);
    else fail('Use: npm run pull | npm run push [-- <day>]');
  } catch (err) {
    fail(err.status === 401 ? `${err.message} Run the command again to sign in.` : err.message);
  }
})();
