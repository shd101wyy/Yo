# A value-position `cond` with an awaiting arm, inside a `while` inside `io.async`, yields the ZERO value for EVERY arm

**Severity:** S1 — value-position cond with an awaiting arm silently yields the zero value for every arm

**Status: FIXED (2026-09-29).** Found 2026-09-05 fixing `read_dir`'s `DT_UNKNOWN` fallback
(`std/fs/dir.yo`, issues/fixed/fs-metadata-restats-by-path-and-walker-drops-dt-unknown.md).
Silent wrong values — `yo check` is green, clang is clean, the binary runs and
returns `0`/`.<first variant>` for every branch.

## Symptom

```rust
_late :: (fn(v : i32, io : Io) -> Impl(Future(i32, Io)))(io.async(io => (v + i32(100))));

_classify :: (fn(io : Io) -> Impl(Future(ArrayList(i32), IoExn)))(
  io.async(e => {
    tags := ArrayList(u8).new();
    tags.push(u8(8));
    tags.push(u8(4));
    tags.push(u8(0));
    tags.push(u8(12));
    out := ArrayList(i32).new();
    (i : usize) = usize(0);
    while(runtime(i < tags.len()), {
      t := tags(i);
      v := cond(
        (t == u8(8)) => i32(1),
        (t == u8(4)) => i32(2),
        (t == u8(0)) => e.io.await(_late(i32(3), e.io), e.io),
        true => i32(9)
      );
      out.push(v);
      i = (i + usize(1));
    });
    out
  })
);
```

Observed (`yo compile tmp/fixme.yo --optimize 2`, rc=0, no diagnostics):

```
got(0) = 0
got(1) = 0
got(2) = 0
got(3) = 0
expected: 1, 2, 103, 9
```

Every arm — including the three that contain no await at all — produces the
zero value. The binding is never written.

## The trigger is precisely "value position + await arm + while"

Four variants of the same code, one binary, `--optimize 2`:

| variant | shape | result |
| --- | --- | --- |
| A | the same `cond`, **no `while`** around it | **correct** (`1, 2, 103, 9`) |
| B | `v := cond(...)` with an awaiting arm, **inside a `while`** | **WRONG** — `0` for every arm, even with the awaiting arm FIRST and only two arms |
| C | `v := e.io.await(...)` (unconditional await) inside a `while` | **correct** |
| D | statement-form `cond` whose arm ASSIGNS an outer `(v : i32) = …` | **correct** |

So it is not "await inside a while" (C is fine) and not "cond with an
awaiting arm" (A is fine) — it is a `cond` used as a VALUE whose arm awaits,
with a `while` around it.

## Impact

`std/fs/dir.yo`'s `read_dir` wanted exactly shape B for the `DT_UNKNOWN`
fallback (`ft := cond(dt == DT_REG => …, dt == DT_UNKNOWN => await stat, …)`)
and got `.File` — enum tag 0 — for every entry, including directories. It
ships as shape D instead, with a comment pointing here.

This is the same family as C36 (`issues/fixed/async-cond-dispatch-skips-chained-sibling-arm.md`)
and C38 (`issues/fixed/while-await-inside-match-arm-missing-loop-field.md`) —
differently-shaped cond arms under an async state machine — but neither covers
it: C36 was two awaits in sibling arms, C38 emitted a clang error. Here there
is one await, no diagnostic, and the failure is a silently zeroed result.

## Where to look

`src/codegen/exprs/async.yo` / `src/codegen/async/` — `generate_cond_branch_with_await`
and the dispatch-mode branch emitters. The `while` around the cond turns the
cond's continuation into a loop-resume state; the value-binding path
(`extract_target_variable_id`) appears not to be carried into that state, so
no arm ever stores into the binding's `sm->` slot and the C local keeps its
zero-initialised value.

## Reproducer

`tmp/fixme.yo` contents are in "Symptom" above; the A/B/C/D matrix was run as
four functions in one program.

## Re-verified 2026-09-28 (async state-machine audit)

Tree build of develop `af62bdb28`, and the v0.2.45 seed unless noted. See `plans/ASYNC_STATE_MACHINE_GENERATION.md` §3.3.

**STILL REPRODUCES** (seed and tree build): `got(0..3) = 0`, expected `1, 2, 103, 9`. Repro: `issues/repros/async-cond-value-with-await-arm-inside-while-yields-zero.yo`. Root cause, visible in the emitted C: the whole `v := cond(...)` statement is dropped. Only `t := tags(i)` is emitted before `while_loop_0_end:`, and `await_future_0` is never created. The `:=`/`=` arm of `generate_while_body_with_await` (`src/codegen/async/state_code_gen.yo`) only handles a DIRECT `io.await` right-hand side. A `cond`/`match` right-hand side is never routed to the cond/match-with-await emitter, and the fall-through path discards the statement without a `codegen_fatal`.

**Match variant (shape sweep, 2026-09-28).** `v := match(…)` with an awaiting
arm inside a `while` yields 0 for every arm the same way (expected `0,1,321`,
got `0,0,0`; `issues/repros/async-shape-b9-match-value-await-arm-in-while-zero.yo`). Same site: the
while-body binding arm only handled a direct `io.await` right-hand side.

## Fix (2026-09-29)

The binding arm of `generate_while_body_with_await` (`src/codegen/async/state_code_gen.yo`) now routes a `cond`/`match`/`if` right-hand side to its emitter with the binding as the target (`:=` by variable id, `=` by target code). Any other right-hand side holding an await is a coded user error instead of a dropped statement. Regression: `tests/async/sm_ownership.test.yo`, "a value-position cond or match with an awaiting arm inside a while" (both the `cond` and the `match` variant).
