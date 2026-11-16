# A reference binding passed bare to a reference parameter gives the call result no origin

**Severity:** S1 — use-after-free in safe code: inside an `FnMut` literal `{ s : &mut h, rx : &x }() => { s.* = mkh(rx); }`, with `mkh :: fn(a : &i32) -> Option(&i32)`, the stored call result points into `x`, `h` outlives `x`, and the program is accepted; with an `Rc` payload ASan reports a heap-use-after-free at the read of `h` after `x`'s block.

- Filed: 2026-11-16, from the borrow-program generator G-D (`scripts/origins-gen.py`): GitHub #1935
  (`slot:int/opt/call/capture/scope_end/x/after`, ACCEPT-VS-RUST, rustc E0597) and #1974
  (`slot:rc/opt/call/capture/scope_end/x/after`, UAF).
- Not new: the v0.2.78 seed accepts every shape below.
- Audit row: `plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3.1 A57.

## Reproducer

```yo ignore
{ println } :: import("std/fmt");
mkh :: (fn(a : &i32) -> Option(&i32))(Option(&i32).Some(a));
main :: (fn() -> unit)({
  mut(z) := i32(12);
  mut(h) := Option(&i32).Some(&z);
  {
    mut(x) := i32(7);
    (mut(c) : Impl(FnMut() -> unit)) = ({ s : &mut h, rx : &x }() => { s.* = mkh(rx); });
    c();
  };
  match(&h, .Some(r) => println(`OUT: ${r.*.to_string()}`), .None => println("none"));
  ()
});
export(main);
```

`yo check` accepts it. The same program with `s.* = .Some(rx);` is rejected with E0911 (`Cannot store a reference to
\`x\` in \`h\` here: \`x\`'s scope ends with its block`), as is the same store outside a closure (`rx := &x; h =
mkh(rx);`). The G-B rows `tests/origins/unsound/gd-capture-call-result-store*.yo` carry the `Rc` variant (the ASan
heap-use-after-free) and the related shapes, all accepted before the fix:

| Shape | Before | Rust |
| --- | --- | --- |
| `s.* = mkh(rx)` (`FnMut`, and `FnOnce`) | accept | E0597 |
| `y := mkh(rx); s.* = y;` | accept | E0597 |
| `s.* = idopt(mkh(rx))` (a nested call) | accept | E0597 |
| `s.* = gmk(rx)` (`gmk :: fn(generic(T : Type), a : &T) -> Option(&T)`) | accept | E0597 |
| `s.* = w.mk(rx)` (a method, `w` a capture too) | accept | E0597 |
| `({ s : &mut h }(p : &i32) => { s.* = mkh(p); })` (a per-call parameter) | accept | E0521 |

## Root cause

`origin_of(mkh(rx))` (R-CALL, `_origin_of_into` in `src/evaluator/utils.yo`) was `[]`. A reference binding passed
bare at a reference parameter is no lend and no reference read: the reference slot exempts the atom from the read
rule (decision 43 step 2 N1e-2b), so it is evaluated, and typed, at its POINTEE's type (`i32`), and no converted
reference type is recorded, since the binding already is the reference. R-CALL computed the root argument's origin
with `_origin_of_into(rx)`, whose R-NONE gate (`!type_carries_origin(i32)`) returned nothing. Two other paths hid the
hole everywhere else:

- a LOCAL reference binding (`rx := &x`) has registered local-borrow entries, and the shallow walk
  (`_origin_carrying_roots_shallow`'s holder fallback) reads them, so `h = mkh(rx)` was rooted at `x`;
- `.Some(rx)` records the lend (`expr_info_converted_runtime_type` is `&i32`), so R-LEND pushes the place `rx`.

A capture `{ rx : &x }` and a reference parameter have no entries of their own: the place they refer to is their own
place, which a store through a `&mut` capture maps to the capture's outer place (`_capture_store`, by
`borrow_capture_outer`) and a store of a literal's parameter rejects (E0923). Neither got a root, so `s.* = mkh(rx)`
stored a rootless value and joined nothing into `h`.

## Fix

R-CALL's reference root argument goes through `_origin_of_reference_arg_into`: an atom naming a reference binding
that is not a reference read has R-READ's origin — a reference payload's held places, else the binding's registered
entries, else its own place with the parameter's mode — the same set the recorded lend of `.Some(rx)` gives. Every
other argument keeps `_origin_of_into`.

## Status

Fixed (`fix/gd-closure-call-store`), with the G-B rows above and the test "a call result over a reference capture reaches the slot through a `&mut` capture" in `tests/closure_capture_list.test.yo`.
