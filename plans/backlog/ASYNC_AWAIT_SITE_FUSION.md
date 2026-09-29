# Await-site fusion: an immediately awaited single-await wrapper runs in its caller's frame

**Status:** BACKLOG. Written 2026-09-29; not started. It is the detailed
design for one option in `plans/ASYNC_STATE_MACHINE_GENERATION.md` phase 7
("embedding an immediately awaited child's machine in the parent's slot"),
and it is built on that plan's phase 4 IR and phase 5 single-pass emitter.
It does not start before phase 5 lands: implementing it on today's
segment/continuation emitter would be thrown away.

**Owner:** the macOS async-runtime session implements it, by the user's
decision of 2026-09-29, starting when phase 5 (#1002) merges.

**Goal.** Make a std I/O call cost what the raw runtime operation under it
costs. `TcpStream.read`, `File.write`, `Child.write_stdin` and the rest are
`io.async` wrappers around one raw future plus an error check. Each call
allocates, starts, completes and frees a state machine of its own, and a
parked call takes an extra scheduler hop. That is the whole difference
between std's rows and the raw rows in the libuv comparison
(`plans/reference/MACOS_ASYNC_IO_PERFORMANCE.md`, which lands with #988).

**Non-goal.** Closing the gap between the raw runtime and libuv. That gap
is in the backend and the kernel entry points, and it is recorded, with the
reasons it stays, in the macOS reference doc.

---

## 1. Measurements

macOS 26.6, Apple M4, 2026-09-29. The compiler is a seed-built stage 1 of
#999 (on #988 + #996, so #991's await rewrite is in). All numbers are
measured.

### 1.1 What the wrapper costs

An 8-connection TCP ping-pong (16 tasks, 320,000 round trips a run), written
twice: once awaiting `IO_tcp.recv`/`IO_tcp.send` inside `io.async` (what
std's wrappers do internally), once with `TcpStream.read`/`write`. The libuv
program is `scripts/bench/async-vs-libuv/bench_uv.c multi`, the same shape.
Seven interleaved runs, medians:

| | ns / round trip | vs libuv |
| --- | ---: | ---: |
| libuv | 3,180 | 1.00 |
| Yo, raw ops | 3,421 | 0.93 |
| Yo, std `TcpStream` | 3,604 | 0.88 |

`getrusage` over a run: raw 0.14 s user / 0.93 s system, std 0.18 s user /
0.96 s system, libuv 0.11 s user / 0.91 s system. So the wrapper costs
**~180 ns a round trip**, of which ~0.12 µs is user CPU. A round trip is 2
reads (they park) and 2 writes (they complete at once).

The synchronous path alone: 100,000 one-byte `send`s to a socket whose peer
does not read, so every call completes inline with exactly one `sendto`.
Raw ~344 ns an op, std `TcpStream.write` ~376 ns: **~30 ns an op**. The
parked path is therefore ~60 ns an op (180 = 2 × 30 + 2 × 60).

#991's await rewrite (cold state machine 83 → 28 ns) and `--allocator
mimalloc` did not move the std rows. The cost is not the cold start alone.

### 1.2 Where it goes (read from the emitted C)

Awaiting `s.write(buf, n, e.io)` inside the caller's `io.async` body:

1. **Construct:** `__yo_new_<wrapper>` does `__yo_rc_alloc` + `memset`
   (header, `cancel_pending_fn`, `__yo_resume_fn`, `__yo_set_effect_fn`,
   capture copy).
2. **Cold start at the await:** `__yo_incr_rc` (the running-task
   reference), a copy of the caller's effect bundle, then an indirect
   `__yo_set_effect_fn(fut, "__bundle", &bundle)`, a string-keyed setter, and
   `__yo_resume_fn(fut)`.
3. **The wrapper's resume:** start the raw op, store it in its own
   `await_future_0`, check it, `goto state_1`. Then the abort check, the
   result extraction, `__yo_decr_rc(raw)`, the error check with its
   `__yo_effect_escaped` test, the result store, `state = -1`,
   `__yo_future_wake_waiters`, and `__yo_decr_rc(self)`.
4. **The caller:** re-check the state, `goto state_1`, extract, and
   `__yo_decr_rc(wrapper)`, which frees it.
5. **Parked:** the wrapper registers as the raw future's waiter. The raw
   completion enqueues the wrapper; the wrapper's completion wakes the
   caller (the same-step handoff since #991). That is one more resume and one
   more wake per parked op than awaiting the raw future directly.

### 1.3 How much of std has the shape

A textual census of `std/`: 71 of 147 `io.async` blocks are one top-level
await with no loop. They are in `fs/file` (11), `net/tcp` (9), `fs/dir` (8),
`net/udp` (6), `net/unix` (6), `process/command` (5), `http/client` (4),
`crypto/tls` (3), `async/waker` (3), `io/stdio` (3), and seven others. The
census is a pre-filter (grep and indentation), not the fusability rule
below; F1 prints the real count.

## 2. The idea

At an await site `await(f(args))` where `f`'s result is such a wrapper and
the future is awaited immediately (never bound, stored, spawned or passed),
emit the wrapper's body **into the caller**: its prologue at the call, its
one inner await as an await of the caller, and its tail after the caller's
extraction. The wrapper's state machine is never built. This is Rust's
state-machine inlining, applied to exactly the case where the child's
lifetime is the await.

```rust
// std (unchanged)
read : (fn(self : Self, buf : *u8, size : usize, io : Io) -> Impl(Future(usize, IoExn)))({
  fd := self._fd;
  io.async(e => {
    r := e.io.await(IO_tcp.recv(fd, buf, size, i32(0)), e.io);
    usize(NetError.check(r, e.exn))
  })
}),

// caller
n := e.io.await(s.read(buf, usize(64), e.io), e);
```

The caller's IR (`ASYNC_STATE_MACHINE_GENERATION.md` §4) after fusion:

```
Bind(fd', s._fd)                               // wrapper prologue, hygienic names
Await(slot_k, IO_tcp.recv(fd', buf, 64, 0), r')
Bind(n, usize(NetError.check(r', e.exn)))      // tail; `e` is the await's bundle
```

The caller awaits the raw future in its own slot. Nothing is allocated for
the wrapper, there is no `set_effect`, and a parked read wakes the caller
directly.

## 3. Design

### 3.1 When a wrapper is fusable

Decided per monomorphized instance, on the macro-expanded tree, during
phase 4's IR build. A function `f` is fusable when:

1. **Static callee.** The call resolves to one function definition: not a
   `Dyn` method, a closure value, or a function pointer.
2. **Result is one `io.async` block.** The body is
   `prologue; io.async(e => BLOCK)`, where the prologue is straight-line
   code that does not await.
3. **One await, at the block's top level.** `BLOCK` normalizes (phase 4) to
   `pre; t := Await(INNER); tail`: no loop, no second await, and the await
   is not under a branch. `pre` and `tail` are straight-line (branches that
   do not await are fine).
4. **Effects only through the bundle.** The block names its effect bundle
   only as `e.io` / `e.exn` (or the bundle as a whole in a call). It does not
   store the bundle, capture it into a closure, or spawn with it.
5. **No self-reference.** The block does not mention its own future (no
   `io.state(self)`-style introspection), and `f` is not recursive through
   the fused path.
6. **No escaping `return`.** A `return(v)` inside the block becomes a jump
   to the fused site's end with `v` as the value. It is allowed, and the IR
   gives it an exit label.

The call site is fusable when the future is the direct operand of an await
(`await(f(args), bundle)`) and nothing else holds it. A future bound to a
local (`fut := s.read(...)`), spawned, stored, returned or passed keeps
today's path. So does a call with `YO_ASYNC_FUSION=0` (§5).

Nested fusion: `INNER` may itself be a fusable call (`TlsStream.read` over
`TcpStream.read`). Fuse recursively up to a fixed depth (4), counting through
the call chain so the recursion check in rule 5 terminates.

### 3.2 Semantics that must not change

- **Evaluation order.** Today the prologue runs when `f(args)` is called
  and the block runs at its cold start, which is the await. With the future
  awaited immediately those are the same point, so emitting the prologue
  then the block in place keeps the order. Arguments are evaluated once, in
  the caller, before the prologue, exactly as today.
- **The effect bundle.** Inside the block `e` is the bundle the caller's
  await injects (today via `set_effect`). Fused, `e` is bound to that
  bundle expression, evaluated once at the await site.
- **Throw and unwind from the tail.** Today a throw whose handler unwinds
  escapes the wrapper (state -2). The caller's await sees -2 and takes the
  unwind (`__yo_task_abort_take_unwind`), and the frame that installed the
  handler catches it, keyed by the handler's identity (#991). Fused, the
  handler runs in the caller's resume function, and the unwind is caught by
  the same frame by identity. Tests pin both a handler installed in the
  caller and one installed further up.
- **Abort and cancellation.** Aborting the caller while it waits at a fused
  await finds the RAW future in the await slot and cancels it directly.
  Today it cancels the wrapper, which cancels the raw future (#991's
  structured cancellation). The observable result is the same: the op is
  cancelled and the caller is -2.
- **Ownership.** The wrapper's captures become caller locals: C locals, or
  slots when live across the await (phase 6 liveness). Their drops are the
  caller's scope drops at the fused site's end. The raw future's reference
  is the caller's `await_future` slot, released on extraction, as for any
  await.
- **Result type.** The fused site's value is the tail's value, the same
  type the wrapper's future resolved to.

### 3.3 Hygiene

The block's locals and the prologue's bindings get fresh names per fused
site (the phase 4 hoisting temps already need this). A fused site inside a
loop in the caller is emitted once in the body, like any statement, and
re-runs each iteration.

### 3.4 Observability

- `YO_DEBUG_FUSION=1` prints each fused site (`file:line: fused
  TcpStream.read`) and each rejected candidate with the rule it failed.
- `YO_ASYNC_FUSION=0` disables fusion. This is the A/B switch for the
  benchmarks and the differential tests (§5), in the same form as phase 5's
  `YO_ASYNC_LOWERING`. It is a developer knob, not a user option, and goes
  when the fused path is the only path.

## 4. Phases

Each phase is one PR stacked on the ASMG phase 5 emitter. Local gates as in
`ASYNC_STATE_MACHINE_GENERATION.md` §5, plus the §5 differential run below.

### F0: the benchmark in the tree

Add the raw-vs-std 8-connection ping-pong and the synchronous-write
microbenchmark (§1.1) to `scripts/bench/async-vs-libuv/`. Add a `raw/std`
column to `scripts/bench-vs-libuv.sh`. Record the before numbers here.

### F1: the fusability analysis (no emission change)

Implement §3.1 over the phase 4 IR and `YO_DEBUG_FUSION`. Exit: the list
of fused sites in `std/` and in the compiler, with every rejected
candidate's reason, recorded in this doc. The census predicts ~70 std
definitions.

### F2: the lowering

Fuse at the IR level (§2) and let phase 5's emitter emit the result, with
no emitter special case. Exit:

- the §5 correctness corpus passes with fusion on and off;
- the §1.1 benchmark: std within 2% of raw on the 8-connection row, and the
  synchronous-write row within 5 ns an op;
- `yo.c` size and the compiler's own `check ./src` time recorded, since fusion
  duplicates tails per site. Both must not grow by more than 2%.

### F3: nested fusion

Rule 3.1's depth-4 recursion (`TlsStream` over `TcpStream`, `BufReader`
over a stream). Exit: an HTTPS GET makes no wrapper allocation per read,
counted by a `__yo_rc_alloc` counter in the emitted C.

## 5. Tests

**Differential.** Every async test file (`tests/async*`, `tests/net`,
`tests/fs`, `tests/process`, `tests/http`, and std's own) runs twice, with
`YO_ASYNC_FUSION=0` and `=1`, and must give identical results. This is the
main safety net: fusion changes no observable behavior, so the whole suite
is its oracle.

**New cases** (`tests/async/fusion.test.yo`), each checked in both modes:

- a throw in a fused tail, caught by the caller's handler and by one
  installed two frames up, with the handler both returning and unwinding;
- `JoinHandle.abort` of a task suspended at a fused await: the raw op is
  cancelled and no reference leaks (an `rc()` probe on a payload);
- a fused await in every control-flow placement of the phase 5 shape
  corpus (in a `cond` arm, a `match` arm, a `while` body, a loop condition);
- a side-effecting prologue and arguments, with the observable order
  pinned;
- a wrapper with a `return(v)` in its block;
- nested fusion (depth 2 and 4) and a recursive wrapper, which must NOT fuse;
- non-fusable sites keep today's path: a bound future, a spawned one, one
  passed to `race`.

**Performance gate.** The F0 benchmark in CI's bench job as a floor on the
`std/raw` ratio (≥ 0.98 on the 8-connection row), in the style of
`scripts/bench/io-floors.env`.

## 6. Risks

- **Code size.** Every fused site carries the tail inline. The std tails
  are one check call, so this should be small; F2 measures `yo.c`.
- **Stack traces and debugging.** A fused wrapper has no frame of its own,
  as with inlining. Line directives (`plans/backlog/LINE_DIRECTIVES.md`),
  when they land, should map the tail's C lines to the wrapper's source.
- **Handler identity.** The unwind catch rule keys on the handler literal's
  id. Fusion moves where the throw executes but not which handler it
  reaches. The tests in §5 are what make that a checked fact.
- **Interaction with phase 6 layout.** The raw future takes the caller's
  single unioned await slot. The wrapper's live captures add slots to the
  caller, which is correct but grows the caller. Measure the `sizeof` of
  the callers in `std/net`.

## 7. Alternatives considered

- **A per-type free list of state machines** (phase 7's first option). It
  saves the allocator calls, but not the cold start, `set_effect`, the
  second resume or the extra wake. Allocation is a fraction of the ~30 ns
  synchronous cost: #991 already made the cold start 28 ns and mimalloc did
  not help. Still worth measuring in F0 as a baseline.
- **A "mapped" raw future** (store a completion map function in the raw
  future, apply it at extraction). It avoids the wrapper allocation but
  needs a second future kind in the runtime protocol and only covers tails
  that are pure functions of the result. The effect throw in `NetError.check`
  is not.
- **Changing std's API** so callers await raw futures. It pushes the error
  mapping into every caller. Rejected.
- **`write` instead of `send` for std streams**, the other half of the
  std-vs-libuv gap. Rejected in the macOS reference doc: it relies on
  runtime-tracked per-socket state (`SO_NOSIGPIPE`, non-blocking mode) that a
  raw `close`/`fcntl` through FFI silently invalidates.
