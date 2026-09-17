---
description: "Use when debugging the Yo evaluator, C codegen output, or runtime issues. Covers gdb, debug print functions, and strategies for diagnosing compiler bugs."
---

# Debugging the Yo Compiler

## Evaluator debugging

Use these functions to print debug information:

- `type_to_string` (`src/types/string.yo`) — print types
- `ast_expr_to_string` (`src/expr.yo`) — print expressions
- `value_to_string` (`src/value.yo`) — print values
- `are_types_compatible` (`src/types/compatibility.yo`) — check type compatibility

Key facts:

- An expr-info whose value is `.None` means the value is a **runtime value**, not an `UnknownVal`.
- `EvalValue.UnknownVal(ty, is_runtime_only)` is a compile-time value where we only know its type but not the real value.

## A plausible mechanism is roughly a coin flip — probe before you fix

Measured over 2026-09-16/17: **five** mechanisms that convincingly explained a
symptom on this tree were refuted by a gated print, each after the reasoning
behind it looked sound enough to start writing a fix.

| defect | mechanism that "obviously" explained it | verdict |
| --- | --- | --- |
| prelude +2 lines breaks `check ./std` | TypeValue interning wrong-merge | refuted — identical with interning disabled |
| same | a trait-id collision (two traits DO share an id) | refuted — breaking the collision changed nothing |
| inherent assoc const not resolving as an `Array` length | lazy binding, fix with `force_in_flight_field` | refuted — that forcer returns false unless an impl is IN FLIGHT |
| `Array.fill` rejects `T.default()` | the comptime-value specialization mint | refuted — traces byte-identical across failing and working cases |
| evaluator diagnostics never reach the typed stash | the pending-definition path | refuted — every message on that path carries a note this error lacks |

Each fix would have been written, reviewed and merged looking correct, and
changed nothing. **A gated print costs one build. A wrong fix costs a review
cycle and survives it.**

Two rules follow, and the second is the one that actually gets missed:

1. **Probe before you fix.** Add a print at the predicate you believe is
   deciding, run it on BOTH a failing and a WORKING case, and compare. A trace
   with no control is not evidence — three of the five above showed the
   suspicious value in the working case too.
2. **When a probe comes back ambiguous, WIDEN THE PROBE — do not resume
   reading.** The expensive failure is not skipping the print, it is bisecting
   by inference between prints. Eliminating candidate sites by reading can be
   individually sound and still cost several builds without finding the site;
   instrumenting every candidate at once costs one.

Corollaries worth keeping:

- **Do not count one signal twice.** "Unreachable by message" and "absent from
  the agent list" are the same messaging layer observed twice, not two
  independent confirmations — that pair nearly produced a wrong conclusion
  about a peer session being dead.
- **A successful send proves the transport, not agreement**, and a green exit
  code can mean "nothing ran" rather than "nothing is wrong" — `yo compile`
  exits 0 on an FTT stub that aborts at runtime, and `yo check` never
  evaluates bodies at all.

## Swallowed definition-time errors (`YO_DEBUG_SWALLOW=1`)

The evaluator evaluates function and closure bodies at DEFINITION time behind a
"def-eval wall": a failing body is swallowed so a yo-self porting gap cannot
reject valid code. The cost is that a body which fails to evaluate produces NO
diagnostic — codegen simply has no `ExprInfo`s for it and emits
`// Failed to transpile` markers (rewritten to `abort()` since PR #275). That is
the single most common cause of a hollow function, and `YO_DEBUG_SWALLOW=1` is
the fastest way to see which body failed and why:

| line | emitted by | covers |
| --- | --- | --- |
| `[trial] <pos>` / `[swallow] <err>` | `evaluator/calls/function_type.yo` | named `fn`/`ctl` bodies |
| `[anon-trial] <pos>` / `[anon-swallow] <err>` | `evaluator/values/anonymous_function.yo` | closure (`=>`) and `->` bodies, including every `io.async` closure |
| `[mat-default-swallow] <err>` | `evaluator/values/impl.yo` | the per-impl materialization of a trait `?=` default |

`YO_DEBUG_LAZY=1` is the companion for out-of-order evaluation: `[force] <def>`
(`evaluator/context.yo`) for every `::` definition or `impl` forced by a lookup
miss, and `[force-field] <type>.<member>` / `[force-field] phase-A …`
(`evaluator/values/impl.yo`) for a sibling method forced from inside its own
impl block (`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`).

A `[…swallow]` line belongs to the most recent `[…trial]` line above it (the
swallow handlers are capture-free `->` effect handlers, so they cannot print the
owner themselves). Output is large — redirect stderr and grep:

```bash
YO_DEBUG_SWALLOW=1 yo compile tmp/fixme.yo --emit-c --skip-c-compiler --optimize 2 2>swallow.txt
grep -n 'swallow' swallow.txt | tail
```

Sibling channels, same shape: `YO_DEBUG_CTFE` / `YO_DEBUG_CTFE2` (CTFE call
failures), `YO_DEBUG_DISPATCH` (method dispatch), `YO_DEBUG_BIND=<name>`
(type-variable binding), `YO_DEBUG_RRE` (return-type re-evaluation),
`YO_DEBUG_FRESHEN` (per-call freshening of a generic callee's forall binders —
prints the callee type plus its binder ids `before-ids=` / `after-ids=`).

`YO_DEBUG_FRESHEN` exists because of a specific failure mode worth knowing:
a freshening can FIRE at every call and change nothing, because `substitute`
matches a `SomeT` on **(name, frame_level)** and the declaration's
`forall_types` entry carries a different level from the occurrence that
matters. Identical `before-ids` and `after-ids` is that bug; identical emitted
C is the same bug seen later and more expensively.

## GDB for generated C code

- Run `gdb` on `./a.out` to debug generated C code.
- Stick with C11 standard — no GNU extensions.

## Output debugging

- Always use `| head` or `| tail` to limit command output.
- If a command produces no output for a long time, redirect: `yo compile tmp/fixme.yo --optimize 2 &> compile_output.txt`

## Evaluator-only checking

When you only need to surface evaluator/type errors (no codegen, no C compile), use `yo check <path>`. It runs the evaluator on a single file or every `.yo` file in a directory and prints any errors. Much faster than `compile` for "does this still type-check?" loops, and it's the right tool for bulk sanity passes (`yo check ./src` or `yo check std/` after touching a swathe of files).

## Memory-leak debugging (macOS has no LeakSanitizer)

LeakSanitizer works on Linux but **not on macOS arm64** — an RC leak that fails
CI's ubuntu job with `Direct leak of N byte(s)` is invisible in a local macOS
ASan run. Reproduce locally with the macOS `leaks` tool instead:

```bash
yo compile repro.yo --optimize 2 -o repro_bin
leaks --atExit -- ./repro_bin   # "0 leaks for 0 total leaked bytes" = clean
```

For RC-dispose bugs specifically, also read the emitted C: `__yo_decr_rc` only
frees fields when `header->type_id != 0` (or `dispose_fn` under cycle GC), so
check that the type's constructor stamps a dispose id and that
`__yo_dispose_dispatch` has a case that drops the fields
(see `issues/fixed/ref-enum-missing-dispose-leak.md` for a worked example).

## Design docs for context

- Compile-time RC ownership: `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`
- Async/await concurrency: `ASYNC_AWAIT.md`
- Parallelism: `PARALLELISM.md`
- Low-level sys module: `STD_SYS_MODULE.md`
- Algebraic Effects: `ALGEBRAIC_EFFECTS.md`
- Thread-local cycle collector: `CYCLE_COLLECTION.md`

## VS Code extension

- Ignore editor errors for `.yo` files — the extension may not use updated grammar/evaluator code.
- To rebuild: `cd vscode-extension && npm run package` (the extension is the one npm-based tree in the repo — everything else is built with `yo build`)

## Debugging regressions with git bisect

When a test fails after a series of commits:

1. First confirm the test passes on `origin/develop`: `git stash && git checkout origin/develop && yo test <file> --bail`
2. Use `git bisect` or manually check individual commits to find the first failing commit
3. Read the diff of that commit to understand what changed
4. Embed debug info in **error messages** (not `println`) — each test binary runs as a separate process and its stdout is captured by the runner

## Environment frame debugging

The evaluator uses frame-based environments. Key debugging facts:

- `variable.frame_level` = the frame index where the variable was defined
- `env.frames.len()` = total number of frames in the environment
- a function type's captured env is the env at the function's **definition site** (minus parameters frame)
- an impl's definition env is captured AFTER the generic frame is popped
- The check in `src/evaluator/exprs/assignment.yo` (~line 1075) compares `updated_variable.frame_level < eval_env.frames.len()` to detect "variable defined outside the function body"
- Frame count mismatches between the function type's captured env and the actual evaluation env cause false positives in this check

## Test file conventions

Each `.test.yo` file has its own import set. Check whether a test file imports `std/fmt` before using `println`:

- Files that import `println` from `std/fmt` have it available
- Files without it → use `assert` only, or add the import
- Match the existing style of the test file when adding new tests

## `YO_DEBUG_CAPTURE=1` — the closure-capture pipeline channels

Added 2026-08-26 while fixing the generic-fn async-closure capture loss
(issues/fixed/async-loop-awaiting-buffer-taking-method-state-machine-corruption.md).
All are stderr prints, active only with `YO_DEBUG_CAPTURE` set:

- `[cap-fb]` (exprs/identifer_and_operator.yo) — every FunctionBody-arm
  capture classification: name, the frame the lookup found it at, the ctx
  snapshot's frame count, the stamped frame level, the inner verdict, plus
  the eval_env/current-env top-frame ids (generation mismatches show here).
- `[cap-track]` (context.yo) — track_variable_usage's gate decisions:
  re-found frame, own-param top-frame exclusion, compile-time-only flag.
- `[cap-enr]` (utils/closure.yo) — enrichment input per name: recorded
  level, env frame count, how many same-named bindings were found and how
  many are comptime.
- `[cap-reg]` / `[fid-src]` (function_value.yo) — every capture-struct
  registration (fid, source key, field list) and every fid→source-key mint.
- `[fbctx-closure-call]` / `[fbctx-fnty-rp]` / `[fbctx-fnty-flow]`
  (calls/closure_type.yo, calls/function_type.yo) — which site created a
  FunctionBody evaluation context.

Read them together: a name that is `inner=false` in `[cap-fb]`, survives
`[cap-track]`, appears in `[cap-enr]`, and still misses the `[cap-reg]`
field list pins the drop to capture-struct creation; a name missing from
`[cap-track]` was never tracked (classifier); `cto=true` in `[cap-track]`
against a runtime binding was the UnknownVal-argument mis-port this channel
was built to catch.
