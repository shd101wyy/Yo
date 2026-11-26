# A free generic function stores a local's reference into a caller's `static` holder

**Severity:** S1 — safe code reads freed stack. `keep(generic(T : Type), dst : &mut Option(T), v : T)` called as
`keep(slot, r)`, with `slot : &mut Option(&(X, static))` a caller's holder and `r := &x` a reference to a local, is
accepted; the caller then reads `slot` after the local's frame is gone.

- Filed: 2026-11-27 by the `v81-infer-first` lane (VERDICTS-90 §9 item 1, probe `g3_static_dangle`).
- Reproduces with the v0.2.80 seed and with a tree binary built from develop at `ba2959c00`.
- **Status:** fixed on `wip/v0281-static-solve-s1`.

## Reproducer

```yo
{ assert } :: import("std/assert");
X :: struct(n : i32);
keep :: (fn(generic(T : Type), dst : &mut Option(T), v : T) -> unit)({
  dst.* = .Some(v);
});
fill :: (fn(slot : &mut Option(&(X, static))) -> unit)({
  x := X(n : i32(41));
  r := &x;
  keep(slot, r);
});
main :: (fn() -> unit)({
  mut(slot) := Option(&(X, static)).None;
  fill(&mut slot);
  n := match(slot, .Some(s) => s.*.n, .None => i32(0));
  assert(n == i32(41), "read through a dangling static reference");
  ()
});
export(main);
```

`yo check` is clean. Compiled with `--optimize 0 --sanitize address --allocator system` and run with
`ASAN_OPTIONS=detect_stack_use_after_return=1`:

```text
SUMMARY: AddressSanitizer: stack-use-after-return (…/g3_static_dangle-O0+0x178a22)
```

The same store through a local holder (`mut(slot) := Option(&(X, static)).None`, a block local `x` lent through
`keep(&mut slot, r)` and read after the block) is accepted too and reports `stack-use-after-scope`.

Every sibling spelling is rejected:

| Spelling | Verdict |
| --- | --- |
| `slot.* = .Some(r)` (a direct store) | E0923 |
| `keep2(slot, r)` over `keep2(dst : &mut Option(&(X, static)), v : &(X, static))` | E0923 |
| `slot.replace(r)`, `Option.replace(slot, r)`, `Option(&(X, static)).replace(slot, r)` | E0923 |
| `keep(slot, r)` into a caller's `Option(&X)` holder (elided or named origin) | E0912 |

## Root cause

`lend_through` (`src/evaluator/calls/function.yo`) judges what a call may store into a `&mut`-lent holder whose
pointee is declared over `static` in step 1c (`_static_type_argument_stores`, VERDICTS-74 rule 2): an argument
whose slot type occurs at a static position of the holder's pointee is judged by `_static_value_offense`. For a
method of a generic container the slots are the specialization's (`v : T` is `&X` there), so `&X` occupies
`Option(&(X, static))`'s position and the check fires. For a free generic function `_lend_through_slots` returns
the DEFINITION's slots (origins never specialize), where `v`'s slot is the binder `T`: it occupies nothing, and no
argument is judged. Step 3's flow write-back, which gives the elided and named holders their E0912, does not run
either: a holder whose every origin is `static` carries none, so `keep(slot, r)` stored the local's reference
unchecked.

## Fix

Step 1c reads a slot that names a type binder at the call's specialization: the callee node's recorded type,
which the inline `FuncVal` arm stamps with the specialized function (`_lend_through_spec_slots`). `v : T` is
then `&X`, it occupies the holder's static position, and `r` is judged as the store `slot.* = .Some(r)` would be:

```text
error[E0923]: Cannot keep this value in `slot`: its type is declared over the empty origin `static` (`Option(&X)`), which holds only values that borrow no place, and the value holds `x` (decision 49; plans/backlog/REFERENCES_AND_ORIGINS.md O3).
```

Tests: `tests/origins/unsound/static-generic-fn-store.yo` (through a caller's holder),
`static-generic-fn-store-block.yo` (a local holder, a block local), and the positive control
`static-generic-fn-store-pos.yo` (a reference declared over `static` is stored and read back).
