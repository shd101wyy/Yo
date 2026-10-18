# A match in statement position falls off the end of a non-void function under gcc (bootstrap breakage on gcc boxes; clang unaffected)

**Severity:** S1 — bootstrap/self-compile breakage: `yo build` under the published v0.2.65 seed fails at the C step on any tree that contains the shape — develop itself included — so no self-hosted binary can be produced with a gcc default `cc`, and `yo test` under the seed+gcc fails whole test files. CI, the release pipeline and every clang-built binary were never affected: the emitted C returns on every valid enum tag, and clang accepts an exhaustive-enum switch as the last statement of a non-void function where gcc fires `-Werror=return-type`. Not a v0.2.65 regression (see archaeology: v0.2.64 emits byte-identical C); it is a latent gcc-incompatibility in the match lowering that the first local gcc build of a tree containing the shape exposed.

**Status:** fixed 2026-10-18. Found while re-gating #1434 on develop `5eed91253` (`~/Workspace/Yo-wt/vbd-logs/rg1434-v66/build.log`): `yo build --std-path ./std` with the v0.2.65 seed failed at the C step inside `std/path.yo`'s `extension` and `src/evaluator/exprs/cond.yo`'s `evaluate_cond`. A clean checkout of `5eed91253` fails identically (`devprobe-build.log` in the same directory), and the 16-line reproducer below fails under the installed seed alone, so the failure is independent of #1434's diff.

## Symptom

Verbatim, from the branch build at `532392920`:

```text
yo-out/x86_64-unknown-linux-gnu/bin/yo.c: In function 'yo_id_16737259531833501081000000':
yo-out/x86_64-unknown-linux-gnu/bin/yo.c:128821:1: error: control reaches end of non-void function [-Werror=return-type]
yo-out/x86_64-unknown-linux-gnu/bin/yo.c: In function 'yo_id_12100985697579679191000000':
yo-out/x86_64-unknown-linux-gnu/bin/yo.c:708594:1: error: control reaches end of non-void function [-Werror=return-type]
cc1: some warnings being treated as errors
yo: error: compile: C compiler failed (exit 1) on yo-out/x86_64-unknown-linux-gnu/bin/yo.c
Compilation error: Compilation failed (exit 1)
```

## Reproducer

Every arm of the match ends in `return(...)`, the match sits in STATEMENT
position (its value is discarded) inside a non-void function, and the subject
is an enum (the switch-based emitter):

```yo
f1 :: (fn(n_opt : Option(usize)) -> Option(usize))({
  match(
    n_opt,
    .Some(k) => {
      return(.Some(k));
    },
    .None => {
      return(.None);
    }
  );
});

export(main);
main :: (fn() -> unit)({
  r1 := f1(Option(usize).Some(usize(9)));
});
```

```text
$ yo compile tmp/fixme.yo --emit-c --skip-c-compiler -o tmp/fixme   # exit 0
$ cc -c -o /tmp/fixme.o -Werror=return-type tmp/fixme.c
tmp/fixme.c:2019:1: error: control reaches end of non-void function [-Werror=return-type]
```

`yo compile` without `--skip-c-compiler` fails the same way, so any user
program with the shape is unbuildable under gcc. Standalone
copy: `issues/repros/match-statement-falls-off-end.yo`.

## Root cause

Two emitters cooperate to drop every statement that could close the C
function, and the switch they leave behind is not provably exhaustive to a C
compiler:

1. The evaluator types an all-arms-diverging match as `never` and stamps the
   node's `control_flow` with the merged flags (`src/evaluator/exprs/match.yo`,
   the "all arms have control flow" branch) — it attaches no result temp.
2. `generate_function_body` (`src/codegen/functions/generation.yo`) treats a
   statement with control flow as making the rest unreachable: the statement
   loop stops at it (`find_return`) and drops the tail, and the tail path
   skips the return outright when the tail expression rendered no code (`if
   (expr_code.len() > 0)` — a never-typed match returns `""`).
3. `_gen_tagged_union_match` (and its siblings) end with the switch's closing
   brace and hand back the temp name — nothing else is emitted.

Net C: the function body ends at the switch's `}`, with each case block
ending `return …; break; break;`. The switch operand is a struct's `tag`
MEMBER (`(x).tag`, where `tag` has an enum type) covering every enumerator —
semantically exhaustive, but gcc does not implement clang's
"exhaustive-enum-switch implies no return" heuristic for `-Wreturn-type`, so
it reports that control can fall off the end of a non-void function, and the
`-Werror` the yo driver passes to cc promotes it to an error. A 6-line C
probe reproduces the compiler split on this box (gcc 15.2 errors, a clang
frontend accepts).

The same match in TAIL-expression position has the identical hole (the tail
return is skipped because the match renders no code); a mid-statement
diverging match before a tail drops the tail (the `evaluate_cond` shape).
Trigger conditions, all required: a non-void function; every arm of the match
diverging; the match the function's last emitted construct; gcc (or any
compiler without the exhaustive-switch heuristic) as the C compiler.

## Where it bit the tree

- `std/path.yo`, `Path.extension` (line 322): the match over `file_name()`'s
  `Option` is the function's only statement and every arm returns
  (`yo_id_1501927789693873729000000` in the emitted C).
- `src/evaluator/exprs/cond.yo`, `evaluate_cond` (line 314): the match over
  `first_true_index` lowers cond arms; every arm returns, so the function's
  tail `expr` is dropped as unreachable and the switch is the last statement
  (`yo_id_13668923131112712927000000`).

`Path.file_stem` has the same source shape but was not in the build's C at
all (nothing in the compiler closure references it), which is why exactly two
sites failed.

## Archaeology

### A. Which change introduced it, and why nothing caught it

**It is not a v0.2.65 regression.** Measured 2026-10-18:
`yo version install 0.2.64`, then emit the reproducer's C with the v0.2.64
binary (`~/.cache/yo/versions/0.2.64/bin/yo compile repro.yo --emit-c
--skip-c-compiler -o repro264`): the function body is BYTE-IDENTICAL to the
v0.2.65 emission (same switch, same `return …; break; break;`, same missing
trailing return; `diff` clean), and gcc rejects it identically
(`repro264.c:2019:1: error: control reaches end of non-void function`). The
match-related PRs in the v0.2.64..v0.2.65 window (#1419's mut-match place
binding, #1440's decision-47 markers) did not touch this lowering — #1419's
match.yo diff only adds the `is_mut_match` guard around subject
materialization. (An earlier field report that "a v0.2.64-seed-built binary
emits the trailing return" was checked against this artifact evidence and
refuted; those green gates ran clang-side compilations.)

What changed is the environment, not the emitter: this box's default `cc`
is gcc 15.2 — the 2026-10 WSL 3 update removed clang from PATH, and the
same-day gates that were green that morning still had clang (the
`fix/trial-specialization-drops-store` re-gate at 10:36 vs the failure
later the same day). Two independent halves kept every clang-side build
green (either can hide the other):

- **The yo driver's optimized arm passes clang-only `-Wno-everything`**
  (`src/main.yo`, the wholesale-silence strategy, load-bearing since #275,
  2026-08-25; `issues/fixed/release-builds-suppress-all-c-warnings.md`).
  clang honors it and silences every warning, `-Werror=return-type`
  included; gcc prints `cc1: note: unrecognized command-line option
  '-Wno-everything'` (visible in the failing build logs) and silently drops
  the unknown `-Wno-*`, keeping every default diagnostic on — so the
  intended silence never happens under gcc. clang additionally does not
  flag `-Wreturn-type` for a switch whose every present case returns.
- CI compiles emitted C with clang and, for the build jobs, `-w` on top:
  - `test.yml`, "Build stage 1 once": `clang -std=c11 -fno-strict-aliasing
    -fwrapv -w -O2 /tmp/stage1.c …` — clang AND all warnings disabled.
  - The suite-candidate and cross-emit jobs: `--c-compiler clang` or
    `--emit-c` + clang lines.
  - The v0.2.65 release run `39106358669` (15/15 green) and the
    v0.2.64-era develop battery `39099399553` (58/58) built their bundles
    through those clang steps, so the shipped emission was never compiled
    by gcc.

Measured matrix (2026-10-18, repro file; cross-checked against this doc's
own v0.2.64/v0.2.65 byte-identity diff): seed v0.2.64, seed v0.2.65 and a
`00eddd3e4`-built tree binary all emit the same fall-off C; gcc rejects it
in both the `-O0` and optimized arms; `zig cc` (a clang frontend) accepts
it in both. A clang-equipped box stays green with `--cc clang`
(`nix develop /home/yiyiwang/Workspace/Yo --command bash -c 'yo build
--std-path ./std --cc clang'`; keep built binaries inside the same nix
develop invocation — nix glibc vs system libs).

`--cc zig` also succeeds (zig cc is a clang frontend) — the escape hatch used
by parallel agents while this fix was in flight. The live experiment agreed:
while this fix was in flight, PR #1434's battery ran develop through CI's
`Build stage 1 once (seed yo build)` and `Build the suite candidate` — both
SUCCESS under clang, on the exact tree that fails `yo build` under local gcc.

### B. The bootstrap catch-22 (why the emitter fix alone cannot unblock the build)

`yo build` compiles the tree WITH THE SEED: stage 1's C is emitted by the
seed binary, so a fix to `src/codegen/**.yo` changes nothing stage 1
compiles. Verified empirically, both directions:

- The broken C in the failing build is seed-emitted: the `extension` body in
  `~/Workspace/Yo-wt/rg1434/yo-out/…/yo.c` (line 128714+) carries the seed's
  emission with the switch as the last statement.
- Seed-side shape probes (installed v0.2.65, gcc): a mixed-arm match (one
  arm returning, one producing the value) emits the result temp and a
  trailing `return <temp>;`, and a diverging-arm match followed by a function
  tail emits the tail's return after the switch — both compile and run clean
  under seed+gcc. So rewriting only the tree sites moves the seed's emission
  into the safe shapes, without any emitter change.

Consequently the fix has two halves in one PR: the two tree rewrites restore
`yo build` under the seed+gcc immediately; the emitter trap fixes every other
program with the shape (and lets the rewrites be reverted once SEED_VERSION
carries the fix).

## Fix

1. **Emitters — three closers, because no single choke point owns the
   function's last line:**
   - `src/codegen/exprs/match.yo`, `generate_match_expression`: after the
     chosen lowering returns, when the match node's `control_flow` says
     every arm diverges (the evaluator stamps it only then), close the
     construct with `__yo_abort();  // unreachable: every arm of this match
     diverges`. One choke point covers all five lowerings (tagged union,
     simple enum, nullable pointer, primitive switch, general if/goto chain
     — the general lowering's `__yo_mN_end: ;` label had the same hole), and
     it is the only closer inside async state-machine resume functions.
   - `src/codegen/functions/generation.yo`, `generate_function_body`: the
     construct-level trap is not enough — the function-body emitter's own
     epilogue can land AFTER it (measured: `std/string/string.yo`'s
     `_split_impl`, whose all-diverging `cond` tail is followed by the
     scope-end `__yo_decr_rc` flush, left gcc a path past a trap it could
     not prove dead). Two closers close the C function after everything
     else: when the tail rendered no code (the drops flush first, then the
     trap), and when `find_return` dropped the tail (a statement before it
     diverged). Both skip unit-result functions.
   - `src/codegen/exprs/return.yo`,
     `generate_implicit_return_statement`: the bare-tail body's
     empty-render arm ("emit nothing: control cannot reach past the
     statement form") gains the same non-void trap.
   `__yo_abort` is `_Noreturn` (verified with a C probe: gcc accepts a
   non-void function whose last statement is a call to it), so both
   compilers treat the fall-through as unreachable; every trap is dead code
   in valid programs.
2. **Tree-site rewrites** (bootstrap workaround until SEED_VERSION carries
   the emitter fix; each keeps the semantics identical and stays in the
   mixed-arm shape the seed lowers safely):
   - `std/path.yo`, `Path.extension`: the outer match's `.None` arm produces
     `.None` as its value instead of returning, and the match is the
     function-body tail — the emitters then close with `return <temp>;`.
   - `src/evaluator/exprs/cond.yo`, `evaluate_cond`: the big match's `.None`
     arm ends with the tail value `expr` instead of `return(expr);`, so the
     match carries no control-flow stamp and the function's own tail `expr`
     return is emitted after the switch.

## Verification

Fails-before (installed v0.2.65 seed, system cc = gcc 15.2):

- `yo build --std-path ./std` on clean develop `5eed91253`:
  `~/Workspace/Yo-wt/vbd-logs/rg1434-v66/devprobe-build.log` — the two
  `control reaches end of non-void function` errors above.
- The 16-line reproducer:
  `issues/repros/match-statement-falls-off-end.yo` —
  `yo compile` fails at the C step (`repro.c:2019:1`).
- Regression test file, `yo test tests/match_nested.test.yo --parallel 1`:
  the batch C fails at exactly the three new test functions
  (`tests/.yo_selftest_batch_…_1_0.bin.c:8428`, `:8522`, `:8556` —
  `control reaches end of non-void function [-Werror=return-type]`), 0 of 28
  tests run.
- Blast radius beyond builds: develop's `tests/async_await.test.yo` under
  seed+gcc fails its whole batch the same way
  (`~/Workspace/Yo-wt/vbd-logs/rg1414-v66/async-await-develop-seed.log`;
  reproduced locally: 181 passed / 100 failed).

Passes-after: `yo build --std-path ./std` green under the seed+gcc (the two
rewrites; two full build rounds, the second carrying all three closers), and
under the tree binary (`yo-out/x86_64-unknown-linux-gnu/bin/yo`):
`tests/match_nested.test.yo` 28/28 (the three new shapes: "an
all-arms-return statement match over an Option ends a non-void function",
"…over a payload enum ends a non-void function", "…before a tail leaves the
tail emitted"), `tests/path.test.yo` 89/89, `tests/async_await.test.yo`
281/281 (the round-1 tree binary — construct trap only — still failed
`_split_impl` in the path and async_await batches; that failure is what
found the function-body epilogue ordering), every `tests/match_*.test.yo`,
`tests/closure_capture_cond_arm.test.yo`,
`tests/cond_return_in_string_literal.test.yo`,
`tests/async_while_in_match_arm.test.yo`, and
`tests/internal/match_binding_shadow.test.yo` (the one internal file
importing `codegen/exprs/match`) all green, one file per invocation
(`~/Workspace/Yo-wt/vbd-logs/matchfall/`).

Seed-run CI steps are clang (`--c-compiler clang`) and were never affected;
the new tests parse and evaluate identically under the seed, so no workflow
needed changes.

## Seed-version note

The two tree-site rewrites are load-bearing until `SEED_VERSION` carries the
emitter fix (the seed still emits the bare switch for the all-arms-return
shape). Reverting them before that re-breaks `yo build` on gcc boxes — the
comments at both sites say so.
