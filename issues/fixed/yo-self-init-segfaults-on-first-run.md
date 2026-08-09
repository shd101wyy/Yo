# `yo-self init` SIGSEGV'd — `await` under an `if` had no state transition

**Found 2026-08-09**, the first hour of P1, by wiring `init` into the
self-hosted CLI and running the first differential. **Fixed the same day.**

## Symptom

```bash
mkdir /tmp/x && cd /tmp/x
<yo-self-bin> init myproj      # rc=139 (SIGSEGV), NO output
```

It created `myproj/`, `myproj/src/` and `myproj/tests/` — the three
`create_dir_all` calls — then died before writing any file. The reference
compiler wrote all seven and printed its summary.

Not stack exhaustion: `YO_MAIN_STACK_MB=4096` did not change it, and the binary
was `--release` (-O2), so the giant-frame `-O0` failure mode (`AGENTS.md`
"Common Pitfalls") did not apply.

## Why this was invisible

`plans/PRE_P1_HANDOVER.md` §5 recommended starting P1 with `init` because it is
"genuinely ready (239 lines, complete `init_project`)". It type-checks — it is
inside `check ./yo-self`'s 238 files — but **`init_project` was wired to no CLI
subcommand**, so it had never been RUN, not once. `grep '"init"' yo-self/main.yo`
returned nothing before this change.

That is the general shape to watch for in P1: "ported" in this codebase can mean
"type-checks and is unreachable", and `check` cannot tell those apart. This is
now `scripts/bootstrap/gates_fast.sh` **GATE 5**, which runs `init` and asserts
the seven artifacts — deliberately not just `rc=0`, because the original bug
created the directories and _then_ died.

## Root cause — not in init.yo

`init.yo` used `if(e.io.await(exists(p, e.io), e.io), { ... })`. `if` is a
**macro over `cond`**, so its branch structure only exists in
`$.macroExpansion`. The reference compiler's async state-segment generator never
followed it, so for an `await` under an `if` it fell through to:

```ts
// src/codegen/async/state-code-gen.ts, before the fix
emitter.emitLine(`${indent}// ERROR: Unsupported pattern for await expression`);
```

— a C **comment**. It then returned, and its caller emitted the await machinery
anyway:

```c
// ERROR: Unsupported pattern for await expression
sm->state = 1;
int future_state = sm->await_future_0->state;   // never assigned -> NULL
```

`sm->await_future_0` is only ever assigned by the handlers that were skipped, so
this is an unconditional NULL dereference. The `if` body was dropped from the
output entirely. **Compile returned rc=0 and produced a segfaulting binary** —
the hollow class, in the compiler itself.

Reduced to 22 lines, reproducing under both `-O0` and `-O2`:

```rust
do_it :: (fn(io : Io, exn : Exception) -> Impl(Future(unit, IoExn)))(
  io.async((e) => {
    p := Path.new(String.from("/tmp/nonexistent-xyz"));
    if(e.io.await(exists(p, e.io), e.io), {   // <- rc=0 compile, SIGSEGV
      eprintln(String.from("branch taken"));
    });
  })
);
```

Two false leads, both recorded so nobody re-walks them:

- The issue's first draft blamed the `e.io` vs `e` inconsistency in the
  `exists(...)` awaits. **Wrong** — `exists` returns `Future(bool, Io)`, so `e.io`
  is the correct handler there. The inconsistency is correct code.
- The same `io.await(exists(p, io), io)` shape in isolation does _not_ crash. It
  needs to be inside an `io.async` block, because only there does the state
  machine splitter run. Outside one, `io.await` is a synchronous drive loop.

## Fix

- `src/codegen/async/state-code-gen.ts` and
  `src/evaluator/shared/suspension-analysis.ts` now follow `$.macroExpansion`,
  so `if` gets the `cond` handling it always should have had. `await` in an
  `if`/`else` **body** works; it previously emitted C that did not compile.
- `await` in **condition** position (`if(await f, ...)`, `cond(await f => ...)`)
  is rejected with a located diagnostic that names the fix. Splitting there
  needs a state per condition, which the state machine does not model.
- The unsupported-pattern fallthrough is a **hard error**. Emitting a comment
  and continuing cannot produce a correct binary, only a quiet crash.
- `yo-self/init.yo` hoists its `exists` awaits into locals and uses `cond` for
  the bodies — the spelling both compilers support.

**yo-self needed no codegen change: it already handled `if`+await correctly.**
The reference compiler was the broken one. An early attempt also "mirrored" the
fix into `yo-self/evaluator/shared/suspension_analysis.yo`, which _broke_
yo-self's working path (`sm->var_N = ;`) and turned the self-hosted CI arms red.
Reverted. The port discipline is "mirror TS's mechanism", not "apply TS's patch
blind" — check whether the port already handles the case first.

## Regression tests

- `src/tests/async-await-position-gate.test.ts` — the rejected shapes must fail
  at COMPILE time, with the fix named. All 4 verified failing before the change.
- `tests/async_await.test.yo` — 8 cases across `cond` branches and `if`/`else`
  bodies, the hoisted-condition form, and that code _after_ such a branch still
  runs. Verified failing before the change; 124/124 pass under both compilers
  after.
- `gates_fast.sh` GATE 5 — the `init` execution differential.

## Status after the fix

```
yo-self init proj  ->  rc=0, all 7 files
```

The remaining diff against the reference tree is template text, and the
self-hosted templates are the _more current_ ones: `src/init.ts` still emits
pre-call syntax (`test "it works", {`, `import "./deps.yo"`). Tracked separately.

Adjacent gaps found while measuring this, none of them regressions from it:
`issues/await-in-branch-positions-matrix.md`.
