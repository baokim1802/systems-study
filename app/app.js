import { renderMarkdown } from './md.js';
import { initCheatsheet, toggleCheatsheet } from './cheatsheet.js';
import { api, STATIC, staticBackend } from './api.js';
import { buildPrompt, answerSummary, parseScores, INTERVALS } from './shared.js';

// ---------- state & helpers ----------
const state = { tracks: [], days: [], progress: null, summaries: {}, recallDue: null };
const $main = document.getElementById('main');
const $side = document.getElementById('sidebar');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function refresh() {
  Object.assign(state, await api('state'));
}

async function saveProgress(type, id, patch) {
  state.progress = await api('progress', { method: 'POST', body: { type, id, patch } });
  renderSidebar();
}

function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function celebrate() {
  const emojis = ['💙', '🩵', '🫧', '✨', '☁️', '⭐', '🐳'];
  for (let i = 0; i < 36; i++) {
    const el = document.createElement('div');
    el.className = 'heart';
    el.textContent = emojis[i % emojis.length];
    el.style.left = `${window.innerWidth / 2}px`;
    el.style.top = `${window.innerHeight / 2}px`;
    const angle = Math.random() * Math.PI * 2;
    const dist = 140 + Math.random() * 260;
    el.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    el.style.setProperty('--dy', `${Math.sin(angle) * dist - 60}px`);
    el.style.setProperty('--rot', `${Math.random() * 120 - 60}deg`);
    el.style.animationDelay = `${Math.random() * 0.15}s`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1900);
  }
}

async function copyText(text, msg = 'Copied 📋') {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    // clipboard blocked (e.g. not https): show it so it can be copied by hand
    const box = document.createElement('textarea');
    box.value = text;
    box.className = 'copy-fallback';
    document.body.appendChild(box);
    box.select();
    document.execCommand('copy');
    box.remove();
    toast(msg);
  }
}

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const pad2 = (n) => String(n).padStart(2, '0');

const QUOTES = [
  'Every expert was once a beginner. 🌱',
  'Understand it once, and you never have to memorize it. 💡',
  "There's no magic in computers — just layers you haven't opened yet. 🫧",
  'Small steps every day add up to big wins. 🌸',
  'Explaining it out loud is how you find what you don\'t know yet. 🗣️',
  'Good engineers ask "what happens when this fails?" 🛠️',
  'Every system is a trade-off. Name it and you sound senior. ⚖️',
  "Be proud of how far you've come. 💙",
  'Future you is already grateful. 💌',
  'Curiosity is the whole job. ✨',
];
const quoteOfTheDay = () => QUOTES[Math.floor(Date.now() / 864e5) % QUOTES.length];

const KIND = {
  concept: { icon: '💭', label: 'concept' },
  scenario: { icon: '🎬', label: 'scenario' },
  math: { icon: '🧮', label: 'math' },
  code: { icon: '💻', label: 'code' },
  design: { icon: '🏗️', label: 'design' },
};

const trackOf = (id) => state.tracks.find((t) => t.id === id) || { id, icon: '📘', title: id };
const dayProg = (id) => state.progress.days[id] || {};
const dayDone = (id) => !!dayProg(id).done;
const summaryOf = (id) => state.summaries[id] || { answered: 0, graded: false, avg: null };
const nextDay = () => state.days.find((d) => !dayDone(d.id));
const scoreClass = (s) => (s == null ? '' : s >= 8 ? 'great' : s >= 5 ? 'ok' : 'low');

function dayIcon(d) {
  if (dayDone(d.id)) return '💙';
  const s = summaryOf(d.id);
  if (s.graded) return '🤖';
  if (s.answered) return '✍️';
  if (dayProg(d.id).readAt) return '📖';
  return '○';
}

function trackStats(trackId) {
  const ds = state.days.filter((d) => d.track === trackId);
  const scores = ds.map((d) => summaryOf(d.id).avg).filter((x) => x != null);
  return {
    total: ds.length,
    done: ds.filter((d) => dayDone(d.id)).length,
    avg: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
  };
}

function stats() {
  const act = state.progress.activity;
  const active = (k) => { const a = act[k]; return a && (a.days || a.answers || a.graded || a.reviews); };
  let streak = 0;
  let d = new Date();
  if (!active(dayKey(d))) d = addDays(d, -1);
  while (active(dayKey(d))) { streak++; d = addDays(d, -1); }
  const monday = addDays(new Date(), -((new Date().getDay() + 6) % 7));
  let weekDone = 0;
  for (let i = 0; i < 7; i++) weekDone += act[dayKey(addDays(monday, i))]?.days || 0;
  const sums = Object.values(state.summaries);
  const scores = sums.map((s) => s.avg).filter((x) => x != null);
  return {
    streak, monday, weekDone,
    done: state.days.filter((x) => dayDone(x.id)).length,
    total: state.days.length,
    answered: sums.reduce((n, s) => n + (s.answered || 0), 0),
    avg: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
  };
}

async function loadRecallDue() {
  try {
    const cards = await api('recall');
    const t = dayKey();
    state.recallCards = cards;
    state.recallDue = cards.filter((c) => !state.progress.recall[c.key] || state.progress.recall[c.key].due <= t);
  } catch {
    state.recallDue = null;
  }
}

// ---------- theme ----------
const theme = () => document.documentElement.dataset.theme || 'light';
function toggleTheme() {
  const next = theme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sys:theme', next); } catch {}
  renderSidebar();
}

// ---------- sidebar ----------
function renderSidebar() {
  const route = location.hash || '#/';
  const prevScroll = $side.querySelector('.roadmap')?.scrollTop || 0;
  const s = stats();
  const due = state.recallDue?.length;
  const nav = [
    ['#/', '🏠', 'Home', `🔥 ${s.streak}`],
    ['#/days', '📚', 'Curriculum', `${s.done}/${s.total}`],
    ['#/recall', '🧠', 'Recall', due ? `${due} due` : ''],
    ['#/goals', '🎯', 'Goals & Tracker', ''],
  ];
  const isActive = (href) => (href === '#/' ? route === '#/' || route === '#' : route === href || route.startsWith(href + '/'));
  let lastTrack = null;
  $side.innerHTML = `
    <div class="row brand-row">
      <a class="brand" href="#/"><span class="bow">🫧</span><span><b>Systems Study</b><small>CS &amp; system design</small></span></a>
      <button class="theme-toggle" id="theme" title="Switch to ${theme() === 'dark' ? 'light' : 'dark'} mode">${theme() === 'dark' ? '☀️' : '🌙'}</button>
    </div>
    <nav class="nav">
      ${nav.map(([href, ico, label, count]) => `<a href="${href}" class="${isActive(href) ? 'active' : ''}"><span>${ico}</span>${label}<span class="count">${count}</span></a>`).join('')}
      <a href="#" id="nav-cs"><span>📝</span>Cheat sheet<span class="count"><kbd>Ctrl</kbd>+<kbd>/</kbd></span></a>
    </nav>
    <div class="roadmap-wrap">
      <div class="side-title">Roadmap</div>
      <div class="roadmap">
        ${state.days.map((d) => {
          const head = d.track !== lastTrack ? `<div class="road-track">${trackOf(d.track).icon} ${esc(trackOf(d.track).title)}</div>` : '';
          lastTrack = d.track;
          const active = route.startsWith(`#/days/${d.id}`);
          const sc = summaryOf(d.id).avg;
          return `${head}<a href="#/days/${d.id}" class="${active ? 'active' : ''}">
            <span class="dot">${dayDone(d.id) ? '💙' : pad2(d.number)}</span>
            <span title="${esc(d.title)}">${esc(d.title)}</span>
            ${sc != null ? `<span class="mini">${sc}</span>` : ''}
          </a>`;
        }).join('')}
      </div>
    </div>
    ${STATIC
      ? `<div class="row sync-btn backup-row">
          <button class="btn small" id="backup" title="Download your answers, feedback and progress as a file">⬇️ Backup</button>
          <button class="btn small" id="restore" title="Load a backup file">⬆️ Restore</button>
          <input type="file" id="restore-file" accept=".json,application/json" hidden>
        </div>`
      : '<button class="btn sync-btn" id="sync" title="Commit & push your answers, feedback and progress">☁️ Save to GitHub</button>'}
`;
  const roadmap = $side.querySelector('.roadmap');
  roadmap.scrollTop = prevScroll;
  const active = roadmap.querySelector('a.active');
  if (active) {
    const top = active.offsetTop, bottom = top + active.offsetHeight;
    if (top < roadmap.scrollTop) roadmap.scrollTop = top - 30;
    else if (bottom > roadmap.scrollTop + roadmap.clientHeight) roadmap.scrollTop = bottom - roadmap.clientHeight + 24;
  }
  if (STATIC) wireBackup();
  else document.getElementById('sync').addEventListener('click', syncToGitHub);
  document.getElementById('theme').addEventListener('click', toggleTheme);
  document.getElementById('nav-cs').addEventListener('click', (e) => { e.preventDefault(); toggleCheatsheet(); });
}

function wireBackup() {
  document.getElementById('backup').addEventListener('click', async () => {
    await current?.flush?.();
    (await staticBackend()).exportBackup();
    toast('Backup downloaded 💾');
  });
  const file = document.getElementById('restore-file');
  document.getElementById('restore').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (!confirm(`Replace the work saved in this browser with "${f.name}"?`)) { file.value = ''; return; }
    try {
      await (await staticBackend()).importBackup(await f.text());
      toast('Restored 🌸');
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      toast('🥺 ' + err.message);
    }
    file.value = '';
  });
}

async function syncToGitHub(e) {
  const btn = e.currentTarget;
  await current?.flush?.();
  btn.disabled = true;
  btn.textContent = '⏳ Saving…';
  try {
    const r = await api('sync', { method: 'POST' });
    toast(r.message, 3500);
    if (!r.ok) console.warn(r.message);
  } catch (err) {
    toast('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '☁️ Save to GitHub';
  }
}

// ---------- shared widgets ----------
function ring(value, max, label) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const pct = max ? Math.min(value / max, 1) : 0;
  return `<div class="ring">
    <svg width="120" height="120" viewBox="0 0 120 120">
      <defs><linearGradient id="rg" x1="0" x2="1"><stop offset="0" style="stop-color:var(--pink-300)"/><stop offset="1" style="stop-color:var(--pink-500)"/></linearGradient></defs>
      <circle cx="60" cy="60" r="${r}" fill="none" style="stroke:var(--pink-100)" stroke-width="12"/>
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="url(#rg)" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" style="transition: stroke-dashoffset .8s"/>
    </svg>
    <div class="center"><div><b>${value}/${max}</b><small>${label}</small></div></div>
  </div>`;
}

function heatmap(weeks = 20) {
  weeks -= 1;
  const act = state.progress.activity;
  const today = new Date();
  const start = addDays(today, -(weeks * 7 - 1) - today.getDay()); // align to Sunday
  let html = '<div class="heatmap">';
  for (let w = 0; w <= weeks; w++) {
    html += '<div class="col">';
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      const k = dayKey(date);
      if (date > today) { html += '<div class="cell future"></div>'; continue; }
      const a = act[k] || {};
      const score = (a.days || 0) * 3 + (a.graded || 0) * 2 + (a.answers ? 1 : 0) + (a.reviews ? 1 : 0);
      const lvl = score === 0 ? 0 : score <= 1 ? 1 : score <= 3 ? 2 : score <= 5 ? 3 : 4;
      const tip = `${k}: ${a.days || 0} days finished, ${a.answers || 0} answers, ${a.graded || 0} graded, ${a.reviews || 0} recall cards`;
      html += `<div class="cell l${lvl} ${k === dayKey() ? 'today' : ''}" title="${tip}"></div>`;
    }
    html += '</div>';
  }
  html += '</div><div class="legend">less <span class="cell"></span><span class="cell l1"></span><span class="cell l2"></span><span class="cell l3"></span><span class="cell l4"></span> more</div>';
  return html;
}

function weekBars(s) {
  const act = state.progress.activity;
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const vals = names.map((_, i) => {
    const a = act[dayKey(addDays(s.monday, i))] || {};
    return { done: a.days || 0, active: !!(a.days || a.answers || a.graded || a.reviews) };
  });
  return `<div class="week">${names.map((name, i) => {
    const k = dayKey(addDays(s.monday, i));
    const v = vals[i];
    const h = v.done ? 80 : v.active ? 30 : 0;
    return `<div class="bar ${v.done ? 'hit' : ''} ${k === dayKey() ? 'is-today' : ''}" title="${v.done} day${v.done === 1 ? '' : 's'} finished${v.active && !v.done ? ' (studied)' : ''}">
      <b>${v.done || ''}</b><span style="height:${h}%"></span>${name}</div>`;
  }).join('')}</div>`;
}

function scorePill(avg) {
  return avg == null ? '' : `<span class="score ${scoreClass(avg)}" title="Average AI score">${avg}/10</span>`;
}

function dayRow(d) {
  const s = summaryOf(d.id);
  return `<a class="prow day-row" href="#/days/${d.id}">
    <span class="ic">${dayIcon(d)}</span>
    <span class="title"><span class="daynum">Day ${pad2(d.number)}</span>${esc(d.title)}</span>
    <span class="att">${s.answered ? `${s.answered}/${d.questionCount} answered` : `${d.questionCount} questions`}</span>
    <span class="att">${d.minutes} min</span>
    <span>${scorePill(s.avg)}</span>
  </a>`;
}

// ---------- views ----------
function viewHome() {
  const s = stats();
  const g = state.progress.goals;
  const name = state.progress.name;
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const day = nextDay();
  const doneToday = state.progress.activity[dayKey()]?.days || 0;
  const due = state.recallDue?.length || 0;
  const daysLeft = g.targetDate ? Math.ceil((new Date(g.targetDate + 'T00:00') - new Date(dayKey() + 'T00:00')) / 864e5) : null;

  let cheer = "Today's lesson is waiting for you. One topic, a few questions, that's it.";
  if (doneToday) cheer = "You finished today's lesson. Your brain thanks you 💙";
  else if (day && summaryOf(day.id).answered) cheer = `You're partway through Day ${day.number}. Let's finish it!`;
  else if (s.streak > 0) cheer = `You're on a ${s.streak}-day streak. Keep it glowing ✨`;

  return `
    <section class="hero">
      <span class="floaty" style="right:40px;top:18px">🫧</span>
      <span class="floaty" style="right:110px;top:70px;animation-delay:1.5s;font-size:22px">✨</span>
      <span class="floaty" style="right:30px;bottom:14px;animation-delay:3s;font-size:24px">💙</span>
      <h1>${hello}${name ? `, ${esc(name)}` : ''}! 🌷</h1>
      <p>${cheer}</p>
      <div class="quote">“${esc(quoteOfTheDay())}”</div>
    </section>

    <div class="grid stats">
      <div class="card stat"><div class="ico">🔥</div><div><div class="num">${s.streak}</div><div class="lbl">day streak</div></div></div>
      <div class="card stat"><div class="ico">💙</div><div><div class="num">${s.done}<span class="faint" style="font-size:16px">/${s.total}</span></div><div class="lbl">days finished</div></div></div>
      <div class="card stat"><div class="ico">✍️</div><div><div class="num">${s.answered}</div><div class="lbl">questions answered</div></div></div>
      <div class="card stat"><div class="ico">🤖</div><div><div class="num">${s.avg ?? '—'}</div><div class="lbl">average score /10</div></div></div>
    </div>

    <div class="grid home-grid">
      <div class="grid">
        ${day ? todayCard(day) : `<div class="card"><div class="empty"><div class="big">🏆</div>You finished every day! Do the recall cards, redo the case studies, or add your own days (see <code>CONTENT_GUIDE.md</code>).</div></div>`}
        <div class="card">
          <h3>🧠 Recall</h3>
          ${state.recallDue == null ? '<p class="muted">Loading…</p>'
            : !state.recallCards?.length ? '<p class="muted" style="margin:0">Questions from days you finish come back here on a schedule (1, 3, 7, 14, 30 days later), so you remember them for the interview, not just for today.</p>'
            : due ? `<div class="row"><p style="margin:0;flex:1"><b>${due} card${due === 1 ? '' : 's'}</b> ready to review. Answer from memory, then check yourself. A few minutes is enough.</p><a class="btn primary" href="#/recall">Start recall →</a></div>`
            : '<p class="muted" style="margin:0">Nothing due right now 🌙 Come back tomorrow.</p>'}
        </div>
        <div class="card">
          <h3>🌸 Activity</h3>
          ${heatmap()}
        </div>
      </div>
      <div class="grid">
        <div class="card">
          <h3>🎯 This week</h3>
          <div class="row" style="gap:20px">
            ${ring(s.weekDone, Number(g.daysPerWeek) || 1, 'days this week')}
            <div>
              <div class="muted" style="font-size:14px">Goal: ${g.daysPerWeek || 0} days a week</div>
              ${daysLeft != null ? `<div style="font-family:var(--font-head);font-size:20px;font-weight:700;margin-top:6px">${daysLeft} days</div><div class="muted" style="font-size:13px">to ${esc(g.targetLabel || 'your goal')}</div>` : ''}
              <a class="btn small" style="margin-top:12px" href="#/goals">Edit goals</a>
            </div>
          </div>
          ${weekBars(s)}
        </div>
        <div class="card">
          <h3>🗺️ Tracks</h3>
          <div class="topic-bars">
            ${state.tracks.map((t) => {
              const ts = trackStats(t.id);
              if (!ts.total) return '';
              const first = state.days.find((d) => d.track === t.id && !dayDone(d.id)) || state.days.find((d) => d.track === t.id);
              return `<a class="topic-bar" href="#/days/${first.id}"><span class="t">${t.icon} ${esc(t.title)}</span><span class="n">${ts.done}/${ts.total}${ts.avg != null ? ` · ${ts.avg}` : ''}</span><div class="progress"><span style="width:${(ts.done / ts.total) * 100}%"></span></div></a>`;
            }).join('')}
          </div>
        </div>
      </div>
    </div>`;
}

function todayCard(day) {
  const s = summaryOf(day.id);
  const p = dayProg(day.id);
  const t = trackOf(day.track);
  const step = s.graded ? 'feedback' : s.answered ? 'answer' : p.readAt ? 'answer' : 'read';
  const label = s.graded ? 'Review feedback →' : s.answered ? 'Keep answering →' : p.readAt ? 'Answer the questions →' : 'Start reading →';
  return `<a class="card today-card" href="#/days/${day.id}/${step}">
    <div class="today-top"><span class="today-kicker">📅 Today · Day ${day.number}</span><span class="pill tag">${t.icon} ${esc(t.title)}</span></div>
    <h2>${esc(day.title)}</h2>
    <p>${esc(day.summary)}</p>
    <div class="today-steps">
      <span class="${p.readAt ? 'on' : ''}">📖 Read</span>
      <span class="${s.answered ? 'on' : ''}">✍️ Answer ${s.answered}/${day.questionCount}</span>
      <span class="${s.graded ? 'on' : ''}">🤖 Feedback${s.avg != null ? ` ${s.avg}/10` : ''}</span>
      <span>💙 Done</span>
      <span class="spacer"></span>
      <span class="faint">~${day.minutes} min</span>
    </div>
    <span class="btn primary today-go">${label}</span>
  </a>`;
}

function viewCurriculum() {
  const s = stats();
  return `
    <div class="page-head"><div><h1>📚 Curriculum</h1><p>${s.total} days, from bits and bytes to designing whole systems. Each day: read one topic, answer interview questions, get feedback. ${s.done} done so far 💙</p></div></div>
    ${state.tracks.map((t) => {
      const ds = state.days.filter((d) => d.track === t.id);
      if (!ds.length) return '';
      const ts = trackStats(t.id);
      return `<div class="topic-group">
        <h2>${t.icon} ${esc(t.title)}<span class="n">${ts.done}/${ts.total}${ts.avg != null ? ` · avg ${ts.avg}/10` : ''}</span></h2>
        <div class="plist">${ds.map(dayRow).join('')}</div>
      </div>`;
    }).join('')}
    <p class="muted" style="font-size:13.5px">Legend: ○ not started · 📖 read · ✍️ answering · 🤖 got feedback · 💙 finished</p>`;
}

// The day page keeps module-level state so autosave, focus-reload and leaving the page can find it.
let current = null;

async function viewDay(id, tab = 'read') {
  const day = await api(`days/${encodeURIComponent(id)}`);
  if (!['read', 'answer', 'feedback'].includes(tab)) tab = 'read';
  const idx = state.days.findIndex((d) => d.id === id);
  const prev = state.days[idx - 1];
  const next = state.days[idx + 1];
  const t = trackOf(day.track);
  const done = dayDone(id);
  const s = answerSummary(day.answers, day.questions.length);
  const p = dayProg(id);
  current = { id, day, doc: day.answers, tab, pending: null };

  const tabBtn = (key, label) => `<a class="${tab === key ? 'on' : ''}" href="#/days/${id}/${key}">${label}</a>`;
  let body;
  if (tab === 'read') body = readTab(day, next);
  else if (tab === 'answer') body = answerTab(day);
  else body = feedbackTab(day);

  const toc = tab === 'read' ? [...day.lesson.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]) : [];
  const slug = (x) => x.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');

  setTimeout(() => wireDay(day));

  return `
    <div class="lesson-layout">
      <article>
        <div class="day-head">
          <a class="btn ghost small" href="#/days">←</a>
          <span class="today-kicker">Day ${day.number} of ${state.days.length}</span>
          <span class="pill tag">${t.icon} ${esc(t.title)}</span>
          <span class="faint">~${day.minutes} min</span>
        </div>
        <nav class="day-tabs">
          ${tabBtn('read', '📖 Read')}
          ${tabBtn('answer', `✍️ Answer <small>${s.answered}/${day.questions.length}</small>`)}
          ${tabBtn('feedback', `🤖 Feedback${s.avg != null ? ` <small>${s.avg}/10</small>` : ''}`)}
        </nav>
        <div id="day-body">${body}</div>
        <div class="pager">
          ${prev ? `<a class="btn" href="#/days/${prev.id}">← Day ${prev.number}: ${esc(prev.title)}</a>` : '<span></span>'}
          ${next ? `<a class="btn" href="#/days/${next.id}">Day ${next.number}: ${esc(next.title)} →</a>` : '<span></span>'}
        </div>
      </article>
      <aside class="lesson-aside">
        <button id="day-done" class="btn ${done ? '' : 'primary'}" style="justify-content:center">${done ? '💙 Finished — undo?' : '✓ Mark day finished'}</button>
        <div class="card">
          <h3>🪜 Today's steps</h3>
          <div class="steps">
            <a class="${p.readAt ? 'on' : ''}" href="#/days/${id}/read"><span>${p.readAt ? '✅' : '1'}</span>Read the lesson</a>
            <a class="${s.answered === day.questions.length ? 'on' : ''}" href="#/days/${id}/answer"><span>${s.answered === day.questions.length ? '✅' : '2'}</span>Answer ${day.questions.length} questions</a>
            <a class="${s.graded ? 'on' : ''}" href="#/days/${id}/feedback"><span>${s.graded ? '✅' : '3'}</span>Get AI feedback</a>
            <a class="${done ? 'on' : ''}" href="#" id="step-done"><span>${done ? '✅' : '4'}</span>Mark finished</a>
          </div>
        </div>
        <div class="card">
          <h3>🤖 Get graded</h3>
          <button class="btn small copy-prompt" style="width:100%;justify-content:center">📋 Copy prompt for AI</button>
          <p class="faint" style="font-size:12.5px;margin:8px 0 0">Paste it into Claude or any AI, then paste the reply into the 🤖 Feedback tab.${STATIC ? '' : ` Or in Claude Code here, run <code>/grade ${day.number}</code>: it writes the feedback straight into this page.`}</p>
        </div>
        ${toc.length ? `<div class="card toc"><h3>🌷 On this page</h3>${toc.map((x) => `<a href="#" data-target="${slug(x)}">${esc(x.replace(/[`*]/g, ''))}</a>`).join('')}</div>` : ''}
      </aside>
    </div>`;
}

function readTab(day, next) {
  return `<div class="card md lesson-md">${renderMarkdown(day.lesson)}</div>
    <div class="card read-end">
      <div>
        <b>Done reading?</b>
        <div class="muted" style="font-size:14px">Now answer ${day.questions.length} interview questions in your own words. Don't look back at the lesson while you answer — recalling is what makes it stick.</div>
      </div>
      <a class="btn primary" id="to-answer" href="#/days/${day.id}/answer">✍️ Answer the questions →</a>
    </div>`;
}

function answerTab(day) {
  const doc = day.answers;
  return `
    <div class="card answer-intro">
      <b>Answer like you're talking to an interviewer.</b> Your own words, short is fine. Say <i>why</i>, name the trade-offs, use numbers when you can.
      If you don't know, write your best guess: a wrong guess plus feedback teaches more than a blank.
      <div class="faint" style="font-size:12.5px;margin-top:6px">Answers save automatically${STATIC ? ' in this browser' : ` to <code>${esc(day.file)}</code>`}.</div>
    </div>
    ${day.questions.map((q, i) => questionCard(q, i, doc)).join('')}
    <div class="card grade-card">
      <h3>🤖 Ready for feedback?</h3>
      <div class="grade-ways">
        <div>
          <b>Any AI</b>
          <p class="muted">Copy a prompt with your answers and the grading checklist. Paste it into Claude (or another AI). Then paste its reply into the Feedback tab.</p>
          <button class="btn primary copy-prompt">📋 Copy prompt for AI</button>
        </div>
        ${STATIC ? '' : `<div>
          <b>Claude Code</b>
          <p class="muted">In a terminal in this folder (or its parent), ask Claude Code:</p>
          <div class="codeblock"><button class="copy">copy</button><pre><code>/grade ${day.number}</code></pre></div>
          <p class="faint" style="font-size:12.5px;margin:0">It reads your answers file and writes the feedback and scores back. This page picks them up when you switch back to it.</p>
        </div>`}
      </div>
      <a class="btn" href="#/days/${day.id}/feedback" style="margin-top:12px">Go to Feedback →</a>
    </div>`;
}

function questionCard(q, i, doc) {
  const k = KIND[q.kind] || KIND.concept;
  const score = doc.scores?.[q.id];
  return `<div class="card qcard" data-q="${q.id}">
    <div class="qhead">
      <span class="qnum">Q${i + 1}</span>
      <span class="pill kind ${esc(q.kind)}">${k.icon} ${k.label}</span>
      <span class="pill level ${esc(q.level)}">${esc(q.level)}</span>
      <span class="spacer"></span>
      ${score != null ? `<span class="score ${scoreClass(score)}">${score}/10</span>` : ''}
    </div>
    <div class="md qprompt">${renderMarkdown(q.prompt)}</div>
    <textarea class="answer" data-q="${q.id}" placeholder="${q.kind === 'code' ? 'Write code (JavaScript or pseudocode) and explain it…' : q.kind === 'math' ? 'Show your working step by step…' : 'Your answer…'}" spellcheck="true">${esc(doc.answers[q.id] || '')}</textarea>
    <div class="row qtools">
      ${q.hint ? '<button class="btn ghost small" data-toggle="hint">💡 Hint</button>' : ''}
      <button class="btn ghost small" data-toggle="keys">🔑 Key points</button>
      <span class="spacer"></span>
      <span class="saved faint"></span>
    </div>
    ${q.hint ? `<div class="hint-box md" hidden>${renderMarkdown(q.hint)}</div>` : ''}
    <div class="keys-box md" hidden>
      <b>A strong answer covers:</b>
      <ul>${(q.keyPoints || []).map((p) => `<li>${renderMarkdown(p).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>
      ${q.answer ? `<b>Model answer</b>${renderMarkdown(q.answer)}` : ''}
    </div>
  </div>`;
}

function feedbackTab(day) {
  const doc = day.answers;
  const s = answerSummary(doc, day.questions.length);
  const hasFeedback = !!doc.feedback?.trim();
  return `
    ${hasFeedback || s.avg != null ? `<div class="card">
      <div class="row" style="align-items:flex-start">
        <h3 style="margin:0;flex:1">🤖 Feedback ${doc.gradedAt ? `<small class="faint" style="font-weight:600">· ${new Date(doc.gradedAt).toLocaleString()}</small>` : ''}</h3>
        ${s.avg != null ? `<span class="score big ${scoreClass(s.avg)}">${s.avg}/10</span>` : ''}
      </div>
      ${Object.keys(doc.scores || {}).length ? `<div class="score-row">${day.questions.map((q, i) => doc.scores[q.id] != null ? `<a href="#/days/${day.id}/answer" class="score ${scoreClass(doc.scores[q.id])}" title="${esc(q.prompt.slice(0, 120))}">Q${i + 1} · ${doc.scores[q.id]}</a>` : '').join('')}</div>` : ''}
      ${hasFeedback ? `<div class="md feedback-md">${renderMarkdown(doc.feedback)}</div>` : ''}
    </div>` : `<div class="card"><div class="empty" style="padding:24px"><div class="big">🤖</div>No feedback yet. Answer the questions, then copy the prompt into an AI${STATIC ? '' : ` or run <code>/grade ${day.number}</code> in Claude Code`}.</div></div>`}
    <div class="card">
      <h3>📥 ${hasFeedback ? 'Replace' : 'Paste'} feedback</h3>
      <p class="muted" style="margin-top:0;font-size:14px">Paste the AI's whole reply. The prompt asks it to end with a line like <code>SCORES: q1=7, q2=5, …</code>, which is how your scores get recorded.</p>
      <textarea id="feedback-in" class="notes" style="min-height:200px" placeholder="Paste the AI's reply here…">${esc(doc.feedback || '')}</textarea>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="feedback-save">💾 Save feedback</button>
        <button class="btn ghost copy-prompt">📋 Copy prompt again</button>
        <span class="spacer"></span>
        <span class="faint" id="score-preview" style="font-size:13px"></span>
      </div>
    </div>
    ${s.avg != null && !dayDone(day.id) ? `<div class="card read-end"><div><b>Happy with it?</b><div class="muted" style="font-size:14px">Rewrite any weak answer in the Answer tab, or mark the day finished. Its questions will come back in 🧠 Recall.</div></div><button class="btn primary" id="finish-day">💙 Mark day finished</button></div>` : ''}`;
}

function wireDay(day) {
  const id = day.id;

  const toggleDone = async () => {
    await current.flush();
    const nowDone = !dayDone(id);
    await saveProgress('day', id, { done: nowDone });
    if (nowDone) { celebrate(); toast('Day finished! So proud of you 💙'); }
    await loadRecallDue();
    route();
  };
  document.getElementById('day-done').addEventListener('click', toggleDone);
  document.getElementById('step-done').addEventListener('click', (e) => { e.preventDefault(); toggleDone(); });
  document.getElementById('finish-day')?.addEventListener('click', toggleDone);
  document.querySelectorAll('.copy-prompt').forEach((b) => b.addEventListener('click', async () => {
    await current.flush();
    const n = Object.values(current.doc.answers).filter((t) => t.trim()).length;
    copyText(buildPrompt(day, current.doc), n ? `Prompt copied with ${n} answer${n === 1 ? '' : 's'} 📋 Paste it into your AI` : 'Copied 📋 (no answers yet, so the AI will just teach you)');
  }));
  document.querySelectorAll('.toc a').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById(a.dataset.target)?.scrollIntoView({ behavior: 'smooth' });
  }));

  // reading: checkboxes in "Before moving on" are remembered per browser
  document.querySelectorAll('.lesson-md li.task input').forEach((cb, i) => {
    const key = `sys:day:${id}:${i}`;
    try { if (localStorage.getItem(key) === '1') cb.checked = true; } catch {}
    cb.addEventListener('change', () => { try { localStorage.setItem(key, cb.checked ? '1' : '0'); } catch {} });
  });
  document.getElementById('to-answer')?.addEventListener('click', () => {
    if (!dayProg(id).readAt) saveProgress('day', id, { read: true });
  });

  // answering: autosave each answer shortly after you stop typing
  const changed = {};
  const savedLabel = (q, text) => {
    const el = document.querySelector(`.qcard[data-q="${q}"] .saved`);
    if (el) el.textContent = text;
  };
  async function flush() {
    clearTimeout(current?.pending);
    const qs = Object.keys(changed);
    if (!qs.length) return;
    const answers = {};
    for (const q of qs) { answers[q] = changed[q]; delete changed[q]; }
    try {
      const r = await api(`days/${id}/answers`, { method: 'PUT', body: { answers } });
      current.doc = r.answers;
      state.progress = r.progress;
      state.summaries[id] = answerSummary(r.answers, day.questions.length);
      qs.forEach((q) => savedLabel(q, 'saved ✓'));
      const tabCount = document.querySelector('.day-tabs a[href$="/answer"] small');
      if (tabCount) tabCount.textContent = `${state.summaries[id].answered}/${day.questions.length}`;
      if (!dayProg(id).readAt) await saveProgress('day', id, { read: true });
    } catch (err) {
      Object.assign(changed, answers);
      toast('🥺 Could not save: ' + err.message);
    }
  }
  current.flush = flush;
  document.querySelectorAll('textarea.answer').forEach((ta) => {
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.max(110, ta.scrollHeight + 4) + 'px'; };
    grow();
    ta.addEventListener('input', () => {
      grow();
      changed[ta.dataset.q] = ta.value;
      savedLabel(ta.dataset.q, 'typing…');
      clearTimeout(current.pending);
      current.pending = setTimeout(flush, 700);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey && ta.closest('.qcard').querySelector('.kind.code')) {
        e.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });
  });
  document.querySelectorAll('.qcard [data-toggle]').forEach((btn) => btn.addEventListener('click', () => {
    const card = btn.closest('.qcard');
    const box = card.querySelector(btn.dataset.toggle === 'hint' ? '.hint-box' : '.keys-box');
    if (btn.dataset.toggle === 'keys' && box.hidden && !card.querySelector('textarea').value.trim()
      && !confirm('Try writing an answer first? Recalling before peeking is what makes it stick.\n\nPress OK to peek anyway.')) return;
    box.hidden = !box.hidden;
    btn.classList.toggle('on', !box.hidden);
  }));

  // feedback
  const fin = document.getElementById('feedback-in');
  if (fin) {
    const preview = () => {
      const sc = parseScores(fin.value);
      const n = Object.keys(sc).length;
      document.getElementById('score-preview').textContent = fin.value.trim()
        ? (n ? `Found ${n} score${n === 1 ? '' : 's'}: ${Object.entries(sc).map(([k, v]) => `${k}=${v}`).join(', ')}` : 'No SCORES line found, so only the text will be saved')
        : '';
    };
    fin.addEventListener('input', preview);
    preview();
    document.getElementById('feedback-save').addEventListener('click', async () => {
      const r = await api(`days/${id}/feedback`, { method: 'PUT', body: { feedback: fin.value } });
      state.progress = r.progress;
      state.summaries[id] = answerSummary(r.answers, day.questions.length);
      toast(Object.keys(r.answers.scores).length ? 'Feedback saved 🤖💙' : 'Feedback saved (no scores found)');
      route();
    });
  }

  current.reload = async () => {
    // pick up feedback that Claude Code (or you, in an editor) wrote to the answers file
    if (Object.keys(changed).length) return;
    const fresh = await api(`days/${id}`);
    const a = fresh.answers;
    const was = current.doc;
    if (a.gradedAt !== was.gradedAt || a.updatedAt !== was.updatedAt) {
      const wasGraded = was.gradedAt;
      state.summaries[id] = answerSummary(a, day.questions.length);
      if (a.gradedAt !== wasGraded && a.gradedAt) {
        toast('New feedback arrived 🤖');
        location.hash = `#/days/${id}/feedback`;
        if (current?.tab === 'feedback') route();
      } else route();
    }
  };
}

// ---------- recall ----------
let recall = null; // { cards, i, revealed, results }

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function viewRecall() {
  await loadRecallDue();
  if (!recall || recall.i >= recall.cards.length && !recall.finished) {
    const due = state.recallDue || [];
    const seen = due.filter((c) => state.progress.recall[c.key]).sort((a, b) => state.progress.recall[a.key].due.localeCompare(state.progress.recall[b.key].due));
    const fresh = shuffle(due.filter((c) => !state.progress.recall[c.key]));
    recall = { cards: [...seen, ...fresh].slice(0, 10), i: 0, revealed: false, good: 0, again: 0, finished: false };
  }
  const total = state.recallCards?.length || 0;
  const head = `<div class="page-head"><div><h1>🧠 Recall</h1><p>Questions from days you've finished come back on a schedule: 1, 3, 7, 14, 30 and 60 days after you get them right. Answer from memory, then check. ${total} card${total === 1 ? '' : 's'} in your deck.</p></div></div>`;

  if (!total) return head + '<div class="empty"><div class="big">🌱</div>Finish your first day and its questions will show up here.</div>';
  if (recall.finished || !recall.cards.length) {
    const fin = recall.finished;
    const r = recall;
    recall = null;
    setTimeout(() => document.getElementById('again-session')?.addEventListener('click', () => route()));
    return head + `<div class="card"><div class="empty" style="padding:30px"><div class="big">${fin ? '🎉' : '🌙'}</div>
      ${fin ? `Session done! ${r.good} got it, ${r.again} to see again tomorrow.` : 'Nothing due right now. Come back tomorrow!'}
      ${state.recallDue?.length ? `<div style="margin-top:14px"><button class="btn primary" id="again-session">Next ${Math.min(10, state.recallDue.length)} cards →</button></div>` : ''}
      </div></div>`;
  }

  const c = recall.cards[recall.i];
  const q = c.question;
  const k = KIND[q.kind] || KIND.concept;
  const box = state.progress.recall[c.key]?.box || 0;
  setTimeout(wireRecall);
  return head + `
    <div class="recall-meta"><span>Card ${recall.i + 1} of ${recall.cards.length}</span><span class="spacer"></span>
      <a href="#/days/${c.dayId}">${trackOf(c.track).icon} Day ${c.dayNumber}: ${esc(c.dayTitle)}</a></div>
    <div class="progress" style="margin-bottom:16px"><span style="width:${(recall.i / recall.cards.length) * 100}%"></span></div>
    <div class="card qcard recall-card">
      <div class="qhead"><span class="pill kind ${esc(q.kind)}">${k.icon} ${k.label}</span><span class="pill level ${esc(q.level)}">${esc(q.level)}</span><span class="spacer"></span><span class="faint" style="font-size:12.5px">${box ? `box ${box}` : 'new card'}</span></div>
      <div class="md qprompt">${renderMarkdown(q.prompt)}</div>
      <textarea class="answer" id="recall-answer" placeholder="Answer from memory (not saved — it's just for you)…"></textarea>
      ${recall.revealed ? `<div class="keys-box md"><b>A strong answer covers:</b><ul>${(q.keyPoints || []).map((p) => `<li>${renderMarkdown(p).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>${q.answer ? `<b>Model answer</b>${renderMarkdown(q.answer)}` : ''}</div>
        <div class="row recall-btns">
          <button class="btn" id="r-again">😅 Shaky — show again tomorrow</button>
          <button class="btn primary" id="r-good">🙂 Got it — see in ${INTERVALS[Math.min(box + 1, INTERVALS.length - 1)]} days</button>
          <span class="spacer"></span>
          <button class="btn ghost small" id="r-copy" title="Copy a grading prompt for just this answer">📋 Grade with AI</button>
        </div>`
      : '<div class="row"><button class="btn primary" id="r-reveal">👀 Check my answer</button><span class="faint" style="font-size:13px">Say it out loud or jot it down first.</span></div>'}
    </div>`;
}

function wireRecall() {
  const c = recall.cards[recall.i];
  const ta = document.getElementById('recall-answer');
  if (recall.draft) ta.value = recall.draft;
  ta.addEventListener('input', () => { recall.draft = ta.value; });
  ta.focus();
  document.getElementById('r-reveal')?.addEventListener('click', () => { recall.revealed = true; route(); });
  const rate = async (result) => {
    await saveProgress('recall', c.key, { result });
    recall[result]++;
    recall.i++;
    recall.revealed = false;
    recall.draft = '';
    if (recall.i >= recall.cards.length) { recall.finished = true; celebrate(); }
    route();
  };
  document.getElementById('r-again')?.addEventListener('click', () => rate('again'));
  document.getElementById('r-good')?.addEventListener('click', () => rate('good'));
  document.getElementById('r-copy')?.addEventListener('click', () => {
    const day = state.days.find((d) => d.id === c.dayId);
    copyText(buildPrompt({ ...day, questions: [c.question] }, { answers: { [c.question.id]: ta.value } }), 'Prompt copied 📋');
  });
}

// ---------- goals ----------
function viewGoals() {
  const g = state.progress.goals;
  const s = stats();
  const daysLeft = g.targetDate ? Math.ceil((new Date(g.targetDate + 'T00:00') - new Date(dayKey() + 'T00:00')) / 864e5) : null;
  const remaining = s.total - s.done;
  const perWeek = Number(g.daysPerWeek) || 0;
  const finish = perWeek ? addDays(new Date(), Math.ceil((remaining / perWeek) * 7)) : null;
  const act = state.progress.activity;
  const activeDays = Object.values(act).filter((a) => a.days || a.answers || a.graded || a.reviews).length;
  const reviews = Object.values(act).reduce((n, a) => n + (a.reviews || 0), 0);

  setTimeout(() => {
    const bind = (idAttr, key, transform = (v) => v) => {
      document.getElementById(idAttr).addEventListener('change', async (e) => {
        await saveProgress('goals', null, { [key]: transform(e.target.value) });
        toast('Saved 🎯');
        route();
      });
    };
    bind('g-week', 'daysPerWeek', Number);
    bind('g-date', 'targetDate');
    bind('g-label', 'targetLabel');
    document.getElementById('g-name').addEventListener('change', async (e) => {
      await saveProgress('profile', null, { name: e.target.value.trim() });
      toast(`Hi ${e.target.value.trim() || 'there'}! 🌸`);
    });
    const customs = () => state.progress.goals.custom || [];
    document.getElementById('goal-add').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = e.target.querySelector('input');
      if (!input.value.trim()) return;
      await saveProgress('goals', null, { custom: [...customs(), { id: Date.now().toString(36), text: input.value.trim(), done: false }] });
      route();
    });
    document.querySelectorAll('.goal-item').forEach((item) => {
      const gid = item.dataset.id;
      item.querySelector('input').addEventListener('change', async (e) => {
        await saveProgress('goals', null, { custom: customs().map((c) => (c.id === gid ? { ...c, done: e.target.checked } : c)) });
        if (e.target.checked) { celebrate(); toast('Goal achieved! 🏆'); }
        route();
      });
      item.querySelector('.x').addEventListener('click', async () => {
        await saveProgress('goals', null, { custom: customs().filter((c) => c.id !== gid) });
        route();
      });
    });
  });

  return `
    <div class="page-head"><div><h1>🎯 Goals & Tracker</h1><p>One lesson a day, most days. Consistency beats intensity. 🐢💙</p></div></div>
    <div class="grid goals-grid">
      <div class="card">
        <h3>🌷 Your targets</h3>
        <div class="field"><label>Your name (for the greeting)</label><input type="text" id="g-name" value="${esc(state.progress.name)}" placeholder="e.g. Kim"></div>
        <div class="field"><label>Days per week</label><input type="number" min="1" max="7" id="g-week" value="${esc(g.daysPerWeek)}"></div>
        <div class="field"><label>Big goal</label><input type="text" id="g-label" value="${esc(g.targetLabel)}" placeholder="e.g. First system design interview 💼"></div>
        <div class="field"><label>Target date</label><input type="date" id="g-date" value="${esc(g.targetDate)}"></div>
      </div>

      <div class="card">
        <h3>⏳ Countdown</h3>
        ${daysLeft == null ? '<p class="muted">Pick a target date and I’ll count down with you. 🗓️</p>'
          : `<div class="countdown">${daysLeft}</div><p class="muted" style="margin-top:6px">day${daysLeft === 1 ? '' : 's'} until <b>${esc(g.targetLabel)}</b>${daysLeft < 0 ? ' (passed — set a new one?)' : ''}</p>`}
        ${finish && remaining ? `<p>${remaining} days of lessons left. At ${perWeek} a week you'll finish around <b>${finish.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</b>.${daysLeft != null && daysLeft > 0 ? (finish <= new Date(g.targetDate + 'T23:59') ? ' Right on time 💪' : ' A little after your target. Maybe one more day a week? 🌱') : ''}</p>` : ''}
        <h3 style="margin-top:18px">📊 By track</h3>
        <div class="topic-bars">
          ${state.tracks.map((t) => { const ts = trackStats(t.id); return ts.total ? `<div class="topic-bar"><span class="t">${t.icon} ${esc(t.title)}</span><span class="n">${ts.done}/${ts.total}${ts.avg != null ? ` · ${ts.avg}/10` : ''}</span><div class="progress"><span style="width:${(ts.done / ts.total) * 100}%"></span></div></div>` : ''; }).join('')}
        </div>
        <p class="muted" style="font-size:14px;margin-bottom:0">🔥 ${s.streak}-day streak · 🗓️ ${activeDays} active day${activeDays === 1 ? '' : 's'} · ✍️ ${s.answered} answers · 🧠 ${reviews} recall cards</p>
      </div>

      <div class="card">
        <h3>✅ My goals</h3>
        <div class="goal-list">
          ${(g.custom || []).map((c) => `<label class="goal-item ${c.done ? 'done' : ''}" data-id="${c.id}"><input type="checkbox" ${c.done ? 'checked' : ''}><span>${esc(c.text)}</span><button class="x" title="Remove">×</button></label>`).join('') || '<p class="muted" style="margin:0">Add milestones like “Finish the Networking track” or “Score 8+ on a case study”. 🎀</p>'}
        </div>
        <form id="goal-add" class="row"><input type="text" placeholder="New goal…" style="flex:1"><button class="btn primary small">Add</button></form>
      </div>

      <div class="card" style="grid-column:1/-1">
        <h3>🌸 Activity (last 40 weeks)</h3>
        ${heatmap(40)}
      </div>
    </div>`;
}

// ---------- router ----------
async function route() {
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'days' || !parts[1]) current = null;
  if (parts[0] !== 'recall') recall = null;
  renderSidebar();
  try {
    let html;
    if (!parts.length) html = viewHome();
    else if (parts[0] === 'days' && parts[1]) html = await viewDay(parts[1], parts[2]);
    else if (parts[0] === 'days') html = viewCurriculum();
    else if (parts[0] === 'recall') html = await viewRecall();
    else if (parts[0] === 'goals') html = viewGoals();
    else html = '<div class="empty"><div class="big">🌸</div>Page not found. <a href="#/">Go home</a></div>';
    $main.innerHTML = html;
    wireCopyButtons($main);
  } catch (err) {
    $main.innerHTML = `<div class="empty"><div class="big">🥺</div>${esc(err.message)}<br><a href="#/">Go home</a></div>`;
  }
}

function wireCopyButtons(root = document) {
  root.querySelectorAll('.codeblock .copy').forEach((btn) => {
    btn.onclick = () => {
      navigator.clipboard.writeText(btn.parentElement.querySelector('code').textContent);
      btn.textContent = 'copied!';
      setTimeout(() => (btn.textContent = 'copy'), 1200);
    };
  });
}

let lastPage = location.hash.split('/').slice(0, 3).join('/');
window.addEventListener('hashchange', async () => {
  await current?.flush?.();
  const page = location.hash.split('/').slice(0, 3).join('/');
  if (page !== lastPage) window.scrollTo(0, 0); // switching tabs on the same day keeps your place
  else window.scrollTo(0, Math.min(window.scrollY, document.querySelector('.day-tabs')?.offsetTop || 0));
  lastPage = page;
  route();
});
window.addEventListener('beforeunload', (e) => {
  if (current?.pending) { current.flush(); e.preventDefault(); }
});
window.addEventListener('focus', async () => {
  // pick up changes made outside the app (Claude Code grading, your editor) while you were away
  if (current?.pending) return;
  await refresh();
  if (current?.reload) await current.reload();
  else renderSidebar();
});

initCheatsheet();
refresh()
  .then(() => { loadRecallDue().then(() => { renderSidebar(); if (!location.hash || location.hash === '#/') route(); }); return route(); })
  .catch((err) => {
    $main.innerHTML = STATIC
      ? `<div class="empty"><div class="big">🥺</div>Couldn't load the study content.<br><small>${esc(err.message)}</small></div>`
      : `<div class="empty"><div class="big">🥺</div>Couldn't reach the study server.<br>Is <code>npm start</code> running?<br><small>${esc(err.message)}</small></div>`;
  });
