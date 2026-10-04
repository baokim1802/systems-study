# Processes, Threads and the OS

> Your server program never touches the hardware directly; the operating system hands it a slice of CPU time, a private view of memory, and a way to ask for files and network sockets. Understanding that deal explains "too many open files", why threads are cheaper than processes, and what an out-of-memory kill is.

## The big idea

Think of a big apartment building.

- The **building manager** owns the master keys, the boiler, the wiring and the front door. Tenants are not allowed to touch those directly.
- Each **apartment** is private: its own rooms, its own stuff, its own lock. One messy tenant cannot wreck the neighbor's place.
- Inside an apartment, several **roommates** share the kitchen and living room, but each has their own to-do list.
- When a tenant needs something from the building (hot water, a parcel from the front desk) they **fill in a request form** and the manager handles it.

Map it to the computer:

| Building | Computer |
|---|---|
| Building manager | the **kernel** (core of the operating system) |
| Apartment | a **process** (a running program with its own memory) |
| Roommates | **threads** inside a process (share memory, separate to-do lists) |
| Request form | a **system call** (syscall) |
| Floor plan each tenant sees | **virtual memory** |

## Kernel space and user space

The CPU itself enforces the split. It has (at least) two **privilege modes**:

- **Kernel mode** (ring 0 on x86): can run any instruction, touch any memory, talk to devices.
- **User mode** (ring 3): your programs. Forbidden instructions or memory accesses trigger a fault that the kernel handles (often by killing the program: "segmentation fault").

The memory the kernel uses is **kernel space**; everything your program uses is **user space**. This is what stops a buggy browser tab from overwriting your disk driver.

## System calls: asking the kernel for help

A program in user mode cannot read a file or send a packet itself. It makes a **system call**: a special instruction (`syscall` on x86-64) that switches the CPU into kernel mode at a fixed, trusted entry point, does the work, and switches back.

Common Linux syscalls:

| Syscall | What it does |
|---|---|
| `open`, `read`, `write`, `close` | files, but also sockets and pipes |
| `socket`, `connect`, `accept` | networking |
| `fork`, `execve`, `exit`, `wait` | create, replace, end processes |
| `mmap` | map memory or a file into the address space |
| `epoll_wait` | wait for many sockets at once (the heart of Node, Day 09) |

When your Node code runs `fs.readFileSync("a.txt")`, under the hood it becomes roughly `open` → `fstat` → `read` → `close`. On Linux you can watch it with `strace -f node app.js`.

Syscalls are cheap but not free: on the order of 100 ns to 1 µs each, compared with about 1 ns for a function call. That is why buffered I/O exists: write 1 MB with **one** `write`, not a million 1-byte `write`s.

### File descriptors

When you open a file or socket, the kernel gives back a small integer, a **file descriptor** (fd), that names it in later calls. Every process starts with three: `0` stdin, `1` stdout, `2` stderr. In Unix "everything is a file": files, sockets, pipes and terminals are all fds.

Each process has a limit on open fds, often **1024** by default (`ulimit -n`). A server holding 5,000 open client connections needs 5,000 fds, so it crashes with `EMFILE: too many open files` until you raise the limit. A real production gotcha.

## Processes

A **process** is a running instance of a program. The kernel tracks, for each one:

- a **PID** (process ID),
- its own **virtual address space** (code, heap, stacks),
- its open file descriptors,
- one or more threads,
- its user and permissions, current directory, environment variables.

On Unix, new processes are made with **`fork`** (clone the current process) followed by **`exec`** (replace the clone's program with a new one). Your shell runs `ls` exactly this way.

```js
// Node: start another process and talk to it over stdout
const { execFile } = require("child_process");
execFile("ls", ["-l"], (err, stdout) => console.log(stdout));
console.log("my pid is", process.pid);
```

Processes are **isolated**: one crashing does not crash another, and they cannot read each other's memory. To cooperate they use **IPC** (inter-process communication): pipes, sockets, shared files, or shared memory set up on purpose.

### Signals and shutting down nicely

The kernel can deliver **signals** to a process. `SIGTERM` means "please shut down" (the process can catch it, finish in-flight requests and exit). `SIGKILL` (`kill -9`) cannot be caught: the process just dies. Docker and Kubernetes send `SIGTERM`, wait a grace period (30 s by default in Kubernetes), then `SIGKILL`.

```js
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));   // stop accepting, finish current requests
});
```

## Threads

A **thread** is one sequence of execution inside a process: its own program counter, registers and **stack** (Day 10), but sharing the process's heap, code and file descriptors with its sibling threads.

```text
            Process A (PID 4120)                    Process B (PID 4121)
  ┌────────────────────────────────────┐   ┌──────────────────────────┐
  │ code │ heap (shared by threads)    │   │ code │ heap              │
  │ open files / sockets (shared)      │   │ open files               │
  │ ┌────────┐ ┌────────┐ ┌────────┐   │   │ ┌────────┐               │
  │ │thread 1│ │thread 2│ │thread 3│   │   │ │thread 1│               │
  │ │ stack  │ │ stack  │ │ stack  │   │   │ │ stack  │               │
  │ │ PC,regs│ │ PC,regs│ │ PC,regs│   │   │ │ PC,regs│               │
  │ └────────┘ └────────┘ └────────┘   │   │ └────────┘               │
  └────────────────────────────────────┘   └──────────────────────────┘
       can't see each other's memory ↔ (need IPC)
```

| | Process | Thread |
|---|---|---|
| Memory | private address space | shared with other threads in the process |
| Creation cost | higher (new address space) | lower |
| Communication | IPC (pipes, sockets) | just read/write shared variables |
| Crash impact | only itself | can take down the whole process |
| Danger | — | races on shared data (Day 07) |

Because threads share memory, communication is fast and easy, and also dangerous. That is the whole story of Day 07.

## Scheduling and context switches

A machine may have 8 cores and 800 threads that want to run. The kernel's **scheduler** decides who runs where and for how long.

- Each runnable thread gets a **time slice** (on the order of milliseconds).
- The scheduler is **preemptive**: a timer interrupt fires and the kernel can pause a thread mid-instruction-stream, even if it never volunteers.
- Threads that are waiting (on disk, network, a lock, `sleep`) are **blocked** and don't use CPU at all. Most server threads spend most of their life blocked.

```text
states:   ready ──(scheduled)──> running ──(time slice over)──> ready
                                    │
                         (waits on I/O or lock)
                                    v
                                 blocked ──(I/O done)──> ready
```

Switching a core from one thread to another is a **context switch**: save the registers and PC of the old thread, load the new one's, and (if it is a different process) switch the memory mapping. The direct cost is a few microseconds; the hidden cost is that the new thread finds the CPU caches full of someone else's data (Day 05).

## Virtual memory

Every process believes it has a huge, private, contiguous memory starting near address 0. That is an illusion called **virtual memory**.

- Memory is split into **pages**, usually **4 KB**.
- Each process has a **page table** mapping its virtual pages to physical pages in RAM.
- A hardware unit, the **MMU** (memory management unit), translates every address on the fly. A small cache of recent translations, the **TLB**, keeps that fast.

```text
Process A virtual page 7  ─┐
                           ├─> physical RAM frame 1200
Process B virtual page 7  ─┼─> physical RAM frame 88      (same virtual address,
                           │                               different real memory)
Process A virtual page 9  ─┴─> not in RAM: on disk / not yet allocated
```

What this buys you:

- **Isolation**: A's address 7 and B's address 7 are different RAM. A cannot even name B's memory.
- **Lazy allocation**: pages get real RAM only when first touched. Touching an unmapped page causes a **page fault**; the kernel finds a frame and resumes.
- **Swap**: rarely used pages can be pushed to disk. When a system swaps heavily, everything slows to disk speed ("thrashing").
- **Sharing**: read-only code (like a shared library) can map to the same physical pages in many processes.

When RAM truly runs out, Linux's **OOM killer** picks a process (usually the biggest) and kills it. In containers you see this as "OOMKilled" when a process exceeds its memory limit.

## The math

**Address space.** x86-64 uses 48-bit virtual addresses today:

```text
2^48 bytes = 256 TB of virtual address space per process
with 4 KB (2^12) pages: 2^48 / 2^12 = 2^36 ≈ 69 billion possible pages
```

That is why page tables are multi-level trees: most of that space is empty and needs no entries.

**Thread memory.** Linux reserves an 8 MB stack per thread by default (virtual; RAM is used only as touched):

```text
10,000 threads × 8 MB = 80 GB of reserved virtual space
if each actually touches 64 KB: 10,000 × 64 KB ≈ 640 MB of real RAM
```

**Context switch overhead.** 50,000 switches per second at about 5 µs each (including cache effects):

```text
50,000 × 5 µs = 250,000 µs = 0.25 s of CPU per second → 25% of a core wasted
```

This is why "one thread per connection" struggles at tens of thousands of connections (the **C10K problem**), and why event loops (Node, nginx) handle many connections on few threads (Day 09).

## In an interview

- "Process vs thread?" Isolation vs shared memory; cost; failure blast radius.
- "How would you use all 32 cores with Node?" Multiple processes (cluster / containers), worker threads for CPU work.
- "The service dies under load with `too many open files`." Raise the fd limit, check for leaked connections, use connection pooling.
- "Pods keep getting OOMKilled." Memory limit vs actual usage, leaks (Day 10), heap size flags.

A strong answer to "process vs thread": *"A process is a running program with its own virtual address space, file descriptors and at least one thread; processes are isolated and communicate via IPC. Threads live inside a process, each with its own stack and registers but sharing the heap, so they're cheaper to create and communicate faster, but a bug in one can corrupt or crash the others and shared data needs synchronization."*

## Common mistakes

- **"Threads run at the same time, always."** Only if there are free cores; otherwise they take turns.
- **"A blocked thread uses CPU."** It doesn't; it just costs memory (its stack) and scheduler bookkeeping.
- **"Virtual memory means swap."** Virtual memory is the address translation; swap is one optional thing it enables.
- **"`kill` always kills."** Plain `kill` sends `SIGTERM`, which a program can catch. `kill -9` is `SIGKILL`.

## Before moving on

- [ ] I can explain kernel vs user mode and what a syscall is
- [ ] I can compare processes and threads in a table from memory
- [ ] I can describe what happens in a context switch and why it costs more than it seems
- [ ] I can explain virtual memory, pages, and page faults
- [ ] I know what file descriptors are and why the limit matters for servers

## Go deeper (optional)

- [Process (computing) — Wikipedia](https://en.wikipedia.org/wiki/Process_(computing))
- [Virtual memory — Wikipedia](https://en.wikipedia.org/wiki/Virtual_memory)
- [Node.js child_process documentation](https://nodejs.org/api/child_process.html)
- *Operating Systems: Three Easy Pieces* by Remzi and Andrea Arpaci-Dusseau (free online)
