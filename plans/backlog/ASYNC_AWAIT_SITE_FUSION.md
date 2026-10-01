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

## 2.1 Revision after reading phase 5 (2026-09-29)

Phase 5 (#1002) landed without the §4 IR of the state-machine plan. Its own
refinement says so: "the IR of §4 is needed only for phase 6's liveness".
Each suspension is emitted inline by `emit_inline_await`
(`src/codegen/async/state_machine.yo`) while the body is generated once.
Three facts from its code shape the lowering:

- **Labels are per state, not per node.** A resume label is
  `__yo_resume_<k>` from the lowering's state counter, and there is one
  unioned `__yo_await_slot`. So emitting a wrapper's body at two call sites
  gets distinct labels already. What refuses it is `low.emitted`, keyed by the
  await node's id: fusion keys it by (node id, fused site).
- **Every variable is a slot from the caller's analysis.** A fused wrapper's
  parameters, prologue locals and block locals must join the caller's slot
  list, named per fused site.
- **Fusability is decided in the evaluator**, at the call's evaluation
  (`_evaluate_funcval_runtime_call`, the arm that already sees through an
  `Impl(...)`-returning callee to its body), where the callee's function
  value and body are in hand. It is recorded by the call's expression id as
  plain data: the callee's `func_id`, and the verdict or the rule that
  rejected it. F1 prints that record from codegen, and F2 reads it. §3.1's
  rules are unchanged; only where they run moves.

  Codegen comments (`io_async_await_analysis`, `generate_async_block`) call
  `ExprInfo`'s `Option(EvalValue)` field reads "destructive moves". That was
  **not reproduced** for an `Option(String)` field or an `Option(ref enum)`
  field with a boxed payload, each read twice under the v0.2.45 seed that
  compiles `src/`: both reads saw the value. The evaluator-side record is
  kept anyway, because the value is in hand there and codegen then needs no
  lookup at all.

## 2.2 F2 mechanics, read off phase 5's code (reasoned, not yet measured)

Each point below comes from reading the code. None is checked by a build
yet; F2's first commit checks each one.

- **Slots come from the caller's analysis walk.** `analyze_await_points`
  (`src/evaluator/async/await_analysis.yo`) captures every variable it
  meets by the `Variable` id in the atom's `ExprInfo` env, and the atom
  emitter reads `sm->var_<id>` for any id in `state_machine_variables`. If
  the walk descends, at a fused await, into the wrapper's prologue and
  block, the wrapper's parameters, prologue locals, block locals and the
  inner await become the caller's slots and suspension point with no new
  naming. Two fused sites of one wrapper in one caller share those slots.
  That is sound because the sites run one after the other in one task: each
  completes before the next starts, and rule 5 excludes recursion. To
  check: the block's atoms for a prologue local (`fd`) resolve to the
  prologue's `Variable` id, not a closure-capture copy.
- **The outer await keeps its result field.** The fused site's value is the
  block's tail. It is stored in the outer await's result field (the one
  phase 5 already uses so that `f(await a, await b)` survives the second
  suspension), and the outer await stays in the analysis for that reason.
  Only its suspension is not emitted.
- **Parameters are bound, not called.** At the site, each wrapper parameter
  slot is set to its argument's code (receiver first, as the call's own
  emission orders them), and the block's bundle parameter `e` is set to the
  await's effects argument. Both borrow: the caller still owns the
  arguments, so these slots join the not-disposed set on abort, like
  `state_machine_binding_ids`.
- **Drops.** The wrapper body's and the block's `deferred_drop_expressions`
  are emitted at the site's end, in the order the wrapper's own state
  machine emits them.
- **The block comes from the closure's `FuncVal`, not the literal's AST.**
  The closure literal in the wrapper's source is not the node codegen emits:
  `io_async_await_analysis` (`src/codegen/exprs/async.yo`) reaches the
  closure through the `io.async` call's `runtime_arg_exprs_in_order[0]`
  and that argument's closure function value, whose body is the evaluated
  one carrying the `ExprInfo`. The closure's own await analysis (its one
  await point, result field and block locals) is already registered under
  its `func_id` (`get_closure_await_analysis`). F2 merges that analysis into
  the caller's, instead of re-walking the literal. The closure's captures
  (`fd`, `buf`, `size`: `sm->__capture.x` in its own state machine) become
  caller slots, initialized from the prologue that ran in the caller.
- **`low.emitted` is keyed by (await node id, fused site).** The key stays
  a single node id for unfused awaits.
- **v1 rejects a `return` in the block** (it would complete the caller).
  §3.1 rule 6's exit label is a follow-up once the census shows a wrapper
  that needs it.

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

Implement §3.1 in the evaluator at each `io.await` of a call inside an
`io.async` body. Record the verdict on the await's `ExprInfo` (§2.1), and
print it from codegen under `YO_DEBUG_FUSION`. Exit: the list
of fused sites in `std/` and in the compiler, with every rejected
candidate's reason, recorded in this doc. The census predicts ~70 std
definitions.

**Done (2026-09-30), on #1002's branch.** Code:

- `async_wrapper_fusion_verdict` and its registry in `src/expr_traversal.yo`.
- Recording at both call arms of `src/evaluator/calls/function.yo`: the
  `FuncVal` arm, and the method arm through the method-callee side table.
  The method arm is where `s.read(...)` / `s.write(...)` resolve.
- The report is `_report_await_fusion` in `src/codegen/async/state_machine.yo`.
- `tests/cli-cases/async-await-fusion-verdicts` pins one callee per rule.

Measured census with a compiler built from the branch
(`YO_DEBUG_FUSION=1 yo compile src/main.yo --skip-c-compiler`): 345 awaits
in the compiler plus the std it reaches.

| Verdict | Await sites |
| --- | ---: |
| fusable | 93 |
| rejected: 2 or more awaiting statements in the block | 128 |
| rejected: the await is not a top-level statement | 47 |
| rejected: the block returns or unwinds early | 19 |
| rejected: the block does not await | 4 |
| no `io.async` wrapper callee (a delegation, a raw op, a `Dyn` call) | 54 |

The 93 fusable sites have 29 distinct callees:

- std: `fs/dir` 5, `fs/file` 4, `net/tcp` 3, and one each in `process/command`,
  `io/stdio`, `io/index`, `io/bufio` and `async/index` (`yield`).
- The compiler: 10, in `fetch`, `build_runner`, `version_cache`, `pkg_config`
  and `install_command`.

The most-called is `std/fs/file.yo`'s `_exists` (37 sites). 92 callees are
rejected. `std_vs_raw.yo` has 4 fusable sites: its `TcpStream.read` /
`write` awaits.

Two corrections came out of the census:

- A `cond`/`match` arm's `=>` is not a closure. Before this, the 13 compiler
  sites rejected for "captures its effect bundle in a closure" were all
  arms, such as `remove_dir`'s `(result < 0) => e.exn.throw(...)`.
- A typed bundle parameter `(e : IoExn) =>` must be read for its name. An
  unread name skipped rule 4, and an unknown parameter shape now rejects.

Capturing an `IoExn` bundle in a real closure is already a compile error
(control-bound capture), so rule 4 fires only for plain `Io` bundles.

"Not a top-level statement" is mostly `close`: its await sits in a `cond`
arm (`self._is_closed => (), true => { await }`). That is §3.1 rule 3, and
the natural follow-up for F2 v2.

### F2: the lowering

In `emit_inline_await`, a fused site emits the wrapper's prologue and block in
the caller's resume function. Its locals and parameters are slots of the
caller named per site, `e` is bound to the await's bundle, and the inner await
is emitted by the same function, keyed by (node id, site) (§2.1). Exit:

- the §5 correctness corpus passes with fusion on and off;
- the §1.1 benchmark: std within 2% of raw on the 8-connection row, and the
  synchronous-write row within 5 ns an op;
- `yo.c` size and the compiler's own `check ./src` time recorded, since fusion
  duplicates tails per site. Both must not grow by more than 2%.

**Status (2026-10-01): DONE, on by default; `YO_ASYNC_FUSION=0` turns it
off.** Every exit criterion is measured below: the corpus, the benchmark, the
sizes, and the fixpoint with the lowering on. `emit_fused_await` and its helpers are in
`src/codegen/exprs/async.yo`, reached from `emit_inline_await` through a
registered hook (`src/codegen/async/_fsm.yo`).

How a fused site lowers, as built:

- **Wrapper prologue, in a C block of its own.** The wrapper's parameters are
  declared from the call's arguments (evaluated in the caller) and its
  prologue runs as C locals, with no state-machine map. The capture struct is
  built by the ordinary literal, including its retains, into
  `sm-><prefix>capture`. The wrapper's scope-end drops then go through
  `generate_deferred_drop_expressions`.
- **The block.** The bundle is stored into `<prefix>param_0`. The block runs
  in a second C block with the wrapper block's variable map swapped in:
  - locals keep the naming registry's per-binding names, which are unique in
    the program, so they cannot clash with the caller's;
  - only `__closure_param_0` is aliased;
  - `sm_capture_slot` is the site's capture;
  - `fusion_field_prefix` names its await results;
  - `low.emitted` and `low.moved_reads` are fresh for the site.
- **Per-program sets.** The sets that stop a temp from being declared, or a
  drop from being emitted, twice (`declared_temp_vars`,
  `emitted_deferred_drop_ids`) are fresh while fused nodes are emitted. The
  same nodes are emitted again in the wrapper's own state machine.
- **End of the site.** The tail is stored into the outer await's result
  field. The block's drops follow, then the site's capture is released and
  zeroed. The caller's dispose releases the fields of a site that was live
  when the task died.
- **Scope.** Fields are per wrapper block, shared by that wrapper's sites in
  one caller. Nested fusion is off (F3).

Bugs found and fixed on the way, each with the emitted C that showed it:

- The prologue's empty-but-present map resolved every capture field to the
  `io.async` call's temp.
- A temp was declared once for two emissions (the per-program set).
- The wrapper's future temp drop was left undeclared.
- Temp stores went through `sm_local_field_name` past the alias map. That is
  why locals take registry names.
- An alias on the local `e` shadowed the closure-param preference, and a throw
  from a fused tail read an unset field (SIGSEGV).
- A nested site used fields its caller's struct lacked.
- After rebasing on #1018 (phase 7), an await whose result p7 keeps in a C
  local (`g_local_await_results`: nothing can suspend between the await and
  its use) has no result field, so the fused site stored its tail nowhere and
  the C read `int32_t t = ;`. The site now declares the same
  `__yo_await_value` local outside its block. One helper,
  `inline_await_local_result_type`, makes that decision for both paths.
- The `YO_DEBUG_FUSION` line for a fused site printed the block's C name,
  which is derived from the module path and so differs between checkouts.
  It prints the callee's position, as the `fusable` line does.

Measured so far, with the lowering on:

- `tests/async/fusion.test.yo` 8/8 (off 8/8). It covers the value, a throw to
  the caller and two frames up, effect order, repeated and looped sites, a
  `cond` arm, a bound future, and abort at a fused await.
- Every file under `tests/fs` (99 tests) and `tests/process` (17).
- `tests/net` except one udp test that fails the same way with the lowering
  off on this base (phase 5 without #988), and passes on develop.
- `tests/sys/tcp`.

The std-vs-raw benchmark on the #1002 base, five-run means (the base's
runtime predates #988, so the wrapper share is smaller than §1.1's):

| Row | raw | std, off | std, on |
| --- | ---: | ---: | ---: |
| 8-connection ping-pong (ns per round trip) | 4,314 | 4,368 | 4,294 |
| inline send (ns per op) | 1,378 | 1,419 | 1,391 |

The differential on develop after #1018 (v0.2.47 seed, 2026-10-01), lowering
on unless noted:

| Run | Result |
| --- | --- |
| fusion, fs_convenience, net/tcp, off and on | 8/8, 16/16, 24/24 both ways |
| fast suite (`tests/` minus internal and cli-cases) | 4,876 passed, 0 failed |
| `gates_fast.sh`: corpus, `check ./std`, `check ./src`, init, fmt, embedded Yo | all pass (156, 177, 278 files) |
| `gates_fast.sh`: CLI cases | 323 pass. Diffs: 3 are #1018's rc 139 crash (fixed separately by #1072), and `async-await-fusion-verdicts`, whose golden is the lowering-off output. With the lowering on it prints `fused`, the case `async-await-fusion-lowered` pins. |

On the rebased tree (develop after #1018, v0.2.47 seed, 2026-10-01), the
F2 exit criteria:

- **Fixpoint with the lowering on**, `fixpoint_only.sh`: stage 2 has 0 hollow
  bodies, clang passes, and `FIXPOINT_HOLDS`.
- **`yo.c` size**, the compiler's own self-emit: 131,540,918 bytes off and
  131,938,013 on, +0.30%. `check ./src` is unchanged, since the knob does not
  reach `check` (138 s).
- **The benchmark**, `scripts/bench-std-vs-raw.sh`, 7 rounds, medians, std/raw:

  | Row | raw | std, off | std, on |
  | --- | ---: | ---: | ---: |
  | 8-connection ping-pong (ns per round trip) | 3,396–3,407 | 3,523 (1.03) | 3,415 (1.01) |
  | inline send (ns per op) | 1,364–1,377 | 1,382 (1.01) | 1,374 (1.00) |

  Ping-pong is inside the 2% exit, and inline send is at raw.

The 13 ns inline-send gap measured on the #1002 base had two causes, both
read from the emitted C and both fixed:

- **The bench's raw side passed `send` flags 0** where std passes
  `MSG_NOSIGNAL`, so the two columns did not make the same syscall.
- **A fused site gave every wrapper local a field.** That included the
  await's future temp, which goes straight into the await slot and is never
  written. Each op paid a NULL-checked drop and two `memset`s of that field,
  and the dispose swept it. The site's fields are now the block's
  cross-boundary locals only, by the analysis the wrapper's own state machine
  uses (`_block_cross_boundary`), and the bench's structs carry 0 such fields.

### F3: nested fusion

Rule 3.1's depth-4 recursion (`TlsStream` over `TcpStream`, `BufReader`
over a stream). Exit: an HTTPS GET makes no wrapper allocation per read,
counted by a `__yo_rc_alloc` counter in the emitted C.

**Status (2026-10-01): implemented (#1085), on by default with F2; the
HTTPS exit measurement is still to do.**

- **How it works:** the prefix in force is the chain, one `__fz<id>_` segment
  per enclosing fused block. A fusable await inside a fused block fuses under
  the composed prefix, and `fused_await_sites` recurses into each site's block
  so the caller's struct holds every level's fields.
- **Not lowered:** a wrapper already on the chain (recursion through the fused
  path, rule 5), and anything past depth 4 (`_FUSION_MAX_DEPTH`). A deeper
  wrapper runs as its own task and fuses again from depth 1 inside it.
- **Shared fields:** a wrapper block reached at two depths shares its local
  fields, since their names come from the registry and the sites run one
  after the other. The struct and the dispose emit and release each once.

Measured (v0.2.47 seed):

- **`tests/async/fusion.test.yo`, 12/12 on and off.** It covers depth 2's
  value and a throw unwinding through two fused blocks, a chain of five past
  the limit, and a mutually recursive pair that must not fuse into itself.
- **`async-await-fusion-nested`** pins the verdicts: four levels fused, then
  `nested fusion deeper than 4`; the pair stops at `the wrapper is recursive
  through the fused path`.
- **The fast suite with it on:** 4,880 passed.
- **`gates_fast`:** everything passes except #1018's three rc 139 CLI cases,
  which the tree predated #1072 for.
- **`fixpoint_only.sh`:** `FIXPOINT_HOLDS`.

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
