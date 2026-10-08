// One API for the whole app. With the Node server (local / Codespaces) calls go over HTTP.
// On the static website (GitHub Pages) there is no server: build-static.js sets window.SYS_STATIC
// and the same calls are answered in the browser by static-api.js.
// CLOUD: the website saves to Supabase (build-static.js sets window.SYS_SUPABASE from supabase.config.json).

export const STATIC = !!window.SYS_STATIC;
export const CLOUD = STATIC && !!window.SYS_SUPABASE?.url;

let backend = null;

export async function api(path, opts = {}) {
  if (STATIC) {
    backend ||= await import('./static-api.js');
    try {
      return await backend.handle(path, opts);
    } catch (err) {
      if (CLOUD && err.status === 401) location.reload(); // signed out or expired: back to the sign-in screen
      throw err;
    }
  }
  const res = await fetch(`/api/${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Website only: backup / restore helpers from the browser backend. */
export async function staticBackend() {
  backend ||= await import('./static-api.js');
  return backend;
}
