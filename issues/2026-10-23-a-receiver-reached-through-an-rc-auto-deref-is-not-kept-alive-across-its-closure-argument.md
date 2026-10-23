# A `&Self` receiver reached through an `Rc` auto-deref is not kept alive across its closure argument, and E0910 does not check it

**Severity:** S1 — memory unsafety in accepted safe code: a closure argument that frees the receiver's `Rc` cell leaves the method reading freed memory (ASan heap-use-after-free).

**Status:** OPEN — found 2026-10-23 by the adversarial review of `RefCell.replace_with`
(step 0 of `issues/questions/2026-10-23-should-yo-add-a-flagless-cell.md`). Not fixed
there: the fix is in the evaluator, and that change is std-only.

## Reproducer

`issues/repros/2026-10-23-a-receiver-reached-through-an-rc-auto-deref-is-not-kept-alive-across-its-closure-argument.yo`
(seed v0.2.68 and a develop tree binary, `--std-path ./std --optimize 2 --sanitize address --allocator system`):

```yo ignore
W :: struct(s : String);
impl(W, peek : (fn(self : &Self, act : &Impl(Fn() -> unit)) -> unit)({
  act();
  println(&self.s);
}));
hs := ArrayList(Rc(W)).new();
hs.push(rc(W(s : String.from("hello"))));
hs(usize(0)).peek(() => {
  hs.clear();
});
```

```
==…==ERROR: AddressSanitizer: heap-use-after-free on address … READ of size 8
```

Expected: either E0910 at the call, or `hello`.

## What is and is not affected

- The receiver position through an `Rc` auto-deref is the gap. The same lend
  as an argument, `peek_rc(&hs(usize(0)), () => { hs.clear(); })` with
  `peek_rc : (fn(w : &Rc(W), act : …) …)`, is rejected with E0910 (the
  closure's `hs.clear()` lends `hs` `&mut` while an earlier argument lends it).
- Without the `Rc` (`ArrayList(W)`, `hs(usize(0)).peek(…)`) the program
  prints `hello` with no ASan report: the receiver is a copy of the element.
- `RefCell(T)` reaches it the same way: `hs(usize(0)).with_mut(v => { hs.clear(); … })`
  over `ArrayList(Rc(RefCell(String)))` is a heap-use-after-free on develop,
  and so is `replace_with`. The access guard `_RefCellRelease` then writes the
  mark into the freed slot, and `replace_with`'s `_swap` reads the freed slot
  out as the returned old value. Their SAFETY comments in
  `std/sync/refcell.yo` cite this doc.

## Cause

The auto-deref of an `Rc` receiver yields a pointer into the `Rc` cell without
retaining the handle for the call, and the decision 28 argument-exclusivity
check (E0910) compares the later arguments' lends against the earlier
arguments only, not against the place the receiver was reached through.

## Fix directions

1. Treat the receiver as argument 0 in E0910: a closure argument that lends
   the receiver's root `&mut` is rejected, as the free-function form is.
2. Or retain the `Rc` handle for the duration of the call when the receiver is
   reached through an auto-deref (Rust has no such case: the borrow checker
   rejects the closure).

A fix adds the reproducer as a negative test (E0910) or a run test printing
`hello` under ASan, plus the `RefCell.with_mut` form to
`tests/sync/refcell.test.yo`.
