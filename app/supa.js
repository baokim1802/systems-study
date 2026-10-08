// A tiny Supabase client, so the project stays dependency-free. Supabase is two HTTP APIs:
//   /auth/v1  sign in, sign-in links, passwords (it hands out a short-lived access token)
//   /rest/v1  the tables, as JSON (each request carries the token; RLS checks it)
// Used by the website (static-api.js, login.js) and by `npm run pull` / `npm run push`.
//
// `storage` keeps the session between visits: { load() -> session | null, save(session | null) }.

export function createClient({ url, anonKey, storage }) {
  const base = url.replace(/\/+$/, '');
  let session = storage.load();
  let refreshing = null;

  async function call(path, { method = 'GET', body, token, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = data?.msg || data?.message || data?.error_description || data?.error || `HTTP ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return data;
  }

  function keep(s) {
    session = s && {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: Number(s.expires_at) || Math.floor(Date.now() / 1000) + (Number(s.expires_in) || 3600),
      user: s.user ? { id: s.user.id, email: s.user.email } : null,
    };
    storage.save(session);
    return session;
  }

  /** A valid access token, refreshed when it's about to expire (they last an hour). */
  async function token() {
    const stored = storage.load(); // another tab may have refreshed it already
    if (stored && (!session || stored.expires_at > session.expires_at)) session = stored;
    if (!session) throw Object.assign(new Error('Please sign in.'), { status: 401 });
    if (session.expires_at * 1000 > Date.now() + 60_000) return session.access_token;
    refreshing ||= call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } })
      .then(keep, (err) => {
        if (!err.status) throw err; // offline: keep the session and try again later
        keep(null);
        throw Object.assign(new Error('Your sign-in expired. Please sign in again.'), { status: 401 });
      })
      .finally(() => { refreshing = null; });
    return (await refreshing).access_token;
  }

  return {
    get user() { return session?.user || null; },

    async signIn(email, password) {
      keep(await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
      return session.user;
    },

    /** Email a one-time sign-in link. create_user:false: it never makes a new account. */
    async sendLink(email, redirectTo) {
      const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
      await call(`/auth/v1/otp${q}`, { method: 'POST', body: { email, create_user: false } });
    },

    /** Email a "reset your password" link. */
    async sendReset(email, redirectTo) {
      const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
      await call(`/auth/v1/recover${q}`, { method: 'POST', body: { email } });
    },

    /** Sign in with the tokens an email link (invite, sign-in link, reset) puts in the URL after '#'. */
    async useLinkTokens(params) {
      keep({ access_token: params.get('access_token'), refresh_token: params.get('refresh_token'), expires_at: params.get('expires_at'), expires_in: params.get('expires_in') });
      const user = await call('/auth/v1/user', { token: session.access_token });
      keep({ ...session, user });
      return session.user;
    },

    async setPassword(password) {
      await call('/auth/v1/user', { method: 'PUT', token: await token(), body: { password } });
    },

    async signOut() {
      const t = session?.access_token;
      keep(null);
      if (t) await call('/auth/v1/logout', { method: 'POST', token: t }).catch(() => {});
    },

    /** Rows of a table (RLS already limits them to yours). `query` uses PostgREST syntax. */
    async select(table, query = 'select=*') {
      return call(`/rest/v1/${table}?${query}`, { token: await token() });
    },

    /** Insert rows, or update them when the primary key already exists. Every row needs the same columns. */
    async upsert(table, rows) {
      if (!rows.length) return;
      await call(`/rest/v1/${table}`, {
        method: 'POST',
        token: await token(),
        body: rows,
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      });
    },

    /** Call a Postgres function, e.g. bump_activity. */
    async rpc(fn, args) {
      return call(`/rest/v1/rpc/${fn}`, { method: 'POST', token: await token(), body: args });
    },
  };
}
