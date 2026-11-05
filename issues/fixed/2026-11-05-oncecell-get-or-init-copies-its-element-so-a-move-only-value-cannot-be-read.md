# `OnceCell(T).get_or_init` and `get` copy the element out, so a move-only `T` cannot be read

**Severity:** S2 — `OnceCell(String)`, or a cell over any non-`Copy` value, compiles to construction only: every read is E0901, so the type is unusable for the values V5 leaves behind.

Found while migrating `tests/sync/once.test.yo` off `atomic(ref(struct))` (V5 part B, branch
`vbd/v5-part-b-tests`), on develop 68b45b81d. Its "a cyclic element type is accepted" test read
an `atomic(ref(...))` node back through `get_or_init`, which copied the handle. A value node
cannot be copied.

## Symptom

```yo ignore
cell := OnceCell(String).new();
s := cell.get_or_init(() => String.from("hello"));
```

```
error[E0901]: use of moved value: cannot copy what `OnceCell(String).get_or_init` copies (its element), whose type `Option(String)` is move-only, and it cannot be moved either: it is a field of another value, and moving it out would leave that value partly moved (Yo has no partial moves). Move the whole value instead.
    --> issues/repros/2026-11-05-oncecell-move-only-element.yo:7:12
    --> std/sync/once.yo:187:9
```

Reproducer: `issues/repros/2026-11-05-oncecell-move-only-element.yo`.

## Cause

`std/sync/once.yo:179` declares `get_or_init : (fn(self : &Self, f : &Impl(Fn() -> T)) -> T)` and
returns `self._cell.*._value.expect(...)`, a copy of the stored element. `get` (`:191`) returns
`Option(T)` the same way. Before V5 the element types in use were `Copy` scalars or `ref`/`atomic`
handles, which copy implicitly. A value type with a `String`, an `ArrayList` or a `Drop` field does not.

## Fix direction (as filed)

Rust's `OnceCell::get_or_init` returns `&T`. The Yo equivalent is a projection result
(`-> &T`, decision 24) or a `with(body)` reader, plus a `get_cloned` for `T <: Clone`, as
`ArrayList` has (decision 20). This changes std's public API, so it belongs to the std lane of
V5 part B (`vbd/v5-part-b-std`). `tests/sync/once.test.yo`'s cyclic-element test then reads the
node back again (its comment names this doc).

## Fix

`OnceCell(T)` takes Rust's borrowing API (`OnceLock::get` / `get_or_init`):

- `get(self : &Self) -> Option(&T)` lends the stored value in place;
- `get_or_init(self : &Self, f : Impl(Fn() -> T)) -> &T` is a projection (decision 24): it runs
  `f` at most once (`_init`) and yields `&v` from `match(&self._cell.*._value, .Some(v) => &v, …)`.
  The initializer is taken by value, as Rust's `F: FnOnce() -> T` is: a `&Impl(Fn)` parameter
  would be a second root of the projection's result, so a closure literal argument (a temporary)
  could not be passed.

A reader writes `.*` where it used the value (`got.* == i32(42)`, `${v.*}`). This needed three
compiler pieces first: a projection's `&Self` writing the cell it reaches and a reference to a
newtype declared after its typedef (#1789), a `&` match binding that is a pointer into its
scrutinee (#1795), and decision 24's root rule following such a binding to the scrutinee's
place (`issues/fixed/2026-11-05-a-projection-cannot-yield-a-binding-of-a-borrowed-match.md`).
The std change needs them in the binary that reads `std/sync/once.yo`. Every CI step that reads it
runs the stage-1 tree binary, and the compiler does not import it, so no seed bump is needed.

## Test

`tests/sync/once.test.yo`: "OnceCell holds a move-only value and lends it" reads a
`OnceCell(String)` through `get_or_init` and `get`, and "a cyclic element type is accepted"
reads its node back again. The CLI case `once-reentrant-call-panics` reads `inner.*`.
