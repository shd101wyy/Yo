# A move-only element borrowed for a call is freed when an argument clears its container through another handle

**Severity:** S1 — memory unsafety in accepted safe code: the callee reads (and `RefCell`'s guard writes) an element the closure argument already destroyed (ASan heap-use-after-free).

**Status:** OPEN — found 2026-10-23 while fixing
`issues/fixed/2026-10-23-a-receiver-reached-through-an-rc-auto-deref-is-not-kept-alive-across-its-closure-argument.md`,
which closes the same hole for a place reached through an `Rc`/`Arc` and for
a copyable element. Present before that fix and after it.

## Reproducer

`issues/repros/2026-10-23-a-move-only-element-borrowed-for-a-call-is-freed-when-an-argument-clears-its-container-through-another-handle.yo`
(`--std-path ./std --optimize 2 --sanitize address --allocator system`):

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ RefCell } :: import("std/sync/refcell");
main :: (fn() -> unit)({
  hs := ArrayList(RefCell(String)).new();
  hs.push(RefCell(String).new(String.from("hello")));
  hs2 := hs;
  hs(usize(0)).with_mut(v => {
    hs2.clear();
    println(&v);
  });
});
export(main);
```

```
==…==ERROR: AddressSanitizer: heap-use-after-free on address … READ of size 8
```

The same holds for `ArrayList(Box(RefCell(String)))`, for any element type
with a `Drop` impl, and for the argument spelling
`RefCell(String).with_mut(&hs(usize(0)), …)`.

## Cause

Aliasing Stage 0 keeps a borrowed place alive for a call with a caller-owned
+1 (`set_expr_as_needs_to_call_dup_for_borrowed_projection`,
`src/evaluator/utils.yo`). A move-only value has no +1: its copy would be a
second owner whose drop runs the destructor twice, so the marker skips it
and relies on argument exclusivity (E0910) to keep the container alive.
E0910 compares names: `hs2` is a second handle to the same list, so
`hs2.clear()` passes, frees the element, and the callee goes on with a
dangling `&Self`. When the element sits in an `Rc`/`Arc` payload the share
goes on the handle instead, which is why `ArrayList(Rc(RefCell(T)))` is safe.

## Fix directions

1. Hold the container for the call: take the +1 on the nearest counted
   object the element lives in (here the list's own handle), so a clear
   through another handle releases its reference but not the storage. The
   list's `clear` still destroys the elements in place, so this alone is not
   enough: the buffer would also have to stay intact.
2. Mark the container borrowed for the call and make every mutation through
   any handle check the mark (the runtime borrow flag `__yo_borrow_assert_unborrowed`
   already checks a `ref` object at its destructor), panicking instead of
   freeing a borrowed element.
3. Reject the closure statically when it captures any handle of the
   container's type: too coarse without origins (decision 43).
