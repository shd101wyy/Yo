# A handler leaves its install frame through a `&mut` reference

**Severity:** S2 — a function may write its local handler into a caller's `&mut Option(Raise)` or a `&mut` struct's field; calling the handler after its frame returned aborts with "unhandled effect unwind escaped to top level". With F1 (`issues/2026-11-28-a-frame-that-installs-a-handler-catches-an-outer-frames-unwind.md`) a frame that installs a handler of another result type catches the dead handler's unwind and reads its value as its own: S1 then.

- Filed: 2026-11-28, finding F6 of VERDICTS-95 (Fable 5.2, §7), with its probes `q04`, `q05` and `q04b`.
- Status: open. Closed by K-3's stopgap (a control-bound value cannot be written through a `&mut`), and structurally by K-7 (a handler carries its installer's origin), of [`plans/backlog/CAPABILITIES_AND_HANDLERS.md`](../plans/backlog/CAPABILITIES_AND_HANDLERS.md).

## Reproducer

`issues/repros/2026-11-28-a-handler-leaves-its-install-frame-through-a-mut-reference.yo`:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
Raise :: (ctl(msg : &String) -> i32);

stash :: (fn(slot : &mut Option(Raise)) -> i32)({
  (h : Raise) = (
    msg -> {
      unwind(i32(5));
    }
  );
  slot.* = .Some(h);
  i32(1)
});
main :: (fn() -> unit)({
  (mut(s) : Option(Raise)) = .None;
  _ := stash(&mut s);
  match(s, .Some(h) => println(`r=${h(`x`)}`), .None => println(`none`));
  println(`after (a handler whose frame is dead was called)`);
});
export(main);
```

`yo check` (v0.2.80, its bundled std, 2026-11-28): `evaluator OK`. Compiled with `--optimize 2 --sanitize address --allocator system`, rc 134:

```text
unhandled effect unwind escaped to top level
```

Two more files, each `evaluator OK` under `yo check`:

- `issues/repros/2026-11-28-a-handler-leaves-its-install-frame-through-a-mut-reference-field.yo` writes the handler into a field, `stash(slot : &mut Slot)` with `Slot :: struct(h : Raise, n : i32)`. Same output, rc 134.
- `issues/repros/2026-11-28-a-handler-leaves-its-install-frame-through-a-mut-reference-types.yo` stashes a handler of an `Option(Box(i32))` frame, then calls it from `later : -> String`, which installs its own handler. Output: one empty line, rc 0. `later` caught the dead handler's `.None` and printed it as a `String`.

Expected for all three: a compile error at the store, as for the positions the rules already cover. A handler in a `Box` result, behind `&mut ArrayList(Raise)`, in an `Option` result, captured by a spawned `io.async` body or by a closure that stores it is rejected today (VERDICTS-95 `q02`, `q06`, `q08`, `q07`, `q09`).

## Root cause

As VERDICTS-95 §7 states it: the escape rules enumerate positions (result types, pointer pointees, module bindings, counted cells, closure captures: `docs/en-US/ALGEBRAIC_EFFECTS.md`, "Typing rules for control functions", rules 4 and 8, the predicate `type_is_control_bound` and its 11 call sites) and miss a store through a reference. Rule 8 accepts a `&Raise` parameter because "the lend ends before the install frame does"; that holds for reading the handler, not for writing one into the referent.

## Fix

- K-3 (v0.2.82), the stopgap: a control-bound value cannot be written through a `&mut` (assignment to `slot.*`, to a field or an element reached through one).
- K-7 (v0.2.83–84, lane A, after N2c–N2f): a handler value carries the origin of its installer, and O3, O4 and O10 replace the enumeration with one structural check, so the store is E0909/E0912 by the existing rules.

## Test

None in this filing: the bug is open with no fix. The test lands with K-3: the three repros as `comptime_expect_error` cases.
