# How a CPU Runs Code

> Every program you have ever written ends up as a list of tiny instructions that a chip executes billions of times per second. Knowing how that loop works explains why some code is mysteriously fast or slow, why we got multi-core chips instead of 10 GHz ones, and what "CPU-bound" means in a design discussion.

## The big idea

Imagine a very fast, very literal cook who can only follow recipe cards. The cards are numbered and stacked in order. The cook's routine never changes:

1. **Fetch**: pick up the next card.
2. **Decode**: read it ("add the flour to the bowl").
3. **Execute**: do it.
4. Move a finger to the next card, and repeat.

The cook has a tiny countertop with room for only a handful of bowls (**registers**), and a huge pantry down the hall (**memory**, RAM). Most cards say things like "bring the sugar from shelf 812 to bowl 2", "add bowl 1 and bowl 2, put it in bowl 3", or "if bowl 3 is empty, jump to card 40".

That cook is the **CPU** (Central Processing Unit). The recipe cards are **machine code**. The loop is the **fetch–decode–execute cycle**, and it is all a CPU ever does.

## The parts of a CPU

```text
             +-------------------------------------------+
             |                    CPU                    |
             |   +------------+      +----------------+  |
             |   | Control    |----->| ALU            |  |
             |   | unit       |      | (+ - * & | <)  |  |
             |   +------------+      +----------------+  |
             |        |                     ^            |
             |   +----v---------------------+---------+  |
             |   | Registers: PC, r0, r1, r2, ... r15 |  |
             |   +------------------------------------+  |
             +---------------------|---------------------+
                                   | (bus, via caches — Day 05)
                          +--------v---------+
                          |   RAM (memory)   |
                          | code + data      |
                          +------------------+
```

- **Registers**: a few dozen tiny storage slots inside the CPU, each one word (64 bits) wide. Reading one takes well under a nanosecond. All arithmetic happens on registers.
- **Program counter (PC)**: a special register holding the memory address of the next instruction. "Jumping" just means writing a new value into the PC.
- **ALU** (Arithmetic Logic Unit): the circuit that actually adds, subtracts, compares, and does bitwise AND/OR.
- **Control unit**: decodes each instruction and tells the other parts what to do.
- **Memory (RAM)**: holds both the program and its data. This "code is just data in memory" idea is the **von Neumann architecture**, used by essentially every computer since the 1940s.

## Machine code and assembly

An instruction is just a number. On an x86-64 chip (most PCs and servers), the bytes `48 01 D8` mean "add register `rbx` into register `rax`". Nobody writes that by hand. **Assembly language** is the human-readable spelling of the same instructions, one line per instruction:

```text
; compute total = price + tax  (x86-64 style, simplified)
mov  rax, [price]     ; load the value at address "price" into register rax
add  rax, [tax]       ; rax = rax + value at "tax"
mov  [total], rax     ; store rax into memory at "total"
```

An **assembler** turns assembly into machine code one-to-one. A **compiler** (C, Rust, Go) turns a high-level language into machine code; JavaScript gets there through an engine that compiles while the program runs (Day 09).

Different chip families speak different **instruction sets** (ISAs): **x86-64** (Intel, AMD) and **ARM** (phones, Apple M-series Macs, AWS Graviton servers). A binary built for one does not run on the other, which is why Docker images come in `amd64` and `arm64` versions (Day 49).

## A CPU in 30 lines of JavaScript

The fastest way to understand the cycle is to build a toy one. This "CPU" has four registers, a program counter, and five instructions. It sums the numbers 1 to 5.

```js
const program = [
  ["LOAD", "r0", 0],      // 0: total = 0
  ["LOAD", "r1", 5],      // 1: i = 5
  ["ADD",  "r0", "r1"],   // 2: total += i
  ["DEC",  "r1"],         // 3: i -= 1
  ["JNZ",  "r1", 2],      // 4: if i !== 0, jump to instruction 2
  ["HALT"],               // 5: stop
];

function run(program) {
  const reg = { r0: 0, r1: 0, r2: 0, r3: 0 };
  let pc = 0, cycles = 0;
  while (true) {
    const [op, a, b] = program[pc];     // FETCH
    pc += 1;                            // point at the next card
    cycles += 1;
    switch (op) {                       // DECODE ...
      case "LOAD": reg[a] = b; break;   // ... and EXECUTE
      case "ADD":  reg[a] += reg[b]; break;
      case "DEC":  reg[a] -= 1; break;
      case "JNZ":  if (reg[a] !== 0) pc = b; break;
      case "HALT": return { ...reg, cycles };
    }
  }
}
console.log(run(program)); // { r0: 15, r1: 0, ..., cycles: 18 }
```

Notice that a loop is not a special feature: it is a conditional jump that writes an earlier address into the PC. Every `for`, `while`, `if` and function call you write compiles down to jumps like this.

## Clock speed: the heartbeat

A CPU is driven by a **clock**, a signal that ticks at a fixed rate. Each tick is a **cycle**, and parts of the chip advance one step per cycle.

```text
3 GHz  = 3,000,000,000 cycles per second
1 cycle = 1 / 3×10^9 s ≈ 0.33 nanoseconds
```

In 0.33 ns, light travels only about 10 cm. That is part of why chips are small and why memory far away from the CPU is slow (Day 05).

Clock speed alone does not tell you how fast a chip is. What matters is:

```text
time = instructions × cycles per instruction (CPI) × seconds per cycle
```

Modern cores execute several instructions per cycle (**IPC**, instructions per cycle, often 2–4 on real code), so a 3 GHz core can retire roughly 6–12 billion simple instructions per second.

## Pipelining: the laundry trick

Doing laundry takes three steps: wash (30 min), dry (30 min), fold (30 min). Doing four loads one after another takes `4 × 90 = 360` minutes. But once load 1 moves to the dryer, the washer is free for load 2. Overlapping the steps, four loads take `90 + 3 × 30 = 180` minutes. Each load still takes 90 minutes, but you **finish one every 30 minutes**.

CPUs do the same. A classic textbook pipeline has 5 stages:

```text
cycle:      1    2    3    4    5    6    7
instr 1:   IF   ID   EX   MEM  WB
instr 2:        IF   ID   EX   MEM  WB
instr 3:             IF   ID   EX   MEM  WB
IF = fetch, ID = decode, EX = execute, MEM = memory access, WB = write back
```

After the pipeline fills, one instruction completes **every cycle**, even though each takes 5. Real cores go further: they are **superscalar** (several pipelines side by side) and **out-of-order** (they run later independent instructions while an earlier one waits for memory).

Pipelining has a weakness: the CPU must know *which* instruction comes next before the current one finishes. Usually that is just the next card. But at an `if` (a **branch**), the answer depends on a result that is not computed yet.

## Branch prediction: guessing the future

Rather than stall, the CPU **guesses** which way the branch will go and keeps working down that path (**speculative execution**). A **branch predictor** remembers how each branch behaved recently. Loops are easy to predict ("taken, taken, taken... not taken once at the end"). Modern predictors are right well over 95% of the time on typical code.

When it guesses wrong, it throws away the speculative work and restarts. That **misprediction penalty** is around 15–20 cycles on modern cores.

The famous demonstration: summing only the elements `>= 128` of a big array of random bytes runs several times faster if the array is **sorted** first. Sorted, the `if` is false-false-false... then true-true-true, which is perfectly predictable. Random, it is a coin flip, so the predictor is wrong half the time.

```js
// Try it (results vary: the JIT may turn this into branch-free code)
const data = Array.from({ length: 1e7 }, () => Math.floor(Math.random() * 256));
function sumBig(arr) { let s = 0; for (const x of arr) if (x >= 128) s += x; return s; }
console.time("random"); sumBig(data); console.timeEnd("random");
data.sort((a, b) => a - b);
console.time("sorted"); sumBig(data); console.timeEnd("sorted");
```

Speculative execution also caused the **Spectre** and **Meltdown** security bugs (2018): speculative work that was "thrown away" still left traces in the cache that an attacker could measure.

## Why more cores instead of faster clocks?

From the 1970s to about 2005, clock speeds rose from about 1 MHz to about 3–4 GHz. Then they stopped. Power use grows steeply with clock speed (faster switching needs higher voltage), and chips were hitting about 100 W of heat in a fingernail-sized area. The free speed-up ended, an event often described as the end of **Dennard scaling**.

Transistors kept getting smaller (**Moore's law**: transistor counts doubling roughly every two years), so chip makers spent them on **more cores**: several complete CPUs on one chip. A laptop has 8–16 cores; a server chip has 64–192.

The catch: a single-threaded program only uses **one** core. To benefit from 64 cores you need parallelism: multiple processes or threads (Day 06), and correct coordination between them (Day 07). Node.js runs your JavaScript on one thread, which is why you scale Node with multiple processes (the `cluster` module, or many containers).

## The math

**Pipeline speed-up.** 5 stages, 1 ns each, 1,000 instructions:

```text
no pipeline:   1,000 × 5 ns          = 5,000 ns
pipelined:     5 ns + 999 × 1 ns     = 1,004 ns   ≈ 5× faster
```

**Cost of mispredictions.** A core has a base CPI of 0.5 (2 instructions per cycle). 20% of instructions are branches, 5% of those are mispredicted, penalty 20 cycles:

```text
extra CPI = 0.20 × 0.05 × 20 = 0.2
new CPI   = 0.5 + 0.2        = 0.7   → 40% slower than perfect prediction
at 50% mispredicted:  0.20 × 0.5 × 20 = 2.0 extra → CPI 2.5, 5× slower
```

**How long does a loop take?** A loop of 1 billion simple iterations, about 4 instructions each, at 3 GHz and IPC 2:

```text
4 × 10^9 instructions / (2 × 3 × 10^9 per second) ≈ 0.67 s
```

Rule of thumb for estimates: **a core does on the order of 10^9 simple operations per second.**

## In an interview

CPU internals rarely get asked directly in system design, but the ideas are everywhere:

- "Is this service **CPU-bound** or **I/O-bound**?" CPU-bound (image resizing, encryption, JSON parsing at scale) means more cores or more machines help. I/O-bound (waiting on DBs and networks) means more concurrency helps.
- "Why does Node need clustering?" One JS thread uses one core.
- "Can one server do 1 million simple operations per second?" Yes — a core does about 10^9 simple ops/s; the real limits are usually I/O and memory.
- In coding interviews: why a branch-free or cache-friendly version can beat an equivalent "same Big-O" version.

A good short answer to "what happens when the CPU runs your code": *"The program is machine code in memory. The CPU repeatedly fetches the instruction at the program counter, decodes it, executes it using registers and the ALU, and advances the PC; jumps change the PC to make loops and ifs. Real cores pipeline and overlap many instructions, predict branches to avoid stalls, and run several cores in parallel."*

## Common mistakes

- **"Higher GHz always means faster."** IPC, caches, and core count matter as much or more. A 3.5 GHz modern core beats a 3.8 GHz one from 2008 by a wide margin.
- **"More cores make my program faster."** Only if the work is split across threads or processes.
- **"Assembly and machine code are different things."** Assembly is just readable text for machine code, one-to-one.
- **"Pipelining makes each instruction faster."** It improves throughput, not the latency of a single instruction.

## Before moving on

- [ ] I can describe fetch–decode–execute and the role of the program counter
- [ ] I can explain registers vs RAM using the countertop/pantry picture
- [ ] I can explain pipelining with the laundry analogy and why branches hurt it
- [ ] I can say why chips went multi-core around 2005
- [ ] I know the rule of thumb "about 10^9 simple operations per second per core"

## Go deeper (optional)

- [Instruction cycle — Wikipedia](https://en.wikipedia.org/wiki/Instruction_cycle)
- [Instruction pipelining — Wikipedia](https://en.wikipedia.org/wiki/Instruction_pipelining)
- [Branch predictor — Wikipedia](https://en.wikipedia.org/wiki/Branch_predictor)
- *Computer Organization and Design* by Patterson and Hennessy
- *Code: The Hidden Language of Computer Hardware and Software* by Charles Petzold
