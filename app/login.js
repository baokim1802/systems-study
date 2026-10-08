// Sign-in screen for the website when it saves to Supabase.
// There is no "create account" button on purpose: sign-ups are turned off in Supabase, and you
// invite people from the Supabase dashboard. An invite email links back here to set a password.
import { cloudClient } from './static-api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const here = () => location.origin + location.pathname; // where email links send you back to

/**
 * Resolves once someone is signed in, showing the sign-in form in `$main` if needed.
 * Also finishes sign-ins from email links, which land on the page as #access_token=…
 * The first time, it asks for a first and last name (kept on the account, shared by both study apps).
 */
export async function ensureSignedIn($main) {
  const db = cloudClient();
  await signIn($main, db);
  if (!db.user.firstName) await askName($main, db);
  return db.user;
}

async function signIn($main, db) {
  const link = readLinkFromUrl();
  let notice = '';
  if (link?.error) notice = `<div class="msg err">That link didn't work: ${esc(link.error)}. Ask for a new one below.</div>`;
  else if (link) {
    try {
      await db.useLinkTokens(link.params);
      // invites and password resets come here to choose a password; sign-in links are done
      if (link.type === 'invite' || link.type === 'recovery') await choosePassword($main, db, link.type);
      return db.user;
    } catch (err) {
      notice = `<div class="msg err">Couldn't sign in with that link: ${esc(err.message)}</div>`;
    }
  }
  if (db.user) return db.user;
  return signInForm($main, db, notice);
}

/** Email links put the result after '#'. Read it, then put the app's normal '#/' back. */
function readLinkFromUrl() {
  const hash = location.hash.slice(1);
  if (!/(^|&)(access_token|error_description)=/.test(hash)) return null;
  const params = new URLSearchParams(hash);
  history.replaceState(null, '', location.pathname + location.search + '#/');
  if (params.get('error_description')) return { error: params.get('error_description').replace(/\+/g, ' ') };
  return { params, type: params.get('type') };
}

function card(inner) {
  return `<div class="signin card">${inner}</div>`;
}

function signInForm($main, db, notice) {
  return new Promise((resolve) => {
    $main.innerHTML = card(`
      <h1>🫧 Systems Study</h1>
      <p class="muted">Sign in to see your answers and progress on any device.</p>
      <form id="signin">
        <div class="field"><label for="si-email">Email</label><input type="email" id="si-email" autocomplete="email" required></div>
        <div class="field"><label for="si-pass">Password</label><input type="password" id="si-pass" autocomplete="current-password"></div>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
      <div class="links">
        <a href="#" id="si-link">✉️ Email me a sign-in link</a>
        <a href="#" id="si-reset">Forgot password?</a>
      </div>
      <div id="si-msg">${notice}</div>
      <p class="faint" style="font-size:12.5px;margin:16px 0 0">Accounts are invite-only. Ask the owner of this site for an invite.</p>`);
    const $email = document.getElementById('si-email');
    const $msg = document.getElementById('si-msg');
    const say = (text, err) => ($msg.innerHTML = `<div class="msg ${err ? 'err' : ''}">${esc(text)}</div>`);
    const needEmail = () => {
      if ($email.value.trim()) return $email.value.trim();
      say('Type your email first.', true);
      $email.focus();
      return null;
    };

    document.getElementById('signin').addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = document.getElementById('si-pass').value;
      if (!password) return say('Type your password, or use "Email me a sign-in link".', true);
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        resolve(await db.signIn($email.value.trim(), password));
      } catch (err) {
        say(err.status === 400 ? 'Wrong email or password.' : err.message, true);
        btn.disabled = false;
      }
    });
    document.getElementById('si-link').addEventListener('click', async (e) => {
      e.preventDefault();
      const email = needEmail();
      if (!email) return;
      try {
        await db.sendLink(email, here());
        say(`If ${email} has an account, a sign-in link is on its way. Open it on this device.`);
      } catch (err) {
        // with sign-ups off, an unknown email is rejected; don't reveal which emails exist
        say(err.status && err.status < 500 && err.status !== 429 ? `If ${email} has an account, a sign-in link is on its way.` : err.message, err.status === 429);
      }
    });
    document.getElementById('si-reset').addEventListener('click', async (e) => {
      e.preventDefault();
      const email = needEmail();
      if (!email) return;
      try {
        await db.sendReset(email, here());
        say(`If ${email} has an account, a link to choose a new password is on its way.`);
      } catch (err) {
        say(err.message, true);
      }
    });
    $email.focus();
  });
}

function askName($main, db) {
  return new Promise((resolve) => {
    $main.innerHTML = card(`
      <h1>👋 What's your name?</h1>
      <p class="muted">For your greeting. It's saved on your account, so both study sites use it.</p>
      <form id="nm">
        <div class="row" style="gap:12px;align-items:flex-start">
          <div class="field" style="flex:1;min-width:140px"><label for="nm-first">First name</label><input type="text" id="nm-first" autocomplete="given-name" maxlength="40" required></div>
          <div class="field" style="flex:1;min-width:140px"><label for="nm-last">Last name</label><input type="text" id="nm-last" autocomplete="family-name" maxlength="40"></div>
        </div>
        <button class="btn primary" type="submit">Continue</button>
      </form>
      <div id="nm-msg"></div>`);
    document.getElementById('nm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        await db.setName(document.getElementById('nm-first').value, document.getElementById('nm-last').value);
        resolve();
      } catch (err) {
        if (err.status === 401) return location.reload(); // sign-in ended: start over at the sign-in screen
        document.getElementById('nm-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    });
    document.getElementById('nm-first').focus();
  });
}

function choosePassword($main, db, type) {
  return new Promise((resolve) => {
    $main.innerHTML = card(`
      <h1>${type === 'invite' ? '🌸 Welcome!' : '🔑 New password'}</h1>
      <p class="muted">Signed in as <b>${esc(db.user.email)}</b>. Choose a password so you can sign in on your other devices.</p>
      <form id="pw">
        <div class="field"><label for="pw-new">Password (8+ characters)</label><input type="password" id="pw-new" autocomplete="new-password" minlength="8" required></div>
        <button class="btn primary" type="submit">Save password</button>
      </form>
      <div class="links"><a href="#" id="pw-skip">Skip: I'll use sign-in links</a></div>
      <div id="pw-msg"></div>`);
    document.getElementById('pw').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        await db.setPassword(document.getElementById('pw-new').value);
        resolve();
      } catch (err) {
        if (err.status === 401) return location.reload(); // sign-in ended: start over at the sign-in screen
        document.getElementById('pw-msg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    });
    document.getElementById('pw-skip').addEventListener('click', (e) => { e.preventDefault(); resolve(); });
    document.getElementById('pw-new').focus();
  });
}
