# A closure parameter named like a local borrow keeps the borrow live

**Severity:** S2 — a valid program is rejected with a false E0911: a later closure whose parameter has the same name as an earlier local borrow keeps that borrow live, so a read of the borrowed place between the two is refused.

**Status:** open again — its fix (#1476) was REVERTED from develop for
v0.2.66: the scope-aware live-range scan's arrow-literal skip also hid the
uses of a borrow BORN at that arm's pattern, so the statement-level range
fell back to the whole binding statement and `yo check ./src` failed on 16
files of the compiler's own tree (release-blocking;
`issues/2026-10-19-borrow-liveness-rejects-the-match-switch-group-lowering.md`).
Re-land in v0.2.67 with the scan refined: a binding at the tracked borrow's
own declaration position is its BIRTH site (its arm's body uses count), not
a shadow — and the cursor-walk interaction (a re-point whose token precedes
the binding's last read inside one statement) needs the evaluation-order
rule settled first.

**Status (first finding):** open. Found 2026-10-18 while re-gating #1421 (decision 46 Generation B) on develop `00eddd3e4`. That branch rewrites #1419's `result.* = …` test writes as `result.with_mut(cur => { cur = … })`. In one test the closure parameter `cur` has the same name as an earlier `cur := &mut o`, and the batch failed to compile. It reproduces with the develop-built `yo-d47loc-3d1afa693` (src and std match `00eddd3e4`), so it is not caused by #1421. Renaming the closure parameter makes the program compile.

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
