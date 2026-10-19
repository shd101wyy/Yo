# A closure parameter named like a local borrow keeps the borrow live

**Severity:** S2 — a valid program is rejected with a false E0911: a later closure whose parameter has the same name as an earlier local borrow keeps that borrow live, so a read of the borrowed place between the two is refused.

**Status:** FIXED 2026-10-18. Found 2026-10-18 while re-gating #1421 (decision 46 Generation B) on develop `00eddd3e4`. That branch rewrites #1419's `result.* = …` test writes as `result.with_mut(cur => { cur = … })`. In one test the closure parameter `cur` has the same name as an earlier `cur := &mut o`, and the batch failed to compile. It reproduces with the develop-built `yo-d47loc-3d1afa693` (src and std match `00eddd3e4`), so it is not caused by #1421. Renaming the closure parameter makes the program compile.

## Fix

`local_borrow_range_of`'s scan helpers (`_lb_mentions`, `_lb_last_mention`,
`_lb_region_end`, `_lb_has_repoint`, all `src/evaluator/utils.yo`) are
scope-aware:

- An `=>`/`->`/`=>>` literal whose LEFT side binds the borrow's name (a
  closure parameter declaration or a `match` arm pattern; `_lb_binds_name`)
  is not a use of the borrow: the left side declares the new binding and the
  body's mentions of the name are of it. A closure whose parameters do not
  bind the name still counts — its body may genuinely capture the borrow.
- A `cond` arm's left side is a CONDITION, a use: the arm node is walked
  without the binding rule (`in_cond_arm`), so `cond(cur => …, true => …)`
  still keeps the borrow live.
- A named `fn`/`ctl`/`Fn` literal whose parameter list binds the name
  (`_lb_fn_literal_binds`) is skipped whole: its parameters and body are the
  new binding's scope. (A `:=` or typed-`=` rebinding of the name is a
  REDEFINITION error in Yo — begin blocks and closure bodies do not open
  binding scopes — so only an arrow-literal binding can shadow.)
- Unrecognized binding shapes answer "does not bind", which keeps the range
  LONG (the safe direction: a false E0911, never a missed exclusivity
  violation).

`tests/local_borrows.test.yo` carries the reproducer, a match-arm-pattern
shadowing case, and two controls (a closure that genuinely captures the
borrow, and a `cond` condition using it, both still E0911 under
`comptime_expect_error`).

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

## Root cause

`local_borrow_range_of` (`src/evaluator/utils.yo`) finds a local borrow's last use by scanning the statements after its binding for the last one that mentions its name (`_lb_mentions`, then `_lb_last_mention` and `_lb_region_end`). `_lb_mentions` only compares names. It does not know about scopes, so a closure parameter, or any inner binding, that shadows the borrow's name counts as a use of the borrow. The borrow then stays live until that closure, and every access to the borrowed place before it is checked against an exclusive borrow that has already ended.

## Fix direction

When the scan walks into a closure literal whose parameter list binds `name`, or into a block after a binding that redeclares `name`, it should stop treating later mentions of `name` in that scope as uses of the borrow. All three helpers (`_lb_mentions`, `_lb_last_mention`, `_lb_region_end`) need the same scope rule so that they agree on the borrow's range.
