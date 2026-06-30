# yo-self: returning match-arm leaks its pattern binding (block-RHS) — FIXED

## Symptom

The self-compiled binary failed to compile any program that assigned a
`try(...)` macro call to a variable inside a multi-statement body:

```rust
chain :: (fn(ok : bool) -> Result(i32, i32))({
  v := try(parse(ok));        // <- "Failed to transpile v := try(parse(ok));"
  Result(i32, i32).Ok(v + 1)
});
```

The emitted C contained `// Failed to transpile v := try(parse(ok));` for the
whole function body. TS compiled and ran it correctly (`ok 8 / err`).

## Root cause (NOT the `try` macro — a match-arm env leak)

`try(x)` expands to a begin-block whose tail is a `match` with a RETURNING arm:

```rust
{ tmp := x; match(tmp, .Ok(value) => value, .Err(error) => { return(.Err(error)); }) }
```

Assigning that block to `v` (`v := { ...; match(...) }`) is the trigger. The bug
reproduces WITHOUT the macro (see `tests/codegen-bootstrap/match_return_arm_block_rhs.yo`).

During definition-time body evaluation the variant-match arm loop
(`evaluator/exprs/match.yo`, the with-fields "wf" path) did:

1. `env.push_frame(false)` — push the arm frame, add the pattern binding
   (`error` for the `.Err` arm).
2. `evaluate_begin_expression(body, env, …)` — evaluate the arm body.
3. `env.pop_frame()` — a SINGLE pop.

For a non-returning body that is balanced. But when the body is a begin-block
whose tail `return`s, `evaluate_begin_expression` leaves `env` **one frame too
deep**: it threads `env.frames = ev_info.env.frames` to the returning
statement's recorded ExprInfo snapshot, which still carries the begin frame. The
single `pop_frame()` then removes the _begin_ frame, **leaking the arm frame**
(with `error`) into the shared `env`.

The surviving `.Ok(value)` arm is correctly filtered out of the returning arms,
so the post-match env merge runs with `non_return_em = [.Ok arm]`. Its base env
(the leaked `env`) now has `error` at the arm-binding frame while the surviving
case env has `value` there → `merge_and_check_envs` throws **"Frame level N has
different variable names for different cases."** The throw is swallowed by the
def-time trial-eval wrapper, so the whole body loses its ExprInfo and codegen
emits "Failed to transpile" for every statement.

Why only under a begin-block RHS: `v := match(...)` directly evaluates the
scrutinee to `Some(unknown)`, so the match's single-non-return-body fast path
(`scrutinee_val = Some(unknown)`, copy that body's env, skip the merge) fires. A
begin-block-wrapped scrutinee (`t := …; match(t, …)`) yields `scrutinee_val =
None`, which skips that fast path and reaches the merge against the leaked base.

## Faithful-port divergence

TS never mutates the shared `env` for a match arm: it pushes the arm frame into
a LOCAL `caseEnv = pushEnvFrame(caseEnv)` copy (`src/evaluator/exprs/match.ts:343,445`)
and never pops — the shared `env` is untouched across arms. yo-self uses the
mutable-env model, so it must restore `env` itself.

## Fix

`yo-self/evaluator/exprs/match.yo` (wf arm path): capture
`base_frame_count_wf := env.frames.len()` before the arm `push_frame`, and after
the body eval restore the shared env to exactly that depth instead of a single
pop:

```rust
while(env.frames.len() > base_frame_count_wf, {
  env.pop_frame_nonmutating();   // nonmutating: don't corrupt recorded body-env snapshots
});
```

This pops both the stray begin frame and the arm frame regardless of how the
(possibly returning) body left the env — mirroring TS's "shared env untouched
across arms" invariant.

The wildcard (`_`) and literal arm paths share the single-pop shape but bind no
pattern variable, so a leaked frame carries no conflicting name — verified clean
(`_ => { return(...) }` in a block-RHS compiles + runs correctly).

## Validation

- `tests/codegen-bootstrap/try_macro_assign.yo`, `match_return_arm_block_rhs.yo`
  added; both differential-match TS.
- corpus 92/93 (the 1 failure, `recursive_enum_nested_match`, is a PRE-EXISTING
  2nd-level recursive-enum self-shell bug — confirmed identical on the pre-fix
  binary, not a regression).
- binary `check ./std` 152/152 (no evaluator regression).
