# A closure parameter named like a local borrow keeps the borrow live

**Severity:** S2 — a valid program is rejected with a false E0911: a later closure whose parameter has the same name as an earlier local borrow keeps that borrow live, so a read of the borrowed place between the two is refused.

**Status:** fixed (re-landed for v0.2.67). The first fix (#1476) was
reverted from develop for v0.2.66 (#1481) because `yo check ./src` failed on
16 files of the compiler's own tree
(`issues/fixed/2026-10-19-borrow-liveness-rejects-the-match-switch-group-lowering.md`).
That failure was not in the shadowing rule: `_lb_region_end` walked a `cond`'s
arms without the cond-arm flag the other helpers pass, so it read an
`if(b == t, { … })` arm as a closure and skipped its condition. The re-land
restores #1476 and fixes that, and the evaluation-order rule below is now
written down. No declaration-position special case was needed.

**Found** on 2026-10-18 while re-gating #1421 (decision 46 Generation B) on develop `00eddd3e4`. That branch rewrites #1419's `result.* = …` test writes as `result.with_mut(cur => { cur = … })`. In one test the closure parameter `cur` has the same name as an earlier `cur := &mut o`, and the batch failed to compile. It reproduces with the develop-built `yo-d47loc-3d1afa693` (src and std match `00eddd3e4`), so it is not caused by #1421. Renaming the closure parameter makes the program compile.

## Symptom

```text
error[E0911]: Cannot read `o` here: `cur` borrows `o` with `&mut` and is still live, and a `&mut` borrow is exclusive: while it is live, `o`, the places inside it and the places containing it are reached only through `cur`.
```

## Reproducer

```yo
{ RefCell } :: import("std/sync/refcell");
main :: (fn() -> unit)({
  result := rc(RefCell(i32).new(0));
  (mut(o) : Option(i32)) = .Some(i32(2));
  cur := &mut o;
  match(
    cur,
    .Some(v) => {
      v = (v * i32(3));
    },
    .None => ()
  );
  r := match(o, .Some(v) => v, .None => i32(0));
  result.with_mut(cur => {
    cur = r;
  });
});
export(main);
```

`yo compile repro.yo --skip-c-compiler` reports the E0911 above at the read of `o`. With the closure's parameter renamed (`slot => { slot = r; }`), the program compiles.

## Rule

The live-range scan (`_lb_mentions`, `_lb_last_mention`, `_lb_region_end`,
`_lb_has_repoint` in `src/evaluator/utils.yo`) reads a statement in the order
the evaluator evaluates it. All four helpers apply the same rule, so they agree
on which tokens are uses of the borrow named `name`.

1. **Order inside one statement is left to right by token, with these
   constructs fixed:**
   - a `cond` arm `c => body`: the condition `c` is evaluated before `body`,
     and `c` is always a USE (a condition binds nothing);
   - a `match`: the scrutinee first, then for each arm its pattern (a
     BINDER), its guard (`(p && (g))`: `g` is a use, evaluated in the scope
     the pattern opened), then its body;
   - an arrow literal used as a closure (`x => …`, `(a, b) => …`,
     `(x : T) => …`, `mut(x) => …`) or a named `fn` / `ctl` / `Fn` literal:
     the parameter list BINDS for the body; the body runs later, at a call,
     so a closure is live to its end (rule 4);
   - an assignment `lhs = rhs` (a write or a re-point `cur = &p`): `rhs` is
     evaluated BEFORE the store into `lhs`, whatever their token order.
2. **Shadowing.** When an arrow literal's left side binds `name` (a closure
   parameter or a `match` pattern), the mentions of `name` under it are of the
   new binding, not uses of the borrow: the whole arrow literal answers "no
   use". When its left side does not bind `name`, the whole arrow literal is
   scanned — left side included, so a guard that reads the borrow is a use.
   A `cond` arm is never a shadowing site: its left side is a condition. A
   `:=` / typed-`=` rebinding of the name is a redefinition error, so only an
   arrow literal can shadow.
3. **A pattern binding born in a `match` arm** (`.Variant(_, fidx, …) =>
   body`, registered by `local_borrow_register_match_place` /
   `local_borrow_note_match_place` with the arm BODY) is live from its binder
   token to its last mention in `body`. Its END is the last token of the
   smallest construct that holds that last mention, found by descending
   through blocks and branch arms: inside a `cond` arm whose only mention is
   the condition (an `if(fidx == t, { … })` desugars to one), the range ends
   at the condition, so the arm body may write the scrutinee's other fields.
4. **Anything else that holds the last mention** — a loop, a call, an
   assignment, a closure — keeps the borrow live to that construct's end.
5. **A re-point inside the statement that uses the old target.** In
   `cur = &mut n.next` (`n` bound by `match(cur, .Some(n) => …)`) the read of
   `n.next` is evaluated before the re-point stores into `cur` (rule 1), so
   the borrow `n` derived from `cur`'s old target ends at that read, which is
   BEFORE the re-point even though the `cur` token precedes it. A check that
   compares the re-point's `cur` token with `n`'s last-use token would read
   the order backwards; the re-point's event point is the end of the
   assignment. This is why the arm binding is recorded as a match PLACE over
   `cur` (`local_borrow_note_match_place`, no entry in `g_local_borrows`)
   rather than as a derived borrow `local_borrow_require_no_live_derived`
   would test at the `cur` token. The re-point does not shorten `cur`'s own
   range: the range belongs to the binding, and the re-point re-targets it
   (`has_repoint` only decides whether a step-pin local exists).

## Root cause

`local_borrow_range_of` (`src/evaluator/utils.yo`) finds a local borrow's last use by scanning the statements after its binding for the last one that mentions its name (`_lb_mentions`, then `_lb_last_mention` and `_lb_region_end`). `_lb_mentions` only compared names. It did not know about scopes, so a closure parameter, or any inner binding, that shadows the borrow's name counted as a use of the borrow. The borrow then stayed live until that closure, and every access to the borrowed place before it was checked against an exclusive borrow that had already ended.

## Fix

All four helpers (`_lb_mentions`, `_lb_last_mention`, `_lb_region_end`, `_lb_has_repoint`) apply the Rule above through one predicate, `_lb_arrow_shadows`:

- An arrow literal whose left side binds the name (a closure parameter list or a `match` arm pattern) is no use of the borrow. A named `fn` / `ctl` / `Fn` literal whose parameter list binds the name is no use either.
- An arrow literal that does not bind the name is scanned whole, left side included. #1476 scanned only the body, so a `match` guard `(p && (g))` that read the borrow was missed and the borrow looked dead while in use (the unsafe direction). The re-land fixes this.
- A `cond` arm is never a shadowing site. `_lb_region_end` now passes the same cond-arm flag as `_lb_mentions`' own walk of a `cond`. This is the #1481 regression.

Tests, all in `tests/local_borrows.test.yo`:

- the reproducer above;
- a `match` arm pattern that binds the name;
- a capturing closure that still extends the borrow;
- a `cond` condition that still uses the borrow;
- a `match` guard that still uses the borrow (new; accepted by #1476);
- the compiler's switch-group shape: a `match(&obj.field, .V(b) => if(b == t, { obj.other = … }))` binding whose last use is the `if` condition (new; rejected by #1476).

Measured 2026-10-20 on darwin arm64, with tree-built binaries:

- On bare #1476 re-applied to develop `6ccddf25d` (`a9c57cd7b`), both new tests fail. The guard's `comptime_expect_error` raises nothing. The switch-group test is E0911 "Cannot write `fa.classic`". `check src/evaluator/exprs/match.yo` reports the E0911 at line 1827.
- With the fix, everything passes:
  - `check ./src` 278/278 and `check ./std`;
  - `tests/local_borrows.test.yo` 19/19 and `tests/match_async_arms.test.yo`;
  - 18 more borrow and E0911 language test files;
  - the 20 borrow and E0911 cli-cases with no golden diff;
  - `tests/internal/binding.test.yo` and `tests/internal/evaluator_utils_is_valid_variable_name.test.yo`.
