# `StringBuilder.clear` frees the buffer its doc promised to keep

**Status: FIXED 2026-09-14.** `clear` now calls `self._buf.clear()`, which
drops the elements and resets the length while KEEPING the buffer — the
contract its own doc comment had promised. Verified red-then-green; see
"Fix" below.

**Was:** open (found by the `std/` `///` doc sweep, 2026-09-11)
**File:** `std/string/string_builder.yo` — `clear`

## Behaviour

The doc comment said, verbatim:

```
/**
* Clear the buffer without freeing memory.
*/
```

The body throws the buffer away:

```rust
clear : (fn(self : Self) -> unit)({
  self._buf = ArrayList(u8).new();
})
```

Assigning a fresh `ArrayList` drops the last reference to the old one, which
frees its heap block. So the capacity is NOT retained, and a builder cleared
inside a loop reallocates from zero on every pass — the opposite of what the
method exists for.

## Divergence

- Rust's `String::clear` "truncates this String, removing all contents ...
  Note that this method has no effect on the allocated capacity".
- `ArrayList.clear` in this same tree already does the right thing
  (`std/collections/array_list.yo:759`): it drops the elements, sets
  `_length = 0`, and leaves `_ptr` / `_capacity` alone.

So the correct body is one call away:

```rust
clear : (fn(self : Self) -> unit)({
  self._buf.clear();
})
```

## Why the doc was written that way

`to_string()` deliberately DETACHES the buffer (`bytes := self._buf; self._buf
= ArrayList(u8).new()`), and `clear` looks like it was copied from it. For
`to_string` handing the allocation to the returned `String` is the point; for
`clear` it is the bug.

## Reproducer

Not included: `_buf` is private and `StringBuilder` exposes no `capacity()`,
so the regression has to be observed either through an allocation counter or
by adding `capacity()` alongside the fix. The defect is visible by inspection
of the two bodies above.

## Not fixed here

Found during a documentation-only sweep. The `clear` doc comment has been
corrected to describe what the code actually does (and to point at this file);
the behaviour is untouched.

---

## Fix (2026-09-14)

One line: `self._buf = ArrayList(u8).new()` becomes `self._buf.clear()`.
`ArrayList.clear` frees the elements and sets `_length = 0` **without**
releasing the buffer, which is exactly "clear without freeing memory" and what
Rust's `String::clear` does.

The doc comment is rewritten too. It had been updated during the doc sweep to
describe the WRONG behaviour accurately ("This RELEASES the buffer rather than
retaining its capacity") with a workaround suggestion. That was the honest
thing to do while the bug stood, and it is now false, so it states the real
contract instead: `len()` becomes 0, `capacity()` is unchanged.

### A `capacity()` accessor was needed to make the fix testable

`StringBuilder` had `with_capacity` — capacity could be SET but never READ —
so the contract this doc is about was **unobservable from outside the module**,
and therefore untestable. A fix nothing can observe is the failure mode this
whole corpus is full of (`issues/leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md`
is the same shape).

So `capacity()` is added, mirroring Rust's `String::capacity`. It is a small
public addition beyond the bug, and deliberate: without it the regression test
could only assert `len()`, which was already correct before the fix and would
have passed either way.

## Regression tests (added)

`tests/fmt.test.yo`, two tests, both red against the pre-fix `clear` (exit code
6) and green after:

1. **the contract** — `with_capacity(64)`, write 11 bytes, `clear()`, then
   assert `len() == 0`, `is_empty()`, and **`capacity()` unchanged**; then
   write again and check the builder still produces the right string, so the
   fix cannot have broken reuse.
2. **capacity acquired by GROWING** — 200 single-byte writes into a
   `StringBuilder.new()`, then `clear()`, asserting the grown capacity
   survives. This is the case that actually motivates the contract: a builder
   reused in a loop. Testing only the `with_capacity` path would have missed a
   fix that special-cased the reserved buffer.

Clean under the published v0.2.32 seed.
