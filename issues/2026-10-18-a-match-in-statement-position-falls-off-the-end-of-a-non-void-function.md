# A match in statement position falls off the end of a non-void function (the v0.2.65 seed cannot build the tree)

**Severity:** S1 — bootstrap/self-compile breakage: `yo build` under the published v0.2.65 seed fails at the C step on any tree that contains the shape — develop itself included — so no self-hosted binary can be produced, the next develop battery on a code PR goes red at its Build job, and the next release cannot cut bundles until this is fixed.

**Status:** open. Found 2026-10-18 while re-gating #1434 on develop `5eed91253` (`~/Workspace/Yo-wt/vbd-logs/rg1434-v66/build.log`): `yo build --std-path ./std` with the v0.2.65 seed failed at the C step inside `std/path.yo`'s `extension` and `src/evaluator/exprs/cond.yo`'s `evaluate_cond`. A clean checkout of `5eed91253` fails identically (`devprobe-build.log` in the same directory), and the 16-line reproducer below fails under the installed seed alone, so the failure is independent of #1434's diff.

## Symptom

Verbatim, from the branch build at `532392920`:

```text
yo-out/x86_64-unknown-linux-gnu/bin/yo.c: In function 'yo_id_1501927789693873729000000':
yo-out/x86_64-unknown-linux-gnu/bin/yo.c:128821:1: error: control reaches end of non-void function [-Werror=return-type]
yo-out/x86_64-unknown-linux-gnu/bin/yo.c: In function 'yo_id_13668923131112712927000000':
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
  unit;
});
```

```text
$ yo compile tmp/fixme.yo --emit-c --skip-c-compiler -o tmp/fixme   # exit 0
$ cc -c -o /tmp/fixme.o -Werror=return-type tmp/fixme.c
tmp/fixme.c:2019:1: error: control reaches end of non-void function [-Werror=return-type]
```

`yo compile` without `--skip-c-compiler` fails the same way, so any user
program with the shape is unbuildable, not just the self-build. Standalone
copy: `issues/repros/match-statement-falls-off-end.yo`.

## Root cause

The switch-based enum-match emitter ends every `case` block with `break;`
(the generated C carries a doubled `break; break;`), and for a match in
statement position — where the match's value is `unit` and there is no result
temp — it emits nothing after the closing `switch`. Because every arm body
ends in `return(...)`, the codegen treats the fall-through as unreachable and
the function simply ends; `-Werror=return-type`, which the build passes,
makes that unreachable fall-off a hard error.

The same match in TAIL-expression position does get a trailing statement
after the switch — but it is `return _file_...;` over a temp that no arm ever
wrote, an uninitialized read on a path the exhaustiveness proof claims is
unreachable. Both spellings should end in a trap (`__yo_abort()`), not in a
missing or garbage return.

Trigger conditions, all required: a non-void function; the match in statement
position; an enum subject (switch emitter; the if/goto emitter used for
literal patterns appends the trailing return); every arm ending in a
`return(...)`.

## Where it bites the tree

- `std/path.yo`, `Path.extension` (line 322): the match over `file_name()`'s
  `Option` is the function's only statement and every arm returns
  (`yo_id_1501927789693873729000000` in the emitted C).
- `src/evaluator/exprs/cond.yo`, `evaluate_cond` (line 98): the match that
  lowers cond arms (`yo_id_13668923131112712927000000`; its broken C is full
  of #1438's `__yo_effect_escaped` re-raise blocks).

## Why CI did not catch it

The v0.2.64 seed built develop green (battery `39099399553` on `e34b6b0f3`,
58/58, which includes the Build jobs). v0.2.65's own bundles were built by the
v0.2.64 seed, so the regression shipped without ever compiling a tree that
contains the shape. After `SEED_VERSION` was bumped to v0.2.65 (`29329cdea`),
every merge to develop was docs/CI-only (#1442, #1443, #1444 — `code=false`,
the fast path compiles nothing), so no battery has built the tree with the
v0.2.65 seed. The regression window is the v0.2.65 PR set that touched match
lowering — #1419 (match place binding across await; field-copy fix), #1438
(unwind re-raise), possibly #1440 — pinnable by emit-diffing `extension`'s C
between the v0.2.64 and v0.2.65 binaries.

## Fix sketch

1. **Codegen:** when a switch-emitted match in statement position cannot fall
   through (every case diverges, or the match is exhaustive), close the
   construct with an unreachable trap instead of nothing; in tail position,
   trap rather than returning the never-written temp.
2. **Bootstrap workaround in the same PR:** the tree is compiled BY the seed,
   so until a fixed seed is released the two tree sites above must avoid the
   shape (an explicit unreachable tail, or turn the statement match into the
   tail expression). Without that, `yo build` keeps failing even with the
   codegen fix in the tree, because the seed still emits the tree's C.
3. **Regression test:** a program with the shape must compile and run. Mind
   the seed pitfall (VBD handover 2026-10-17 §1.1): the CI steps that run
   `yo test` with the SEED fail on it until the next release carries the fix;
   grep `.github/workflows/` for seed-run `yo test` steps and keep the test
   out of them until then.
