# A move-only element borrowed for a call is freed when an argument clears its container through another handle

**Severity:** S1 — heap-use-after-free in accepted code, reachable only through the deprecated `ref(...)` spelling (warned at every declaration since v0.2.74); the value program is E0901 since B8.

**Status:** OPEN until V5 Generation B's parser PR (v0.2.79, `plans/handover/VBD_RELEASE_SCHEDULE.md` §5f decision 37) makes `ref(` E0009; no fix is built for the spelling (maintainer, 2026-10-23: features being removed are documented, not fixed). It moves to `issues/fixed/` in the parser PR, never to `retired/`. Re-triaged 2026-11-10 by VERDICTS-42; found 2026-10-23 while fixing
`issues/fixed/2026-10-23-a-receiver-reached-through-an-rc-auto-deref-is-not-kept-alive-across-its-closure-argument.md`.

## What the issue was, and what is left

Filed when `ArrayList` was a `ref` object: `hs2 := hs` copied a handle, so E0910's name comparison missed the alias. Since B8 `ArrayList` is a `struct`: `hs2 := hs` MOVES, a second name for one list cannot be written in safe code, and the original program is **E0901 use of moved value**. Every other route to the same list under two names is rejected or panics (VERDICTS-42 §1): a same-name clear is E0910; a `&mut` alias, a holder or a capture list is E0910/E0911; a module-level mutable is E0916; a payload behind a plain `Rc` is read-only (E0919); `Rc(RefCell(ArrayList(...)))` and `Arc(Mutex(...))` panic at the outer cell (Rust's `BorrowMutError`), pinned by the cli-case `refcell-element-lent-outer-cell-cleared-panics`. The positive and negative value-language rows are `tests/origins/unsound/move-only-element-lent-container-moved(.yo|-pos.yo)`.

## The live route: a `ref(struct(...))` handle

Reproducers: `issues/repros/2026-10-23-a-move-only-element-borrowed-for-a-call-is-freed-when-an-argument-clears-its-container-through-another-handle.yo` (a closure argument clears the container through a second handle) and `issues/repros/2026-10-23-a-ref-handle-sibling-clears-a-lent-element.yo` (a by-value sibling argument does). Built with `--std-path ./std --sanitize address --allocator system`, both report `heap-use-after-free`:

```yo ignore
H :: ref(struct(items : ArrayList(RefCell(String))));
main :: (fn() -> unit)({
  h := H(items : ArrayList(RefCell(String)).new());
  h.items.push(RefCell(String).new(String.from("hello")));
  h2 := h;
  h.items(usize(0)).with_mut(v => {
    h2.items.clear();
    println(&v.*);
  });
});
```

## Cause

The static side never relates two `ref` handles: decision 28's reference-semantic-edge clause is by type for non-closure siblings, but the path here is a `ref`-rooted field (`h.items`) and `_reject_if_container_reachable` judges an atom container; the closure clause is by name. The run-time side marks only a container that is itself a counted object, and `h.items` is a value, so the mark has nowhere to go.

## Fix directions (all struck, VERDICTS-42)

1. Hold the container for the call (+1 on the nearest counted object): none exists on a value path; on the `ref` path `clear` destroys the element in place.
2. A runtime mark on the container (the auto-borrow machinery): rejected by decision 41 (one spelling of the run-time check, `RefCell`); a value container has no header word; the machinery dies with `ref`.
3. Reject statically any capture or sibling of the same handle type: coarse, needs a census over src's 74 remaining `ref` declarations; not worth it for two releases (VERDICTS-42 §4 records the fallback).

The spelling's deletion (E0009) closes the hole; the two `ref` G-B rows (`ref-handle-copy-clears-lent-element`, `ref-handle-sibling-clears-lent-element`, `// expect: E0009`) land with that parser PR, as listed in schedule §5f decision 37.
