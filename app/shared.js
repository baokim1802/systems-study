// Rules shared by the Node server (server.js loads this with import()) and the static website
// (static-api.js): progress, answers, scores, spaced-recall scheduling and the AI grading prompt.

export const DEFAULT_PROGRESS = {
  name: '',
  days: {}, // id -> { done, doneAt, readAt }
  activity: {}, // 'YYYY-MM-DD' -> { days, answers, graded, reviews }
  recall: {}, // 'dayId#q1' -> { box, due, last }
  goals: {
    daysPerWeek: 5,
    targetDate: '',
    targetLabel: 'Interview ready 💼',
    custom: [], // { id, text, done }
  },
};

export function today(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(day, n) {
  const d = new Date(day + 'T00:00');
  d.setDate(d.getDate() + n);
  return today(d);
}

export function normalizeProgress(p = {}) {
  const out = { ...structuredClone(DEFAULT_PROGRESS), ...p, goals: { ...DEFAULT_PROGRESS.goals, ...(p.goals || {}) } };
  for (const k of ['days', 'activity', 'recall']) out[k] ||= {};
  return out;
}

export function bump(prog, key, n = 1) {
  const a = (prog.activity[today()] ||= { days: 0, answers: 0, graded: 0, reviews: 0 });
  a[key] = (a[key] || 0) + n;
}

// ---------- progress changes ----------
// Spaced recall: after a "got it" a card comes back after INTERVALS[box] days.
export const INTERVALS = [0, 1, 3, 7, 14, 30, 60];

export function applyProgress(prog, { type, id, patch = {} }) {
  if (type === 'day') {
    const d = (prog.days[id] ||= { done: false });
    if ('done' in patch) {
      if (patch.done && !d.done) {
        d.doneAt = today();
        bump(prog, 'days');
      }
      d.done = !!patch.done;
    }
    if (patch.read && !d.readAt) d.readAt = today();
  } else if (type === 'recall') {
    const r = (prog.recall[id] ||= { box: 0 });
    r.box = patch.result === 'good' ? Math.min((r.box || 0) + 1, INTERVALS.length - 1) : 1;
    r.due = addDays(today(), patch.result === 'good' ? INTERVALS[r.box] : 1);
    r.last = today();
    bump(prog, 'reviews');
  } else if (type === 'goals') {
    prog.goals = { ...prog.goals, ...patch };
  } else if (type === 'profile') {
    if ('name' in patch) prog.name = String(patch.name).slice(0, 40);
  }
  return prog;
}

// ---------- answers ----------
// One answer doc per day: answers/<day-id>.json on disk, or localStorage on the website.
export const emptyAnswers = () => ({ answers: {}, scores: {}, feedback: '', updatedAt: null, gradedAt: null, notes: '', notesMarkdown: true, notesUpdatedAt: null });

export function normalizeAnswers(doc) {
  return { ...emptyAnswers(), ...(doc || {}) };
}

/** Merge new answer text into the doc. Counts questions answered for the first time today. */
export function saveAnswers(prog, doc, answers) {
  let fresh = 0;
  for (const [q, text] of Object.entries(answers || {})) {
    if (typeof text !== 'string') continue;
    if (text.trim() && !(doc.answers[q] || '').trim()) fresh++;
    doc.answers[q] = text;
  }
  if (fresh) bump(prog, 'answers', fresh);
  doc.updatedAt = new Date().toISOString();
  return doc;
}

/** Your own notes for a day. `markdown` picks rendered markdown or plain text (so a # can stay a #). */
export function saveNotes(doc, { notes, markdown } = {}) {
  if (typeof notes === 'string') doc.notes = notes;
  if (typeof markdown === 'boolean') doc.notesMarkdown = markdown;
  doc.notesUpdatedAt = new Date().toISOString();
  return doc;
}

/** Store feedback. Scores come from `scores`, or are read from a "SCORES: q1=7, q2=5" line in the text. */
export function saveFeedback(prog, doc, { feedback = '', scores } = {}) {
  const parsed = scores && Object.keys(scores).length ? scores : parseScores(feedback);
  if (!doc.gradedAt && (feedback.trim() || Object.keys(parsed).length)) bump(prog, 'graded');
  doc.feedback = feedback;
  doc.scores = cleanScores(parsed);
  doc.gradedAt = new Date().toISOString();
  return doc;
}

function cleanScores(scores) {
  const out = {};
  for (const [k, v] of Object.entries(scores || {})) {
    const n = Number(v);
    if (/^q\d+$/.test(k) && Number.isFinite(n)) out[k] = Math.max(0, Math.min(10, Math.round(n * 2) / 2));
  }
  return out;
}

export function parseScores(text = '') {
  const lines = text.match(/^.*SCORES?\s*[:=].*$/gim);
  if (!lines) return {};
  const out = {};
  for (const m of lines[lines.length - 1].matchAll(/q(\d+)\s*[=:]\s*(\d+(?:\.\d+)?)/gi)) out[`q${m[1]}`] = Number(m[2]);
  return cleanScores(out);
}

/** Short summary for lists: how many answered, average score. */
export function answerSummary(doc, questionCount) {
  if (!doc) return { answered: 0, graded: false, avg: null };
  const answered = Object.values(doc.answers || {}).filter((t) => String(t).trim()).length;
  const vals = Object.values(doc.scores || {});
  return {
    answered,
    total: questionCount,
    graded: !!doc.gradedAt,
    avg: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null,
  };
}

// ---------- the grading prompt ----------
const TRACK_TITLES = {
  foundations: 'How a computer works', networking: 'Networking', data: 'Data & databases', scale: 'Building blocks of scale',
  distributed: 'Distributed systems', production: 'Production: security, ops & cloud', design: 'Design case studies',
};

/**
 * The text you paste into any AI to get your answers graded.
 * `onlyIds` limits it to some questions (e.g. one card in Recall).
 */
export function buildPrompt(day, doc, { onlyIds } = {}) {
  const qs = day.questions.filter((q) => !onlyIds || onlyIds.includes(q.id));
  const out = [];
  out.push(
    'You are a friendly but rigorous system design interviewer and computer science tutor. Grade my answers to today\'s study questions.',
    '',
    `Topic: Day ${day.number} — ${day.title} (track: ${TRACK_TITLES[day.track] || day.track})`,
    "About me: I'm a beginner learning computer science and system design from scratch, preparing for software engineering interviews.",
    '',
    'For each question:',
    '1. Give a score from 0 to 10 (10 = what a strong candidate would say in a real interview).',
    '2. Say briefly what I got right.',
    '3. Say what is missing or wrong. Use the reference key points as a checklist, but accept correct answers worded differently, and give credit for correct ideas that are not on the list.',
    '4. Show a short model answer (3–6 sentences, or the corrected math/code).',
    '5. Ask one follow-up question an interviewer might ask next.',
    '',
    'Then finish with the single most important thing I should review.',
    'Be honest and don\'t inflate scores. If an answer is empty, score it 0 and just teach it to me.',
    '',
    'Format: write the feedback in Markdown (a `### Q1 · 7/10` heading per question, **bold**, lists, tables, ``` code blocks).',
    'Put ALL of it inside ONE code block that opens with ````markdown and closes with ```` (four backticks), with nothing outside it, so I can copy it into my study app without losing any formatting.',
    `The very last line inside that block must be exactly in this format: SCORES: ${qs.map((q) => `${q.id}=<0-10>`).join(', ')}`,
  );
  for (const q of qs) {
    const answer = (doc.answers[q.id] || '').trim();
    out.push(
      '',
      '---',
      '',
      `## ${q.id.toUpperCase()} (${q.kind} · ${q.level})`,
      '',
      q.prompt.trim(),
      '',
      'Reference key points (for grading):',
      ...(q.keyPoints || []).map((k) => `- ${k}`),
      ...(q.answer ? ['', 'Reference answer:', q.answer.trim()] : []),
      '',
      'My answer:',
      answer || '(no answer)',
    );
  }
  return out.join('\n') + '\n';
}
