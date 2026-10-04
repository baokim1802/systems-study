# Bits, Bytes and Number Systems

> Everything a computer stores — your photos, this text, a bank balance — is a long row of 0s and 1s. Knowing how numbers become bits explains real bugs (overflow, `0.1 + 0.2`), and gives you the powers of two you will use in every system design estimate.

## The big idea

Picture a row of light switches. Each switch is either **off (0)** or **on (1)**. One switch can say two things. Two switches can say four things (off-off, off-on, on-off, on-on). Every switch you add **doubles** the number of patterns.

That switch is a **bit** (short for *binary digit*). Computers use bits because electronics are very good at telling "voltage high" from "voltage low" and terrible at telling apart ten different voltage levels reliably.

- **Bit**: one 0 or 1.
- **Byte**: 8 bits. The smallest chunk a computer normally addresses (gives a name to). One byte has `2^8 = 256` patterns, so it can hold 0 to 255.
- **Word**: the "natural" chunk size of a CPU, today usually 64 bits (8 bytes). That is what people mean by a "64-bit computer".

The whole trick is that a pattern of bits *means nothing by itself*. `01000001` is the number 65, or the letter `A`, or part of a pixel — it depends on how the program agrees to read it. Today is about the agreements for numbers. Tomorrow (Day 03) is the agreements for text.

## Positional number systems

You already know one: **decimal** (base 10). In `472`, each position is worth 10 times the one to its right:

```text
  4        7       2
  4×100 +  7×10 +  2×1   = 472
  4×10^2   7×10^1  2×10^0
```

**Binary** (base 2) is exactly the same idea with only two digits, so each position is worth 2 times the one to its right:

```text
  1     0     1     1     0     1
  ×32   ×16   ×8    ×4    ×2    ×1
  32  +  0  +  8  +  4  +  0  +  1   = 45
```

So `101101` in binary is 45 in decimal. To go the other way, keep dividing by 2 and read the remainders bottom-up:

```text
45 / 2 = 22 r 1   ← lowest bit
22 / 2 = 11 r 0
11 / 2 =  5 r 1
 5 / 2 =  2 r 1
 2 / 2 =  1 r 0
 1 / 2 =  0 r 1   ← highest bit
read upward: 101101
```

### Hexadecimal: binary for humans

Long binary strings are hard to read. **Hexadecimal** (base 16, "hex") uses digits `0–9` then `A–F` for 10–15. The magic: **one hex digit is exactly four bits** (`2^4 = 16`), so two hex digits are exactly one byte.

| Decimal | Binary | Hex |
|---|---|---|
| 0 | 0000 | 0 |
| 9 | 1001 | 9 |
| 10 | 1010 | A |
| 15 | 1111 | F |
| 255 | 1111 1111 | FF |

You see hex everywhere: colors (`#FF8800` = red 255, green 136, blue 0), memory addresses (`0x7ffe3a10`), hashes (`a94a8fe5...`), and byte dumps. The `0x` prefix just means "this is hex".

```js
(45).toString(2);        // "101101"
(255).toString(16);      // "ff"
parseInt("101101", 2);   // 45
parseInt("ff", 16);      // 255
0b101101;                // 45  (binary literal)
0xff;                    // 255 (hex literal)
```

## Powers of two you should just know

These show up in memory sizes, ID spaces, and estimation questions (Day 26). Learn the first column cold.

| Power | Exact value | Roughly | Name |
|---|---|---|---|
| `2^8` | 256 | — | values in a byte |
| `2^10` | 1,024 | a thousand | KiB (kibibyte) |
| `2^16` | 65,536 | 65 thousand | port numbers, old `short` int |
| `2^20` | 1,048,576 | a million | MiB |
| `2^30` | 1,073,741,824 | a billion | GiB |
| `2^32` | 4,294,967,296 | 4.3 billion | IPv4 addresses, 32-bit ints |
| `2^40` | ≈ 1.1 × 10^12 | a trillion | TiB |
| `2^53` | 9,007,199,254,740,992 | 9 quadrillion | JS safe integer limit |
| `2^64` | ≈ 1.8 × 10^19 | 18 quintillion | 64-bit ints |

The rule of thumb: **`2^10 ≈ 10^3`**. So `2^32 = 2^2 × 2^30 ≈ 4 × 1 billion`. To estimate any power, split it into tens.

A small naming wrinkle: storage vendors use **KB = 1000 bytes** (decimal), while operating systems often show **KiB = 1024 bytes**. That is why a "1 TB" drive shows up as about 931 GiB (`10^12 / 2^30 ≈ 931`). In interviews, using 1000 is fine and expected.

## Negative numbers: two's complement

With 8 bits we get 256 patterns. For **unsigned** numbers we use them as 0..255. But how do we store `-5`?

The idea that won is **two's complement**: give the top bit a *negative* weight.

```text
bit weights for an 8-bit signed number:
 -128   64   32   16    8    4    2    1
   1     1    1    1    1    0    1    1   = -128+64+32+16+8+2+1 = -5
```

So the range of a signed 8-bit number is `-128 .. 127`. In general, `n` bits signed hold `-2^(n-1) .. 2^(n-1) - 1`. For 32 bits that is about ±2.1 billion (`2,147,483,647` at the top — remember this number).

To negate a number by hand: **flip every bit, then add 1**.

```text
 5   = 0000 0101
flip = 1111 1010
 +1  = 1111 1011   = -5  ✓
```

Why this design? Because ordinary addition just works. `5 + (-5)`: `0000 0101 + 1111 1011 = 1 0000 0000`, and the 9th bit falls off, leaving `0000 0000`. The CPU needs **one** adder circuit for both signed and unsigned numbers.

## Overflow: when the odometer rolls over

An old car odometer with 6 digits goes from `999999` to `000000`. Fixed-size integers do the same thing. Add 1 to the largest 32-bit signed integer and you get the most negative one:

```text
 0111 1111 ... 1111   =  2,147,483,647
+                  1
 1000 0000 ... 0000   = -2,147,483,648
```

This is **integer overflow**, and it has caused real disasters: the Ariane 5 rocket (1996) was lost partly because a 64-bit float was converted to a 16-bit integer that could not hold it; the "Gangnam Style" video broke YouTube's 32-bit view counter in 2014; and Unix time stored in a signed 32-bit integer overflows on **19 January 2038**.

JavaScript lets you see this through its bitwise operators, which convert numbers to 32-bit signed integers first:

```js
2147483647 + 1;          // 2147483648  (normal JS number, fine)
(2147483647 + 1) | 0;    // -2147483648 (forced into 32 bits: overflow!)
Math.imul(65536, 65536); // 0  (2^32 wraps around to 0 in 32 bits)
```

In a system design interview, overflow shows up as: "Is a 32-bit ID enough?" If you create 100 million rows a day, `2^31 ≈ 2.1 billion` lasts about 21 days. Use 64-bit IDs.

## Fractions: floating point

How do you store `3.75` or `0.1` in bits? Computers use **floating point**, standardized as **IEEE 754**. It is scientific notation in base 2:

```text
decimal scientific:   6.02 × 10^23
binary floating:      1.111 × 2^1   (= 3.75)
```

A 64-bit float ("double") splits its bits into three fields:

```text
| sign (1) | exponent (11) | fraction / mantissa (52) |
```

- **sign**: positive or negative.
- **exponent**: where the binary point goes (the "× 2^something").
- **mantissa**: the significant digits. With the hidden leading 1, you get 53 bits of precision, about 15–17 decimal digits.

**Every JavaScript `number` is a 64-bit float.** There is no separate integer type (except `BigInt`). This is why `Number.MAX_SAFE_INTEGER` is `2^53 - 1 = 9,007,199,254,740,991`: past that, the 53 bits of mantissa cannot represent every integer.

```js
2 ** 53 === 2 ** 53 + 1;   // true (!) — 2^53 + 1 cannot be represented
9007199254740993n + 1n;    // 9007199254740994n — BigInt is exact
```

Real-world consequence: Twitter's tweet IDs are 64-bit integers. JSON parsed in JavaScript mangled them, so their API added an `id_str` field with the ID as a string.

### Why `0.1 + 0.2 !== 0.3`

In decimal, `1/3 = 0.3333...` never ends. In binary, the same thing happens to `1/10`. A fraction has a finite binary form only if its denominator is a power of two (`1/2`, `1/4`, `3/8`). `1/10` has a factor of 5, so in binary it is:

```text
0.1 (decimal) = 0.0001100110011001100110011... (binary, repeating forever)
```

The float has to cut this off after 53 significant bits, so the stored value is a tiny bit off. `0.1` and `0.2` are both slightly too big, and their rounding errors add up:

```js
0.1 + 0.2;                    // 0.30000000000000004
0.1 + 0.2 === 0.3;            // false
(0.1).toFixed(20);            // "0.10000000000000000555"
Math.abs(0.1 + 0.2 - 0.3) < Number.EPSILON;  // true — compare with a tolerance
```

This is not a JavaScript bug. Python, Java, and C give the same answer, because they all use IEEE 754.

### Money: never use floats

```js
let total = 0;
for (let i = 0; i < 10; i++) total += 0.10;
total;            // 0.9999999999999999, not 1
```

The standard fix: store money as **integers in the smallest unit** (cents), or use a decimal type in the database (`DECIMAL(12,2)` in SQL). `$19.99` is stored as `1999`. Payment APIs such as Stripe do exactly this.

## Bit tricks you will meet

Bits are also used as compact sets of yes/no flags. Unix file permissions are the classic example: `rwx` = read 4, write 2, execute 1, so `chmod 755` means owner `7 = 4+2+1` (rwx), group and others `5 = 4+1` (r-x).

```js
const READ = 0b100, WRITE = 0b010, EXEC = 0b001;
let perms = READ | WRITE;          // turn bits on with OR   -> 0b110 (6)
const canWrite = (perms & WRITE) !== 0;  // test a bit with AND -> true
perms &= ~WRITE;                    // turn a bit off       -> 0b100 (4)
const isPowerOfTwo = n => n > 0 && (n & (n - 1)) === 0;
```

`x << 1` doubles a number, `x >> 1` halves it (rounding down). Bitmaps like this power Bloom filters (Day 25) and database indexes.

## The math: how many bits do I need?

To give a unique ID to `N` things you need `ceil(log2(N))` bits. Use `2^10 ≈ 1000`:

```text
8 billion people:   8 × 10^9 ≈ 2^3 × 2^30 = 2^33  → 33 bits (so 32 is NOT enough)
1 trillion items:   10^12 ≈ 2^40                    → 40 bits
```

Storage of a number column: 10 million rows × 8 bytes (a 64-bit int) = 80 MB. Same column as 4-byte ints = 40 MB. Small choices multiply at scale.

## In an interview

You rarely get asked "convert 45 to binary". You get asked things where this knowledge is load-bearing:

- "Your auto-increment ID is an `INT`. Will it run out?" (signed 32-bit max ≈ 2.1 billion).
- "Why did the frontend show the wrong ID?" (64-bit IDs above `2^53` lose precision in JS; send them as strings).
- "How would you store prices?" (integer cents or decimal, never float).
- Estimation: knowing `2^32 ≈ 4.3 billion` and `2^10 ≈ 1000` makes capacity math fast.

A good short answer to "why is `0.1 + 0.2` not `0.3`?": *"JavaScript numbers are IEEE 754 doubles. 0.1 has no finite binary representation — like 1/3 in decimal — so it is rounded to the nearest of the 2^53-ish representable values. The rounding errors of 0.1 and 0.2 add up to 0.30000000000000004. Compare floats with a tolerance, and keep money in integer cents."*

## Common mistakes

- **"KB is 1024 bytes, always."** Both conventions exist. Say which one you mean, or just use powers of ten in estimates.
- **Thinking JS has integers.** It has 64-bit floats; integers are exact only up to `2^53 - 1`. Use `BigInt` beyond that.
- **Using `>> 1` or `| 0` on big numbers.** Bitwise ops work on 32 bits and silently wrap.
- **Comparing floats with `===`.** Use a tolerance, or avoid floats for exact quantities.
- **Forgetting the sign bit.** A signed 32-bit int tops out at about 2.1 billion, not 4.3 billion.

## Before moving on

- [ ] I can convert between binary, decimal and hex for small numbers
- [ ] I know `2^10, 2^16, 2^20, 2^30, 2^32, 2^53, 2^64` roughly by heart
- [ ] I can explain two's complement and why `INT_MAX + 1` becomes negative
- [ ] I can explain `0.1 + 0.2 !== 0.3` in two sentences and how to store money

## Go deeper (optional)

- [Two's complement — Wikipedia](https://en.wikipedia.org/wiki/Two%27s_complement)
- [IEEE 754 — Wikipedia](https://en.wikipedia.org/wiki/IEEE_754)
- [Number.MAX_SAFE_INTEGER — MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/MAX_SAFE_INTEGER)
- *Code: The Hidden Language of Computer Hardware and Software* by Charles Petzold
