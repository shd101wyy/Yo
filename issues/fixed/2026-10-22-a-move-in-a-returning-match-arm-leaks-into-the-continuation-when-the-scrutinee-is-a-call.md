# A move in a returning `match` arm leaks into the continuation when the scrutinee is a call

**Severity:** S2 — a valid program is rejected with E0901. A `match` arm that
moves a value and then `return`s never reaches the code after the `match`, yet
when the scrutinee is a call result, the move is merged into the continuation
and a later use of the value is reported as a use after move.

**Status:** fixed 2026-10-23 on `fix/b8bug-returning-arm` (see Fix). **Found:** 2026-10-22 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`). Once `TomlValue` holds
value lists, `std/encoding/toml.yo`'s `_classify_number` hits it: at line
1272, `digits := match(_clean_radix(...), .Some(s) => s, .None => { return(bad); })`
is followed by `.None => bad` at line 1279. The v0.2.68 seed and develop
`e30c0d8ed` behave the same; the bug needs no flipped type.

## Reproducer

`issues/repros/2026-10-22-a-move-in-a-returning-match-arm-leaks-into-the-continuation-when-the-scrutinee-is-a-call.yo`:

```yo
{ println } :: import("std/fmt");
B :: struct(n : i32);
impl(B, Drop(drop : (fn(self : &mut Self) -> unit)(())));
id :: (fn(o : Option(i32)) -> Option(i32))(o);
f :: (fn(o : Option(i32)) -> B)({
  bad := B(n : i32(-1));
  v := match(
    id(o),
    .Some(x) => x,
    .None => {
      return(bad);
    }
  );
  cond((v > i32(0)) => B(n : v), true => bad)
});
main :: (fn() -> unit)({
  println(&f(.Some(i32(3))).n);
});
export(main);
```

```text
error[E0901]: use of moved value: `bad`
  --> ...:17:42      (the final `cond`'s `true => bad`)
note: value moved here
  --> ...:14:14      (`return(bad);` in the `.None` arm)
```

With the scrutinee written as the named parameter `o` instead of `id(o)`, the
program compiles and prints `3` under both binaries. A `return(cond(...))`
tail and a bare `cond` tail behave the same, and so do an `Option(String)`
payload moved out by `.Some(s) => s` and an `Option(i32)` one.

## Root cause

The hypothesis filed with the bug (the call temporary's scope or the owned-
temporary binding rule) was wrong. The cause is in the join at the end of
`evaluate_match` (`src/evaluator/exprs/match.yo`), which picks one of four
cases by the scrutinee's value:

- Case 1: a compile-time-known scrutinee with a selected arm.
- Case 2: a compile-time-known scrutinee with one arm that reaches the join.
- Case 3: a scrutinee whose value is `UnknownVal` (a call result) with one arm
  that reaches the join.
- Case 4: everything else, including a named runtime local (no value at all).

Cases 1–3 only `env_adopt` the picked arm's recorded env. But move state does
not live in the env's frame list. It lives on the shared `Variable` objects,
and those are left as the arm evaluated LAST put them:
`reset_sibling_flow_state` undoes the earlier arms' moves before each arm, and
`keep_last_arm_moves` records the last arm's move for codegen without undoing
it. So when the last arm moves `bad` and returns, `bad` stays consumed after
the `match`. Case 4's `merge_and_check_envs` instead rebuilds every touched
variable from the flow log (the pre-branch state plus the last record in each
arm that reaches the join), and so a named scrutinee passed.

Variants run on develop `5136a2b9d` (base binary) confirmed it:

| Scrutinee | Returning arm | Join case | Before |
| --- | --- | --- | --- |
| `id(o)` | last | 3 | E0901 |
| `id(o)` | first | 3 | ok |
| `o` (named) | last | 4 | ok |
| `id(o)`, statement `match` | last | 3 | E0901 |
| `Option(i32).Some(3)`, `_ =>` returning arm last | last | 1 | E0901 |
| `i32(4)`, `_ =>` returning arm last | last | 1 | E0901 |

Cases 1 and 2 leak the same way. A compile-time-known enum does not evaluate
arms of a variant it does not carry, but a `_` arm and every arm of a
primitive match are evaluated.

## Fix

Cases 1–3 keep their `env_adopt`, and also record the one arm they picked when
it reaches the join (a Case 1 arm that diverges itself is not recorded). After
the case selection, that arm alone goes through `merge_and_check_envs`, the
same join Case 4 runs over the arms that reach it. Every variable touched since
the branch began is restored to the picked arm's end state, and the join
records its `Join` flow event for an enclosing arm or loop. The returning arm's
move survives for codegen as the `UndoneMove` `keep_last_arm_moves` recorded,
so the return path still drops nothing twice. The change is in `match.yo`
only. `cond` already joins through `merge_and_check_envs` on every path.

Regression test: "move-only: a move in a returning match arm does not reach
the code after the match" in `tests/move_only.test.yo`. It covers a call
scrutinee with the returning arm last and first, the statement form, an
`Option(String)` payload, and a compile-time-known enum and integer scrutinee.
It counts `Drop` runs on every path and runs under ASan (no leak, no double
drop). Before the fix the test's batch failed to compile with E0901.
