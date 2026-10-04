// Right-side cheat sheet drawer: one accordion group per file in cheatsheets/, one item per "## " section.
// Open with the floating tab, the sidebar link, or Ctrl+/ (Cmd+/). Esc closes it.
import { renderMarkdown } from './md.js';
import { api } from './api.js';

const STORE = 'sys:cheatsheet';
const $drawer = document.getElementById('cheatsheet');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Remembers which drawer, groups and items were open (per browser; losing it is harmless).
let saved = { open: false, groups: {}, items: {} };
try { saved = { ...saved, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch {}
const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(saved)); } catch {} };

let sheets = null;
let editing = null; // id of the sheet being edited in the drawer, if any

function parseSheet(sheet) {
  // Split a cheat sheet into its "## " sections. Text before the first section becomes an intro.
  const body = sheet.markdown.replace(/^#\s+.+\n/, '');
  const parts = body.split(/^##\s+/m);
  const intro = parts.shift().trim();
  const items = parts.map((chunk) => {
    const nl = chunk.indexOf('\n');
    const title = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
    const md = nl === -1 ? '' : chunk.slice(nl + 1).trim();
    return { key: `${sheet.id}#${title}`, title, md, text: `${title}\n${md}`.toLowerCase() };
  });
  return { ...sheet, intro, items };
}

async function load() {
  try {
    sheets = (await api('cheatsheets')).map(parseSheet);
  } catch (err) {
    throw new Error(err.status === 404 ? 'outdated-server' : err.message);
  }
}

function render() {
  const body = $drawer.querySelector('.cs-body');
  if (!sheets.length) {
    body.innerHTML = '<div class="empty"><div class="big">📝</div>No cheat sheets yet. Add markdown files to <code>cheatsheets/</code>.</div>';
    return;
  }
  body.innerHTML = sheets.map((s) => s.id === editing ? editorHtml(s) : `
    <details class="cs-group" data-group="${esc(s.id)}" ${saved.groups[s.id] ? 'open' : ''}>
      <summary><span>${esc(s.title)}</span><span class="cs-count">${s.items.length}</span>
        <button class="cs-edit" data-edit="${esc(s.id)}" title="Edit this sheet">✏️</button></summary>
      ${s.intro ? `<div class="md cs-intro">${renderMarkdown(s.intro)}</div>` : ''}
      ${s.items.map((it) => `
        <details class="cs-item" data-key="${esc(it.key)}" ${saved.items[it.key] ? 'open' : ''}>
          <summary>${esc(it.title)}</summary>
          <div class="md">${renderMarkdown(it.md)}</div>
        </details>`).join('')}
    </details>`).join('');

  body.querySelectorAll('details').forEach((d) => d.addEventListener('toggle', () => {
    if (searching()) return; // opening things to show search hits shouldn't be remembered
    if (d.classList.contains('cs-group')) saved.groups[d.dataset.group] = d.open;
    else saved.items[d.dataset.key] = d.open;
    persist();
  }));
  body.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.preventDefault(); // don't toggle the accordion
    startEditing(btn.dataset.edit);
  }));
  if (editing) wireEditor(body.querySelector('.cs-editor'));
  body.querySelectorAll('.codeblock .copy').forEach((btn) => {
    btn.onclick = () => {
      navigator.clipboard.writeText(btn.parentElement.querySelector('code').textContent);
      btn.textContent = 'copied!';
      setTimeout(() => (btn.textContent = 'copy'), 1200);
    };
  });
}

function editorHtml(s) {
  return `<div class="cs-group cs-editor" data-group="${esc(s.id)}">
    <div class="cs-editor-head"><b>✏️ ${esc(s.title)}</b><span class="faint">cheatsheets/${esc(s.id)}.md</span></div>
    <textarea spellcheck="false">${esc(s.markdown)}</textarea>
    <div class="cs-hint"><code># Title</code> once at the top · each <code>## Heading</code> becomes a collapsible note ·
      put code between <code>\`\`\`js</code> and <code>\`\`\`</code> · <kbd>Ctrl</kbd>+<kbd>S</kbd> saves</div>
    <div class="row cs-editor-actions">
      <button class="btn primary small" data-act="save">💾 Save</button>
      <button class="btn small" data-act="cancel">Cancel</button>
      <span class="spacer"></span><span class="cs-status faint"></span>
    </div>
  </div>`;
}

function wireEditor(el) {
  const ta = el.querySelector('textarea');
  const status = el.querySelector('.cs-status');
  const original = ta.value;
  const save = async () => {
    status.textContent = 'Saving…';
    try {
      await api(`cheatsheets/${encodeURIComponent(editing)}`, { method: 'PUT', body: { markdown: ta.value } });
    } catch (err) {
      status.textContent = '🥺 ' + (err.message || 'Save failed');
      return;
    }
    saved.groups[editing] = true;
    persist();
    editing = null;
    await load();
    render();
    applySearch();
  };
  const cancel = () => {
    if (ta.value !== original && !confirm('Discard your changes to this cheat sheet?')) return;
    editing = null;
    render();
    applySearch();
  };
  el.querySelector('[data-act="save"]').addEventListener('click', save);
  el.querySelector('[data-act="cancel"]').addEventListener('click', cancel);
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
    if (e.key === 'Escape') e.stopPropagation(); // Esc shouldn't close the drawer mid-edit
  });
  ta.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
}

function startEditing(id) {
  if (editing && editing !== id && !confirm('Stop editing the other sheet? Unsaved changes will be lost.')) return;
  editing = id;
  $drawer.querySelector('#cs-q').value = '';
  render();
  applySearch();
}

async function newSheet() {
  const title = prompt('Name for the new cheat sheet (e.g. "Regex" or "My notes"):');
  if (!title || !title.trim()) return;
  const { id } = await api('cheatsheets', { method: 'POST', body: { title } });
  await load();
  startEditing(id);
}

const searching = () => !!$drawer.querySelector('#cs-q').value.trim();

function applySearch() {
  const q = $drawer.querySelector('#cs-q').value.trim().toLowerCase();
  let hits = 0;
  $drawer.querySelectorAll('.cs-group:not(.cs-editor)').forEach((g) => {
    const sheet = sheets.find((s) => s.id === g.dataset.group);
    let groupHits = 0;
    g.querySelectorAll('.cs-item').forEach((item) => {
      const it = sheet.items.find((x) => x.key === item.dataset.key);
      const match = !q || it.text.includes(q) || sheet.title.toLowerCase().includes(q);
      item.hidden = !match;
      item.open = q ? match : !!saved.items[it.key];
      if (match) groupHits++;
    });
    g.hidden = !groupHits;
    g.open = q ? groupHits > 0 : !!saved.groups[g.dataset.group];
    hits += groupHits;
  });
  $drawer.querySelector('.cs-none').hidden = !q || hits > 0;
}

function setAll(open) {
  $drawer.querySelector('#cs-q').value = '';
  sheets.forEach((s) => {
    saved.groups[s.id] = open;
    s.items.forEach((it) => (saved.items[it.key] = open));
  });
  persist();
  applySearch();
}

export async function toggleCheatsheet(force) {
  const open = force ?? !document.body.classList.contains('cs-open');
  document.body.classList.toggle('cs-open', open);
  $drawer.setAttribute('aria-hidden', String(!open));
  saved.open = open;
  persist();
  if (open) {
    // reload each time it opens so edits to cheatsheets/*.md show up without a page refresh
    if (!editing) {
      try {
        await load();
      } catch (err) {
        $drawer.querySelector('.cs-body').innerHTML = err.message === 'outdated-server'
          ? '<div class="empty"><div class="big">🔄</div>The app server is running an older version.<br>Restart it: press <kbd>Ctrl</kbd>+<kbd>C</kbd> in its terminal, then run <code>npm start</code>.</div>'
          : `<div class="empty"><div class="big">🥺</div>Couldn't load the cheat sheets (${esc(err.message)}).</div>`;
        return;
      }
      render();
      applySearch();
    }
    if (window.innerWidth > 760 && !editing) $drawer.querySelector('#cs-q').focus({ preventScroll: true });
  }
}

export function initCheatsheet() {
  $drawer.innerHTML = `
    <div class="cs-head">
      <div class="row"><h2>📝 Cheat sheet</h2><span class="spacer"></span>
        <button class="btn ghost small" id="cs-close" title="Close (Esc)">✕</button></div>
      <input type="search" id="cs-q" placeholder="🔍 Search… e.g. splice, padStart, heap" autocomplete="off">
      <div class="row cs-tools">
        <button class="btn ghost small" id="cs-expand">Expand all</button>
        <button class="btn ghost small" id="cs-collapse">Collapse all</button>
        <span class="spacer"></span>
        <button class="btn ghost small" id="cs-new" title="Create a new cheat sheet">+ New sheet</button>
      </div>
    </div>
    <div class="cs-none empty" hidden><div class="big">🔍</div>Nothing matches.</div>
    <div class="cs-body"></div>`;
  $drawer.querySelector('#cs-close').addEventListener('click', () => toggleCheatsheet(false));
  $drawer.querySelector('#cs-q').addEventListener('input', applySearch);
  $drawer.querySelector('#cs-expand').addEventListener('click', () => setAll(true));
  $drawer.querySelector('#cs-collapse').addEventListener('click', () => setAll(false));
  $drawer.querySelector('#cs-new').addEventListener('click', newSheet);
  document.getElementById('cs-tab').addEventListener('click', () => toggleCheatsheet());

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); toggleCheatsheet(); }
    else if (e.key === 'Escape' && document.body.classList.contains('cs-open')) toggleCheatsheet(false);
  });

  if (saved.open) toggleCheatsheet(true);
}
