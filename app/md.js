// Tiny markdown renderer (enough for lessons & problem statements) + a JS syntax highlighter.

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const JS_KEYWORDS = new Set(
  'const let var function return if else for while do break continue new class extends super this of in typeof instanceof null undefined true false switch case default try catch finally throw async await yield delete void static get set'.split(' '),
);
const JS_BUILTINS = new Set('Map Set Array Object Math Number String Infinity NaN console JSON BigInt Symbol WeakMap module require exports'.split(' '));

export function highlightJs(code) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?n?\b)|([A-Za-z_$][\w$]*)(\s*\()?/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    last = re.lastIndex;
    const [all, comment, str, num, word, call] = m;
    if (comment) out += `<span class="tok-com">${escapeHtml(comment)}</span>`;
    else if (str) out += `<span class="tok-str">${escapeHtml(str)}</span>`;
    else if (num) out += `<span class="tok-num">${num}</span>`;
    else if (JS_KEYWORDS.has(word)) out += `<span class="tok-kw">${word}</span>${call ? escapeHtml(call) : ''}`;
    else if (JS_BUILTINS.has(word)) out += `<span class="tok-bi">${word}</span>${call ? escapeHtml(call) : ''}`;
    else if (call) out += `<span class="tok-fn">${word}</span>${escapeHtml(call)}`;
    else out += escapeHtml(all);
  }
  return out + escapeHtml(code.slice(last));
}

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const external = /^https?:/.test(href);
      return `<a href="${href}"${external ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`;
    })
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i]);
}

const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');

function renderList(lines, start) {
  // Parses a (possibly nested) list starting at lines[start]; returns [html, nextIndex].
  const indentOf = (l) => l.match(/^\s*/)[0].length;
  const baseIndent = indentOf(lines[start]);
  const ordered = /^\s*\d+[.)]\s/.test(lines[start]);
  let html = ordered ? '<ol>' : '<ul>';
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // allow a single blank line between items of the same list
      const next = lines[i + 1];
      if (next && indentOf(next) >= baseIndent && /^\s*([-*+]|\d+[.)])\s/.test(next)) { i++; continue; }
      break;
    }
    const indent = indentOf(line);
    const m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (indent < baseIndent || (!m && indent <= baseIndent)) break;
    if (indent > baseIndent && m) {
      const [sub, next] = renderList(lines, i);
      html = html.replace(/<\/li>$/, sub + '</li>');
      i = next;
      continue;
    }
    if (!m) {
      // continuation line of the previous item
      html = html.replace(/<\/li>$/, ' ' + inline(line.trim()) + '</li>');
      i++;
      continue;
    }
    const task = m[1].match(/^\[( |x|X)\]\s+(.*)$/);
    if (task) {
      const checked = task[1] !== ' ';
      html += `<li class="task"><label><input type="checkbox"${checked ? ' checked' : ''}> <span>${inline(task[2])}</span></label></li>`;
    } else {
      html += `<li>${inline(m[1])}</li>`;
    }
    i++;
  }
  return [html + (ordered ? '</ol>' : '</ul>'), i];
}

// ---------- text copied out of a terminal ----------
// Claude Code (and other CLIs) draw markdown tables with box characters and wrap long cells onto
// extra lines. Turn those back into markdown tables so pasted AI replies render properly.
const BOX_RULE = /^\s*[┌├└╭╰+][─━═┬┼┴┳╋┻╤╪╧+\-\s]*[┐┤┘╮╯+]\s*$/;
const BOX_ROW = /^\s*[│┃|].*[│┃|]\s*$/;

function boxCells(line) {
  const bar = /[│┃]/.test(line) ? /[│┃]/ : /\|/;
  return line.trim().slice(1, -1).split(bar).map((c) => c.trim());
}

function boxTableToMarkdown(block) {
  // Rows are separated by rule lines; lines between two rules are one row wrapped over several lines.
  const groups = [[]];
  for (const line of block) {
    if (BOX_RULE.test(line)) { if (groups[groups.length - 1].length) groups.push([]); }
    else groups[groups.length - 1].push(boxCells(line));
  }
  if (!groups[groups.length - 1].length) groups.pop();
  if (!groups.length) return block;
  // No rules between body rows: each line is a row, unless its first cell is empty (a wrapped line).
  if (groups.length === 2 && groups[1].length > 1) {
    const body = groups.pop();
    for (const cells of body) {
      if (cells[0] || groups.length === 1) groups.push([cells]);
      else groups[groups.length - 1].push(cells);
    }
  }
  const rows = groups.map((lines) => {
    const width = Math.max(...lines.map((l) => l.length));
    return Array.from({ length: width }, (_, c) => lines.map((l) => l[c] || '').filter(Boolean).join(' ').replace(/\|/g, '\\|'));
  });
  const row = (cells) => `| ${cells.join(' | ')} |`;
  return ['', row(rows[0]), row(rows[0].map(() => '---')), ...rows.slice(1).map(row), ''];
}

// The grading prompt asks the AI to wrap its reply in one ````markdown block; unwrap it.
// Only a fence tagged markdown/md, or one of 4+ backticks, counts, so normal code blocks stay.
function unwrapMarkdownFence(lines) {
  const open = lines.findIndex((l) => /^(`{4,}|~{4,})\s*(markdown|md)?\s*$|^(`{3}|~{3})\s*(markdown|md)\s*$/i.test(l.trim()));
  if (open < 0) return lines;
  const fence = lines[open].trim().match(/^(`+|~+)/)[1];
  let close = lines.length - 1;
  while (close > open && !(lines[close].trim().startsWith(fence[0].repeat(fence.length)) && /^(`+|~+)$/.test(lines[close].trim()))) close--;
  if (close <= open) return lines.filter((_, i) => i !== open); // copied without the closing fence
  return lines.filter((_, i) => i !== open && i !== close);
}

/** Clean up a pasted AI reply: unwrap a ````markdown block, undo terminal indentation, turn box-drawn tables into markdown tables. */
export function fromTerminal(text) {
  let lines = String(text || '').replace(/\r\n/g, '\n').replace(/^\s*⏺ ?/, '').split('\n');
  lines = unwrapMarkdownFence(lines);
  // terminals indent every line of a reply except the first (which followed the ⏺ marker)
  const indent = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  if (indent > 0 && indent < Infinity) lines = lines.map((l) => l.slice(Math.min(indent, l.match(/^ */)[0].length)));
  const out = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fenced = !fenced;
    if (fenced || !(BOX_RULE.test(lines[i]) || BOX_ROW.test(lines[i]))) { out.push(lines[i]); continue; }
    const block = [];
    while (i < lines.length && (BOX_RULE.test(lines[i]) || BOX_ROW.test(lines[i]))) block.push(lines[i++]);
    i--;
    // a plain markdown table (| a | b | with no drawn rules) is already fine
    out.push(...(block.some((l) => BOX_RULE.test(l)) ? boxTableToMarkdown(block) : block));
  }
  return out.join('\n');
}

export function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^\s*```\s*(\w*)/);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const code = buf.join('\n');
      const body = /^(js|javascript|ts)$/.test(lang) ? highlightJs(code) : escapeHtml(code);
      html += `<div class="codeblock"><button class="copy" title="Copy">copy</button><pre><code>${body}</code></pre></div>`;
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2]);
      html += `<h${level} id="${slugify(h[2])}">${content}</h${level}>`;
      i++;
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { html += '<hr>'; i++; continue; }

    if (/^\s*</.test(line)) {
      // raw HTML block (e.g. <details>) — passes through until a blank line
      while (i < lines.length && lines[i].trim()) html += lines[i++] + '\n';
      continue;
    }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`;
      continue;
    }

    if (/^\s*\|/.test(line) && lines[i + 1] && /^\s*\|?\s*:?-+/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|')));
      const head = cells(line);
      i += 2;
      let rows = '';
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows += `<tr>${cells(lines[i++]).map((c) => `<td>${c}</td>`).join('')}</tr>`;
      html += `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const [list, next] = renderList(lines, i);
      html += list;
      i = next;
      continue;
    }

    const buf = [];
    while (
      i < lines.length && lines[i].trim() &&
      !/^\s*(```|#{1,6}\s|>|<|([-*+]|\d+[.)])\s|\|)/.test(lines[i])
    ) buf.push(lines[i++].trim());
    if (!buf.length) buf.push(lines[i++].trim());
    html += `<p>${inline(buf.join(' '))}</p>`;
  }
  return html;
}
