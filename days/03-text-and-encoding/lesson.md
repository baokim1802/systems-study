# Text and Encoding

> A computer only stores numbers, so every letter, accent and emoji needs an agreed number and an agreed way to turn that number into bytes. Get it wrong and you see `Ã©` instead of `é`, emoji that break your database, or a string whose `.length` is "wrong".

## The big idea

Think of a secret decoder ring shared by two friends: `1 = A, 2 = B, 3 = C`. The message `3 1 2` means "CAB" only if both friends use **the same ring**. Use a different ring and you read nonsense.

Text in computers works exactly like this, in two separate steps that people often mix up:

1. **Character set**: which number each character gets. (`A` is 65, `é` is 233, `😀` is 128,512.)
2. **Encoding**: how that number is written as bytes. (233 could be one byte, two bytes, or four bytes, depending on the scheme.)

Yesterday (Day 02) you saw that bits mean nothing until you agree on how to read them. Text is the most common place that agreement breaks.

## ASCII: the original 128

In 1963 the US standardized **ASCII**: 128 characters numbered 0–127, which fit in 7 bits.

| Range | What |
|---|---|
| 0–31 | invisible control characters: `10` is newline (`\n`), `13` carriage return (`\r`), `9` tab |
| 32 | space |
| 48–57 | digits `0`–`9` |
| 65–90 | `A`–`Z` |
| 97–122 | `a`–`z` |

Two nice design details: `'a' - 'A' = 32` (one bit flips between upper and lower case), and the digit `'7'` is code `55`, so `'7' - '0' = 7`.

```js
"A".charCodeAt(0);            // 65
String.fromCharCode(97);      // "a"
"7".charCodeAt(0) - 48;       // 7
```

ASCII has no `é`, no `ñ`, no `中`, no `😀`. For decades every region invented its own 8-bit extension (Latin-1 for Western Europe, Windows-1252, Shift-JIS for Japanese...). The same byte meant different letters in different places, which is how you get garbled text.

## Unicode: one number for every character

**Unicode** fixes the character-set half of the problem: one giant table that gives every character in every writing system a unique number called a **code point**, written `U+` plus hex.

```text
A    U+0041        (65)
é    U+00E9        (233)
€    U+20AC        (8,364)
中   U+4E2D        (20,013)
😀   U+1F600       (128,512)
```

Code points go from `U+0000` to `U+10FFFF` — room for 1,114,112 characters, about 150,000 of which are assigned today. The first 128 are identical to ASCII on purpose.

Unicode alone does **not** say how to store `U+1F600` in bytes. That is the job of an encoding: UTF-8, UTF-16 or UTF-32.

## UTF-8: the encoding of the web

**UTF-8** stores each code point in 1 to 4 bytes. Small numbers (ASCII) use 1 byte; bigger numbers use more. About 98% of web pages are UTF-8.

The byte layout is clever. The first bits of each byte tell you what kind of byte it is:

```text
Code point range     Bytes  Bit pattern
U+0000  – U+007F       1    0xxxxxxx
U+0080  – U+07FF       2    110xxxxx 10xxxxxx
U+0800  – U+FFFF       3    1110xxxx 10xxxxxx 10xxxxxx
U+10000 – U+10FFFF     4    11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
```

- A byte starting with `0` is a whole ASCII character.
- A byte starting with `110`, `1110`, or `11110` **starts** a 2-, 3- or 4-byte character.
- A byte starting with `10` is a **continuation** byte.

### Worked example: encoding `é` (U+00E9)

```text
U+00E9 = 233 = 1110 1001 (binary)
It is between 0x80 and 0x7FF → 2 bytes, 11 payload bits
pad to 11 bits:          000 1110 1001  → split 5 + 6: 00011 | 101001
first byte:   110 00011 = 1100 0011 = 0xC3
second byte:  10 101001 = 1010 1001 = 0xA9
é in UTF-8 = C3 A9
```

And `€` (U+20AC) becomes `E2 82 AC`, `😀` (U+1F600) becomes `F0 9F 98 80`.

Why UTF-8 won:

- **ASCII-compatible.** Every old ASCII file is already valid UTF-8.
- **Self-synchronizing.** Jump into the middle of a file and you can find the next character start (skip bytes that begin with `10`).
- **No zero bytes** inside non-null characters, so old C code that treats byte `0` as "end of string" keeps working.
- **Compact for English and code**, which dominate the web and protocols.

You can see the bytes in JavaScript with `TextEncoder`:

```js
const enc = new TextEncoder();      // always UTF-8
enc.encode("A");      // Uint8Array [65]
enc.encode("é");      // Uint8Array [195, 169]        = C3 A9
enc.encode("€");      // Uint8Array [226, 130, 172]   = E2 82 AC
enc.encode("😀");     // Uint8Array [240, 159, 152, 128]
enc.encode("héllo").length;   // 6 bytes for 5 characters
```

### Mojibake: when the rings don't match

If bytes written as UTF-8 are read as Latin-1 (one byte = one character), `C3 A9` becomes two characters: `Ã` (C3) and `©` (A9). So `café` shows as `cafÃ©`. That garbage has a name: **mojibake** (Japanese for "character transformation"). The fix is always the same: declare the encoding everywhere — HTTP `Content-Type: text/html; charset=utf-8`, `<meta charset="utf-8">`, the database column, the file.

## JavaScript strings are UTF-16

Here is the surprise. Inside JavaScript (and Java, C#, Windows), strings are stored as **UTF-16**: a sequence of 16-bit **code units**.

- Code points up to `U+FFFF` (the "Basic Multilingual Plane", which covers almost all living languages) fit in **one** 16-bit unit.
- Code points above that, like most emoji, need **two** units, called a **surrogate pair**.

`.length` counts **code units**, not characters:

```js
"hello".length;        // 5
"é".length;            // 1
"😀".length;           // 2   (surrogate pair: \uD83D \uDE00)
[..."😀"].length;      // 1   (spread iterates by code point)
"😀".codePointAt(0);   // 128512
"😀".slice(0, 1);      // "\uD83D" — half an emoji, renders as �
```

It gets one level deeper. What a human calls "one character" (a **grapheme**) can be several code points. The family emoji `👨‍👩‍👧` is three people joined by two invisible "zero width joiners": 5 code points, `.length` 8. A flag like 🇯🇵 is two "regional indicator" code points.

```js
const s = "👨‍👩‍👧";
s.length;                                        // 8
[...s].length;                                   // 5
[...new Intl.Segmenter().segment(s)].length;     // 1  (what a user sees)
```

Practical rule: to count or cut what users see (a tweet limit, truncating a name), use `Intl.Segmenter` or at least `[...str]`; never `str.slice` at an arbitrary index.

| Encoding | Unit | `A` | `é` | `中` | `😀` |
|---|---|---|---|---|---|
| UTF-8 | 1 byte | 1 B | 2 B | 3 B | 4 B |
| UTF-16 | 2 bytes | 2 B | 2 B | 2 B | 4 B |
| UTF-32 | 4 bytes | 4 B | 4 B | 4 B | 4 B |

A classic database gotcha: MySQL's old `utf8` charset allows only up to **3 bytes** per character, so storing an emoji fails or gets truncated. You need `utf8mb4` ("max bytes 4").

## Base64: bytes that survive text-only channels

Some channels only safely carry plain text: email bodies, JSON strings, URLs, HTTP headers. How do you put an image or random bytes (which may contain any value 0–255, including newlines and quotes) through them?

**Base64** turns any bytes into 64 safe characters: `A–Z a–z 0–9 + /`. The trick: `2^6 = 64`, so each character carries **6 bits**. Three bytes (24 bits) become exactly four characters.

```text
text:      M        a        n
ASCII:     77       97       110
bits:      01001101 01100001 01101110
regroup:   010011 010110 000101 101110
values:    19     22     5      46
base64:    T      W      F      u        → "TWFu"
```

If the input length is not a multiple of 3, `=` padding fills the last group: `"hi"` → `"aGk="`.

```js
btoa("Man");                  // "TWFu"   (btoa only accepts Latin-1 chars!)
atob("TWFu");                 // "Man"
// Node:
Buffer.from("héllo").toString("base64");     // "aMOpbGxv"
Buffer.from("aMOpbGxv", "base64").toString(); // "héllo"
```

**Cost: 4 output bytes per 3 input bytes, about 33% bigger.** A 3 MB image as base64 inside JSON is about 4 MB. That matters at scale: prefer uploading raw bytes (Day 36, presigned URLs) over base64 in JSON.

**Base64 is not encryption.** Anyone can decode it. JWTs (Day 47) are base64url-encoded and readable by anyone. **base64url** swaps `+ /` for `- _` so the result is safe in URLs.

## URL encoding (percent-encoding)

URLs reserve characters for structure: `/` separates path parts, `?` starts the query, `&` separates parameters, `#` starts the fragment, and spaces are not allowed. To put such a character inside a value, you **percent-encode** it: `%` followed by its byte in hex. Non-ASCII characters are first converted to UTF-8 bytes, then each byte is encoded.

```js
encodeURIComponent("a b&c=d");   // "a%20b%26c%3Dd"
encodeURIComponent("café");      // "caf%C3%A9"   ← UTF-8 bytes C3 A9
decodeURIComponent("caf%C3%A9"); // "café"
encodeURI("https://x.com/a b?q=1&r=2"); // keeps : / ? & =, encodes the space
new URLSearchParams({ q: "rock & roll" }).toString(); // "q=rock+%26+roll"
```

Use `encodeURIComponent` for a single value you insert into a URL; `encodeURI` for a whole URL. In HTML forms, a space is often written `+` instead of `%20`.

Forgetting to encode is a classic bug: a search for `rock & roll` sent as `?q=rock & roll` arrives at the server as `q=rock ` plus a stray parameter `roll`.

## The math: how big is my text?

```text
1 million tweets × 280 chars, mostly English (1 byte each in UTF-8)
  ≈ 280 MB
Same tweets in Chinese (3 bytes per char in UTF-8)
  ≈ 840 MB
A 30 KB thumbnail sent as base64 in JSON
  = 30 × 4/3 = 40 KB  (exactly: ceil(30,000 / 3) × 4 = 40,000 bytes)
```

In estimates (Day 26), "1 byte per character for English, more for other scripts" is a fine assumption, as long as you say it.

## In an interview

- "Why does `'😀'.length` return 2?" — JS strings are UTF-16 code units; emoji above U+FFFF need a surrogate pair.
- "Users see `Ã©` in their names." — UTF-8 bytes decoded as Latin-1; set the charset everywhere, check the DB column (`utf8mb4`).
- "How would you send a file in a JSON API?" — base64 works but adds 33%; better, upload binary directly.
- "Is base64 secure?" — no, it is an encoding, not encryption.

A strong one-liner: *"Unicode assigns every character a code point; UTF-8 encodes code points in 1–4 bytes and is ASCII-compatible, which is why the web uses it. JavaScript stores strings as UTF-16, so `.length` counts 16-bit units, not characters."*

## Common mistakes

- **"Unicode is an encoding."** It is a character set. UTF-8/16/32 are encodings of it.
- **"One character = one byte."** Only for ASCII in UTF-8.
- **Trusting `.length` for user-visible length.** Use `Intl.Segmenter` for graphemes.
- **Treating base64 as obfuscation or security.** Decoding is one function call.
- **Building URLs with string concatenation.** Use `encodeURIComponent` or `URLSearchParams`.

## Before moving on

- [ ] I can explain the difference between a code point and an encoding
- [ ] I can encode a 2-byte character like `é` into UTF-8 by hand
- [ ] I can explain why `"😀".length === 2`
- [ ] I can compute base64 size overhead and explain when to use base64
- [ ] I know when to use `encodeURIComponent`

## Go deeper (optional)

- [UTF-8 — Wikipedia](https://en.wikipedia.org/wiki/UTF-8)
- [Base64 — Wikipedia](https://en.wikipedia.org/wiki/Base64)
- [String — MDN (UTF-16 characters, Unicode code points, and grapheme clusters)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String)
- [Intl.Segmenter — MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter)
- Joel Spolsky, "The Absolute Minimum Every Software Developer Absolutely, Positively Must Know About Unicode and Character Sets" (2003)
