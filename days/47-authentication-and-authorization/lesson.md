# Authentication and Authorization

> Every app with accounts has to answer two questions on every request: *who are you?* and *are you allowed to do this?* Getting either wrong leaks data or lets strangers in, and "how would you do login?" is a standard interview question.

## The big idea

Think of a hotel:

- At the front desk you show your **passport**. The clerk checks you are who you say you are. That's **authentication** (often shortened to **authn**): proving identity.
- They give you a **key card**. You don't show your passport at every door; the card stands in for it. That's a **session** or **token**.
- Your card opens room 512 and the gym, but not room 513 or the staff kitchen. That's **authorization** (**authz**): deciding what an identity may do.

On the web, HTTP is stateless (Day 14): each request arrives on its own. So the server must recognize the "key card" on **every** request and check permissions every time.

HTTP status codes follow this split, with a confusing name: **401 Unauthorized** really means *unauthenticated* ("I don't know who you are, log in"), while **403 Forbidden** means *authenticated but not allowed*.

## Storing passwords

Never store passwords in plain text. Databases leak: backups get copied, an SQL injection (Day 48) dumps a table, an employee goes rogue. When that happens, users who reuse passwords get hurt everywhere.

### Why not just hash them?

A **hash** (Day 25) turns input into a fixed-size fingerprint, one way. Store `hash(password)`, and at login compare `hash(attempt)` with it. Better, but two problems:

1. **Same password → same hash.** Attackers precompute hashes of millions of common passwords (**rainbow tables**) and look them up instantly. Also, everyone with `password123` is exposed at once.
2. **Fast hashes are fast for attackers too.** SHA-256 was designed for speed. A single modern GPU computes on the order of **10 billion** SHA-256 hashes per second.

### Salt

A **salt** is a random value (e.g. 16 bytes), unique per user, stored next to the hash. You hash `salt + password`. Now identical passwords have different hashes, and precomputed tables are useless: the attacker must attack each user separately.

### Slow on purpose

**Password hashing functions** are deliberately slow and tunable, so that checking one login takes a fraction of a second (fine for you, you do it once per login) but guessing billions takes forever.

| Algorithm | Notes |
|---|---|
| **bcrypt** (1999) | Cost factor: each +1 doubles the work. Common: cost 10–12. Only uses the first 72 bytes of the password. |
| **scrypt** | Also **memory-hard**: needs lots of RAM per guess, which hurts GPUs and custom chips. Built into Node. |
| **Argon2id** | Winner of the Password Hashing Competition (2015). Memory-hard, tunable. OWASP's first recommendation today. |

Node has scrypt built in, so here's a runnable version:

```js
const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64); // slow, memory-hard
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(actual, expected); // constant-time compare
}

const stored = hashPassword('correct horse battery staple');
console.log(verifyPassword('correct horse battery staple', stored)); // true
console.log(verifyPassword('hunter2', stored));                      // false
```

`timingSafeEqual` matters: a normal `===` on strings can stop at the first different character, and attackers can measure that tiny time difference to guess the hash byte by byte.

### The math of slowness

An attacker steals the database and tries all 8-character lowercase passwords: `26^8 ≈ 208.8 billion` guesses.

```text
Unsalted SHA-256, ~10 billion guesses/s on one GPU:
  208.8e9 / 1e10 ≈ 21 seconds

bcrypt cost 12, a few thousand guesses/s on the same GPU (say 2,000):
  208.8e9 / 2e3 ≈ 1.04e8 seconds ≈ 3.3 years
```

Same password, from "21 seconds" to "years". (Exact speeds depend on hardware, but the gap of a million times or more is the point.) Longer passwords help even more: each extra lowercase letter multiplies the work by 26.

## Sessions vs tokens

After login, how does the server recognize you on the next request?

### Server-side sessions

The server creates a random **session ID** (e.g. 32 random bytes), stores `sessionId → { userId, expiresAt }` in a database or Redis (Day 29), and sends the ID in a cookie:

```text
Set-Cookie: sid=9f8a7c...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400
```

- `HttpOnly`: JavaScript can't read it, so an XSS bug (Day 48) can't steal it.
- `Secure`: only sent over HTTPS.
- `SameSite=Lax`: not sent on most cross-site requests, which blocks most CSRF (Day 48).

Logout or "kick this user out" is easy: delete the session row. The cost is a lookup on every request (a few hundred microseconds to Redis).

### Tokens and JWTs

A **JSON Web Token (JWT)** is a self-contained, **signed** token. It has three base64url parts separated by dots:

```text
eyJhbGciOiJIUzI1NiJ9 . eyJzdWIiOiJ1XzgxMiIsInJvbGUiOiJhZG1pbiIsImV4cCI6MTc5MDAwMDAwMH0 . Qm9n...
      header                            payload (the claims)                               signature
{"alg":"HS256"}        {"sub":"u_812","role":"admin","exp":1790000000}
```

The server signs `header.payload` with a secret (HMAC, `HS256`) or a private key (`RS256`, `ES256`). Any server that has the key can **verify** the token without a database lookup. That's the appeal: stateless, easy across many services.

Decoding is trivial, which surprises many people:

```js
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzgxMiIsInJvbGUiOiJhZG1pbiJ9.sig';
const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
console.log(payload); // { sub: 'u_812', role: 'admin' }
```

So: a JWT is **signed, not encrypted**. Anyone can read it; only the key holder can create a valid one. Never put secrets in it, and never trust it without verifying the signature, the `exp` (expiry) claim, and the algorithm you expect (old libraries accepted `"alg": "none"`, which meant "no signature").

The big trade-off is **revocation**. A JWT valid until 5 p.m. stays valid until 5 p.m., even if the user logs out or is banned. The common fix: **short-lived access tokens** (5–15 minutes) plus a long-lived **refresh token** stored server-side, which can be revoked.

| | Server sessions | JWT access tokens |
|---|---|---|
| Lookup per request | Yes (session store) | No (verify signature) |
| Revoke immediately | Easy | Hard; wait for expiry or keep a denylist |
| Size | ~32-byte ID | Often 500+ bytes on every request |
| Good for | Classic web apps | Service-to-service, APIs, many independent services |

## OAuth 2.0 and OpenID Connect

**OAuth 2.0** solves *delegated authorization*: letting an app act on your behalf at another service without giving it your password. "Allow PhotoPrinter to read your Google Photos." **OpenID Connect (OIDC)** is a thin layer on top that adds *authentication*: "Sign in with Google" gives the app an **ID token** (a JWT) saying who you are.

The **authorization code flow** (with **PKCE**, pronounced "pixie"):

```text
1. App → browser redirect to accounts.google.com/authorize
        ?client_id=...&redirect_uri=...&scope=openid email
        &state=<random>&code_challenge=<hash of a random secret>
2. User logs in at Google and clicks "Allow"
3. Google → redirect back to app's redirect_uri?code=<one-time code>&state=...
4. App backend → POST google token endpoint: code + code_verifier (the secret)
5. Google → { access_token, id_token, refresh_token }
6. App verifies id_token signature → "this is user 1234, kim@example.com"
```

Why the extra code step instead of handing the token to the browser directly? The code travels through the browser's URL bar, history and possibly logs; it's single-use, short-lived, and useless without the client's secret or PKCE verifier. Tokens then go over a direct back-channel. The `state` value ties the response to the request, blocking CSRF on the login.

## Authorization: who can do what

Once you know who someone is:

- **RBAC (role-based access control):** users get roles (`viewer`, `editor`, `admin`); roles get permissions (`doc:read`, `doc:delete`). Simple and common.
- **ABAC (attribute-based):** rules over attributes: "editors can edit documents in their own department during business hours". More flexible, more complex.
- **Relationship-based (ReBAC):** permissions follow relationships, like Google Drive sharing: "can view if owner, or shared with you, or shared with a group you're in". Google's Zanzibar paper describes this at huge scale.

Two golden rules:

1. **Check on the server, on every request.** Hiding a button in the UI is not security.
2. **Check the object, not just the role.** `GET /invoices/1043` must verify that invoice 1043 belongs to *this* user. Forgetting this is called **IDOR** (insecure direct object reference) and is one of the most common real bugs: change the number in the URL, see someone else's data.

## In an interview

You'll get "design login" or it will come up inside a bigger design. Interviewers listen for: salted slow password hashing, secure cookie flags, the session vs JWT trade-off (especially revocation), OAuth/OIDC used correctly, and server-side per-object authorization.

A strong answer: *"Passwords are hashed with Argon2id or bcrypt with a per-user salt, and compared in constant time. For our web app I'd use server-side sessions in Redis with an HttpOnly, Secure, SameSite cookie, because instant revocation matters. For our APIs between services I'd use short-lived signed JWTs, 10 minutes, with refresh tokens we can revoke. Social login uses OIDC's authorization code flow with PKCE and state. Authorization is RBAC plus ownership checks on every object on the server, to avoid IDOR."*

## Common mistakes

- **Plain or fast hashes** (MD5, SHA-1, SHA-256 alone). Use bcrypt, scrypt or Argon2id with a salt.
- **Thinking JWTs are encrypted.** They're readable by anyone; they're only tamper-proof.
- **Decoding a JWT without verifying it.** That trusts whatever the client sent.
- **Long-lived JWTs with no revocation plan.**
- **Different error messages for "no such user" and "wrong password".** That lets attackers discover which emails have accounts (**user enumeration**). Say "invalid email or password".
- **Authorization only in the frontend**, or checking the role but not ownership of the object.

## Before moving on

- [ ] I can explain authn vs authz and 401 vs 403
- [ ] I can explain why passwords need a salt and a slow hash, with the brute-force math
- [ ] I can compare sessions and JWTs, including revocation
- [ ] I can decode a JWT by hand and say what's in each part
- [ ] I can walk through the OAuth authorization code flow with PKCE
- [ ] I can explain IDOR and how to prevent it

## Go deeper (optional)

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [jwt.io introduction to JSON Web Tokens](https://jwt.io/introduction)
- [RFC 6749: The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749) and [RFC 7636: PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
- [MDN: Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie)
