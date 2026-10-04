# Cryptography and TLS

> Every HTTPS request crosses networks you don't control: café Wi-Fi, ISPs, other countries. TLS is what stops anyone along the way from reading or changing your data, and what proves you're talking to the real bank. Today you'll see the actual math with small numbers, then how the pieces fit into the TLS handshake.

## The big idea

You want to send a secret letter through a postal system where every mail carrier is nosy. You need three things:

1. **Confidentiality:** carriers can't read it. → **encryption**
2. **Integrity:** carriers can't change it without you noticing. → **MACs / authenticated encryption**
3. **Authenticity:** you're sure the reply came from your bank, not an impostor. → **certificates and signatures**

The hard part is the first step: if you've never met the bank, how do you agree on a secret key when everything you say is overheard? That puzzle was solved in the 1970s with **public-key cryptography**, and it's one of the most beautiful ideas in computing.

## Symmetric encryption: one shared key

**Symmetric** means the *same* key locks and unlocks, like a house key. Alice and Bob both have key `K`:

```text
ciphertext = encrypt(K, "meet at noon")    →  "8f1c9a0e..."
plaintext  = decrypt(K, "8f1c9a0e...")     →  "meet at noon"
```

The modern standard is **AES** (Advanced Encryption Standard) with 128- or 256-bit keys, plus **ChaCha20** as a popular alternative. They're extremely fast: CPUs have AES instructions built in and can encrypt several GB per second per core. Brute force is hopeless: a 128-bit key has `2^128 ≈ 3.4 × 10^38` possibilities. Even at a trillion (10^12) guesses per second, trying them all takes about `10^19` years, roughly a billion times the age of the universe.

Modern TLS uses **authenticated encryption** (AES-GCM, ChaCha20-Poly1305), which encrypts *and* attaches a tag that detects any tampering. That covers both confidentiality and integrity.

The problem: **how do Alice and Bob get the same key in the first place**, if they've never met and every message is overheard?

## Asymmetric encryption: a key pair

**Asymmetric** (public-key) crypto gives each party **two** linked keys:

- a **public key** you hand out to everyone, and
- a **private key** you never share.

Analogy: an open padlock. You mail out hundreds of open padlocks (public key). Anyone can snap one shut on a box, but only you have the key that opens them (private key). It's also used the other way round for **signatures**: you do something only your private key can do, and anyone can check it with your public key.

Asymmetric operations are roughly 1,000 times slower than symmetric ones, so real systems use asymmetric crypto only to **agree on a key** and **prove identity**, then switch to fast symmetric encryption for the data. That's exactly what TLS does.

## Diffie–Hellman with small numbers

How can two people agree on a secret while an eavesdropper hears everything? The trick is a one-way operation: **modular exponentiation**. `g^a mod p` is easy to compute, but given the result, finding `a` (the **discrete logarithm**) is believed to be infeasible when numbers are huge.

(`mod` means remainder after division: `17 mod 5 = 2`, the same as JS `17 % 5`.)

Let's do it with tiny numbers:

```text
Public, everyone knows:   p = 23 (a prime),  g = 5

Alice picks a secret a = 6        Bob picks a secret b = 15
Alice sends A = 5^6  mod 23       Bob sends  B = 5^15 mod 23
         = 15,625 mod 23 = 8               = 19

Eavesdropper Eve sees: p=23, g=5, A=8, B=19

Alice computes B^a mod 23 = 19^6  mod 23 = 2
Bob   computes A^b mod 23 = 8^15  mod 23 = 2     ← same secret!
```

Why they match: `B^a = (g^b)^a = g^(ab)` and `A^b = (g^a)^b = g^(ab)`. Eve knows `g^a` and `g^b` but can't get `g^(ab)` without solving for `a` or `b`. With `p = 23` she could just try all 22 options. With real sizes (a 2048-bit `p`, or the elliptic-curve version **ECDHE** with 256-bit keys, which modern TLS uses), it's out of reach.

Run it yourself (BigInt because the numbers get big fast):

```js
function modPow(base, exp, mod) {          // square-and-multiply
  let result = 1n; base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}
const p = 23n, g = 5n, a = 6n, b = 15n;
const A = modPow(g, a, p), B = modPow(g, b, p);
console.log(A, B, modPow(B, a, p), modPow(A, b, p)); // 8n 19n 2n 2n
```

**Key point:** Diffie–Hellman gives a shared secret but no proof of *who* you share it with. A **man-in-the-middle** could run DH with Alice *and* separately with Bob, and relay everything. That's why we also need signatures and certificates.

## Toy RSA

**RSA** is the classic public-key system usable for both encryption and signatures. Its security rests on how hard it is to **factor** a large number into its primes.

```text
1. Pick two primes:          p = 61, q = 53
2. n = p × q               = 3233          (public)
3. φ(n) = (p−1)(q−1)       = 60 × 52 = 3120 (secret)
4. Pick e coprime to 3120:   e = 17         (public exponent)
5. Find d with e×d ≡ 1 (mod 3120):
                             d = 2753       (17 × 2753 = 46,801 = 15 × 3120 + 1)

Public key:  (n=3233, e=17)      Private key: (n=3233, d=2753)

Encrypt message m = 65:   c = 65^17   mod 3233 = 2790
Decrypt:                  m = 2790^2753 mod 3233 = 65  ✓
```

Anyone can encrypt with `(n, e)`; only the holder of `d` can decrypt. To find `d` you need `φ(n)`, which needs `p` and `q`, which needs factoring `n`. Factoring 3233 is instant; factoring a 2048-bit `n` (617 decimal digits) is beyond any known classical computer.

**Signatures** run it backwards: the owner computes `s = hash(message)^d mod n`; anyone checks `s^e mod n == hash(message)`. Only the private-key holder could have produced `s`.

(Real RSA adds padding schemes; never implement crypto yourself for production. Use vetted libraries.)

## Certificates: who owns this public key?

When `bank.com` sends you its public key, how do you know it's really the bank's and not Eve's? A **certificate** is a document that says *"the public key X belongs to bank.com, valid until March 2027"*, **signed** by a **Certificate Authority (CA)** such as Let's Encrypt or DigiCert.

Your OS and browser ship with ~100–150 trusted **root CA** public keys. Verification follows a **chain of trust**:

```text
 Root CA (in your OS trust store, self-signed)
   └─ signs → Intermediate CA certificate
                └─ signs → bank.com certificate (contains bank.com's public key)
```

The browser checks: every signature in the chain is valid, the name matches the site you typed, the dates are valid, and it isn't revoked. Let's Encrypt made certificates free and automated (90-day lifetimes, renewed automatically), which is a big reason most of the web is HTTPS today.

## The TLS 1.3 handshake

TLS ("Transport Layer Security", successor of SSL) runs right after the TCP handshake. TLS 1.3 (2018) needs **1 round trip**:

```text
 Client                                                Server
   | --- ClientHello -------------------------------->  |
   |     supported ciphers, random,                     |
   |     key share (client's DH public value, ECDHE)    |
   |                                                    |
   | <-- ServerHello + key share (server's DH value) -- |
   |     {Certificate}  {CertificateVerify: signature   |
   |      over the handshake with the cert's private    |
   |      key}  {Finished}                              |
   |                                                    |
   |  both sides now compute the same shared secret     |
   |  and derive symmetric keys (e.g. AES-GCM)          |
   |                                                    |
   | --- {Finished} {HTTP request, encrypted} -------->  |
   | <-- {HTTP response, encrypted} ------------------  |

 {…} = encrypted
```

How it fits together:

1. **Key exchange:** ECDHE (Diffie–Hellman on elliptic curves) gives both sides a shared secret.
2. **Authentication:** the server signs the handshake with the private key matching its certificate, proving it's the real `bank.com` and defeating the man-in-the-middle.
3. **Bulk encryption:** all data then flows under fast symmetric authenticated encryption.

Because fresh DH keys are generated for each connection and then discarded, stealing the server's private key later doesn't decrypt old recorded traffic. That property is **forward secrecy**. (Old TLS used RSA to encrypt the key directly, which lacked it; TLS 1.3 removed that option.)

## The math: what TLS costs in time

With RTT = 100 ms, before the first byte of the HTTP response:

```text
TCP handshake          1 RTT   100 ms
TLS 1.2 handshake      2 RTT   200 ms
HTTP request/response  1 RTT   100 ms   → total 400 ms
-------------------------------------------------
TCP handshake          1 RTT   100 ms
TLS 1.3 handshake      1 RTT   100 ms
HTTP request/response  1 RTT   100 ms   → total 300 ms
-------------------------------------------------
HTTP/3 (QUIC + TLS 1.3 combined) 1 RTT + request 1 RTT → 200 ms
Resumed session with 0-RTT data: request goes in the first flight → ~100 ms
```

CPU cost is small today: a modern server does thousands of handshakes per second per core, and bulk encryption at GB/s. The real cost is **round trips**, which is why connection reuse and TLS session resumption matter.

## In an interview

Expect: "How does HTTPS work?", "symmetric vs asymmetric?", "what does a certificate prove?", "where would you terminate TLS?" (usually at the load balancer or CDN edge, then re-encrypt or use a trusted private network internally; Day 28).

A strong answer: *"TLS uses asymmetric crypto to set up and symmetric crypto to do the work. In TLS 1.3 the client and server do an ephemeral elliptic-curve Diffie–Hellman exchange in one round trip to agree on a secret nobody listening can compute. The server proves its identity by signing the handshake with its certificate's private key; the certificate is signed by a CA the browser trusts, so a man-in-the-middle can't impersonate it. Both sides derive AES-GCM or ChaCha20 keys from the shared secret, giving confidentiality and integrity, and because the DH keys are ephemeral we get forward secrecy."*

## Common mistakes

- **"HTTPS hides which site I visit."** The IP address is visible, and the hostname usually is too (in the SNI field of ClientHello) unless Encrypted Client Hello is used. Paths, headers and bodies are hidden.
- **"Encryption = hashing."** Hashing (SHA-256, Day 25) is one-way with no key; encryption is reversible with the key.
- **"Asymmetric crypto encrypts the whole connection."** It only sets up keys and proves identity; symmetric crypto encrypts the data.
- **"The padlock means the site is trustworthy."** It means the connection is private and the domain is verified. A phishing site can have a valid certificate for its own lookalike domain.
- **Rolling your own crypto.** Use TLS libraries and well-known primitives.

## Before moving on

- [ ] I can explain symmetric vs asymmetric and why TLS uses both
- [ ] I can do Diffie–Hellman with small numbers by hand
- [ ] I can run toy RSA (keys, encrypt, decrypt) and explain why factoring matters
- [ ] I can explain what a certificate and the chain of trust prove
- [ ] I can sketch the TLS 1.3 handshake and count its round trips

## Go deeper (optional)

- [Wikipedia: Diffie–Hellman key exchange](https://en.wikipedia.org/wiki/Diffie%E2%80%93Hellman_key_exchange)
- [Wikipedia: RSA (cryptosystem)](https://en.wikipedia.org/wiki/RSA_(cryptosystem))
- [Cloudflare Learning Center: What happens in a TLS handshake?](https://www.cloudflare.com/learning/ssl/what-happens-in-a-tls-handshake/)
- [RFC 8446: TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446)
- *Serious Cryptography* by Jean-Philippe Aumasson
