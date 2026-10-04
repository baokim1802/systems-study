// Files on disk: data/progress.json (your tracker) and answers/<day-id>.json (your answers + feedback).
// The rules for changing them live in app/shared.js so the website can use the same ones.

const fs = require('fs');
const path = require('path');
const { ROOT, dayDir } = require('./catalog');

const PROGRESS_FILE = path.join(ROOT, 'data', 'progress.json');
const ANSWERS_DIR = path.join(ROOT, 'answers');

let shared = null;
/** app/shared.js is an ES module; load it once before using anything below. */
async function init() {
  shared ||= await import('../app/shared.js');
  return shared;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return data;
}

function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const loadProgress = () => shared.normalizeProgress(readJsonOr(PROGRESS_FILE, {}));
const saveProgress = (data) => writeJson(PROGRESS_FILE, data);

function answersFile(id) {
  if (!dayDir(id)) throw Object.assign(new Error('Day not found'), { status: 404 });
  return path.join(ANSWERS_DIR, `${id}.json`);
}

const loadAnswers = (id) => shared.normalizeAnswers(readJsonOr(answersFile(id), null));
const saveAnswersDoc = (id, doc) => writeJson(answersFile(id), doc);

/** All answer docs that exist, keyed by day id. */
function allAnswers() {
  if (!fs.existsSync(ANSWERS_DIR)) return {};
  const out = {};
  for (const f of fs.readdirSync(ANSWERS_DIR)) {
    if (f.endsWith('.json')) out[f.slice(0, -5)] = readJsonOr(path.join(ANSWERS_DIR, f), null);
  }
  return out;
}

module.exports = { init, PROGRESS_FILE, ANSWERS_DIR, loadProgress, saveProgress, loadAnswers, saveAnswersDoc, allAnswers };
