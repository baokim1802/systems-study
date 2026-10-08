// Your study data in Supabase (tables: supabase/schema.sql).
// The app works with one in-memory `store`, the same shape it keeps in localStorage and on disk:
//   { progress, answers: { dayId: doc }, cheats: { id: markdown }, newCheats: [{ id, markdown }] }
// This file turns that store into table rows and back. Used by static-api.js and scripts/cloud.js.
import { normalizeProgress, normalizeAnswers } from './shared.js';

export const TABLES = ['profiles', 'day_progress', 'answers', 'day_feedback', 'notes', 'recall_cards', 'activity', 'cheatsheets'];
export const COUNTERS = ['days', 'answers', 'graded', 'reviews'];

const nullIfEmpty = (v) => v || null;
const dropNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

/** Read every table. Returns the store and how many rows there were (0 = a brand-new account). */
export async function loadStore(db) {
  const [profiles, days, answers, feedback, notes, recall, activity, cheats] = await Promise.all(TABLES.map((t) => db.select(t)));
  const rowCount = [profiles, days, answers, feedback, notes, recall, activity, cheats].reduce((n, r) => n + r.length, 0);

  const p = profiles[0];
  const progress = normalizeProgress(p ? {
    name: p.name,
    goals: { daysPerWeek: p.days_per_week, targetDate: p.target_date || '', targetLabel: p.target_label, custom: p.custom_goals || [] },
  } : {});
  for (const r of days) progress.days[r.day_id] = dropNulls({ done: r.done, doneAt: r.done_at, readAt: r.read_at });
  for (const r of recall) progress.recall[r.card_id] = dropNulls({ box: r.box, due: r.due, last: r.last });
  for (const r of activity) progress.activity[r.day] = { days: r.days, answers: r.answers, graded: r.graded, reviews: r.reviews };

  const docs = {};
  const doc = (id) => (docs[id] ||= normalizeAnswers());
  for (const r of answers) {
    const d = doc(r.day_id);
    d.answers[r.question_id] = r.answer;
    if (r.score != null) d.scores[r.question_id] = Number(r.score);
    if (r.updated_at && (!d.updatedAt || r.updated_at > d.updatedAt)) d.updatedAt = r.updated_at;
  }
  for (const r of feedback) Object.assign(doc(r.day_id), { feedback: r.feedback, gradedAt: r.graded_at });
  for (const r of notes) Object.assign(doc(r.day_id), { notes: r.body, notesMarkdown: r.markdown, notesUpdatedAt: r.updated_at });

  const store = { progress, answers: docs, cheats: {}, newCheats: [] };
  for (const r of cheats) {
    if (r.is_new) store.newCheats.push({ id: r.sheet_id, markdown: r.markdown });
    else store.cheats[r.sheet_id] = r.markdown;
  }
  return { store, rowCount };
}

// ---------- store -> rows ----------
// Each builder returns [table, rows] for db.upsert. `uid` is the signed-in user's id.

export function profileRows(uid, prog) {
  const g = prog.goals || {};
  return ['profiles', [{
    user_id: uid,
    name: prog.name || '',
    days_per_week: Math.max(0, Math.min(7, Math.round(Number(g.daysPerWeek) || 0))),
    target_date: nullIfEmpty(g.targetDate),
    target_label: g.targetLabel || '',
    custom_goals: g.custom || [],
    updated_at: new Date().toISOString(),
  }]];
}

export function dayRows(uid, prog, ids = Object.keys(prog.days)) {
  return ['day_progress', ids.map((id) => {
    const d = prog.days[id] || {};
    return { user_id: uid, day_id: id, done: !!d.done, done_at: nullIfEmpty(d.doneAt), read_at: nullIfEmpty(d.readAt) };
  })];
}

export function recallRows(uid, prog, ids = Object.keys(prog.recall)) {
  return ['recall_cards', ids.map((id) => {
    const r = prog.recall[id] || {};
    return { user_id: uid, card_id: id, box: r.box || 0, due: nullIfEmpty(r.due), last: nullIfEmpty(r.last) };
  })];
}

/** Absolute counts. Day-to-day changes go through bump_activity instead (see activityDelta). */
export function activityRows(uid, prog) {
  return ['activity', Object.entries(prog.activity).map(([day, a]) => ({
    user_id: uid, day, days: a.days || 0, answers: a.answers || 0, graded: a.graded || 0, reviews: a.reviews || 0,
  }))];
}

/** One row per question. Pass `qids` to write only some; by default every question with an answer or a score. */
export function answerRows(uid, dayId, doc, qids) {
  qids ||= [...new Set([...Object.keys(doc.answers || {}), ...Object.keys(doc.scores || {})])];
  return ['answers', qids.map((q) => ({
    user_id: uid,
    day_id: dayId,
    question_id: q,
    answer: doc.answers?.[q] ?? '',
    score: doc.scores?.[q] ?? null,
    updated_at: doc.updatedAt || null,
  }))];
}

export function feedbackRows(uid, dayId, doc) {
  return ['day_feedback', [{ user_id: uid, day_id: dayId, feedback: doc.feedback || '', graded_at: doc.gradedAt || null }]];
}

export function noteRows(uid, dayId, doc) {
  return ['notes', [{ user_id: uid, day_id: dayId, body: doc.notes || '', markdown: doc.notesMarkdown !== false, updated_at: doc.notesUpdatedAt || null }]];
}

export function cheatRows(uid, id, markdown, isNew) {
  return ['cheatsheets', [{ user_id: uid, sheet_id: id, markdown, is_new: !!isNew, updated_at: new Date().toISOString() }]];
}

/** Every row for one day's answer doc (answers, feedback, notes), skipping the parts that are empty. */
export function docRows(uid, dayId, doc) {
  doc = normalizeAnswers(doc);
  const out = [answerRows(uid, dayId, doc)];
  if (doc.feedback || doc.gradedAt) out.push(feedbackRows(uid, dayId, doc));
  if (doc.notes || doc.notesUpdatedAt) out.push(noteRows(uid, dayId, doc));
  return out;
}

/** Write rows grouped by table: [[table, rows], …]. */
export async function writeRows(db, groups) {
  const byTable = {};
  for (const [table, rows] of groups) (byTable[table] ||= []).push(...rows);
  await Promise.all(Object.entries(byTable).map(([table, rows]) => db.upsert(table, rows)));
}

/** Upload a whole store (first sign-in, restoring a backup, `npm run push`). Adds and overwrites; never deletes. */
export async function saveStore(db, uid, store, { cheats = true } = {}) {
  const prog = normalizeProgress(store.progress);
  const groups = [profileRows(uid, prog), dayRows(uid, prog), recallRows(uid, prog), activityRows(uid, prog)];
  for (const [id, doc] of Object.entries(store.answers || {})) if (doc) groups.push(...docRows(uid, id, doc));
  if (cheats) {
    for (const [id, md] of Object.entries(store.cheats || {})) groups.push(cheatRows(uid, id, md, false));
    for (const c of store.newCheats || []) groups.push(cheatRows(uid, c.id, c.markdown, true));
  }
  await writeRows(db, groups);
}

/** How a day's counters changed between two snapshots, as bump_activity arguments (null if nothing changed). */
export function activityDelta(day, before = {}, after = {}) {
  const args = { p_day: day };
  let changed = false;
  for (const k of COUNTERS) {
    args[`p_${k}`] = (after[k] || 0) - (before[k] || 0);
    if (args[`p_${k}`]) changed = true;
  }
  return changed ? args : null;
}
