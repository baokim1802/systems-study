// Save your answers, feedback and progress to GitHub (commit + push).
//   npm run sync
// Also used by the "Save to GitHub" button in the app.
const { execFileSync } = require('child_process');
const { ROOT } = require('../lib/catalog');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function sync() {
  try {
    git('rev-parse', '--is-inside-work-tree');
  } catch {
    return { ok: false, message: 'This folder is not a git repository.' };
  }
  git('add', '-A');
  const changed = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  if (changed.length) {
    const days = changed.filter((f) => f.startsWith('answers/')).length;
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    git('commit', '-m', `Study session ${stamp}${days ? ` (${days} day${days > 1 ? 's' : ''} of answers)` : ''}`);
  }
  let remote = '';
  try { remote = git('remote'); } catch {}
  if (!remote) {
    return { ok: true, message: changed.length ? `Committed ${changed.length} file(s). No GitHub remote set up yet, so nothing was pushed.` : 'Nothing new to save.' };
  }
  try {
    git('pull', '--rebase', '--autostash');
    git('push');
  } catch (err) {
    return { ok: false, message: `Committed locally, but pushing failed:\n${(err.stderr || err.message).trim()}` };
  }
  return { ok: true, message: changed.length ? `Saved ${changed.length} file(s) to GitHub 💾` : 'Already up to date on GitHub ✨' };
}

module.exports = { sync };

if (require.main === module) {
  const r = sync();
  console.log((r.ok ? '🫧 ' : '🥺 ') + r.message);
  process.exit(r.ok ? 0 : 1);
}
