# Flowability — safe-by-default references

Yo guarantees, at compile time, that safe code cannot construct a
dangling reference. The design is **sound by construction**: the safe
language has no way to form a pointer into reallocatable storage, so
the classic invalidation footguns (grow a list, dangle a borrow) are
not rejected by a clever analysis — they are *inexpressible*.

## Where a `ref` can exist

`ref` is Yo's second-class reference, and it exists in exactly ONE
place: **parameter position**. `ref(name) : T` receives a caller lvalue
(write-back, and no copy for big structs). Callback parameters that
receive refs (`body : Impl(Fn(ref(v) : T) -> R)`, as in
`Mutex.with_lock`) are the same thing one level down.

**Functions cannot return `ref`**, there are **no local ref bindings**
(`ref(r) := …` is rejected with a migration recipe — fields read and
write in place, `h.s = v`; binding the handle `b := a.b` keeps an
object alive), and refs cannot be stored in fields, captured by
closures, or placed inside generic types. A ref is born at a call
boundary and dies when the call returns — it can never outlive the
storage it points into.

The argument passed to a `ref` parameter is a simple lvalue **place**:

- a whole variable (any scope — a variable's slot is stable storage);
- `var.field` (or a struct-field path) rooted at a **local or
  parameter** — the place lives inside the root's allocation, which the
  caller's handle keeps alive for the whole call;
- chains through an intermediate **object** (`a.b.s` where `b` is an
  object field) and field chains rooted at **module-level** variables
  are rejected — a callee could replace that handle's slot and free the
  borrowed storage. The recipe is one line: bind the object to a local
  first (`b := a.b`) — the local handle pins it naturally;
- an **indexed element** (`xs(i)`) is a pointer into the container's
  buffer; it may be a ref argument only when the callee cannot reach
  the container — passing the container (or an alias) in the same call,
  or indexing a module-level container, is rejected (growth would
  realloc the buffer under the reference). Element-only uses
  (`to_string(xs(i))`, `${xs(i)}`, `bump(xs(i))`) are safe and legal;
  to combine element and container in one call, copy the element out
  with `.get(i)` first.

## Element access: handles and copies, not interior pointers

Containers hand out **values**, never pointers into their buffers:

```rust
e := xs.get(i);          // object elements: a HANDLE to the element
e.push_str("!");         //   mutates the element in place; the handle
                         //   survives xs.push / realloc — it points at
                         //   the String object, not into xs's buffer
xs(i) = v;               // index WRITE for in-place element replacement
t := xs.get(i).unwrap(); // struct elements: copy out …
xs(i) = t2;              //   … write back
for(xs, (x) => { ... }); // iteration is the value form (into_iter)
```

There is no `project`, no `Indexable`, and no borrow form of `for` —
`for(coll, ref(x) => …)` produces a compile error with this migration
recipe. `str` remains the immortal static-bytes view (freely copyable,
no constraints), and range indexing **copies** (`arr(a..b)` returns a
new `ArrayList`), so mutating the source never affects the result.

## One call-site rule

**A single call may not receive the same object as both a ref-rooted
argument and an `own` argument** (`use_and_sink(h.s, h)` with
`own(victim)` is rejected) — `own` moves the caller's count into a
callee that could release it while the borrow is still in use. Distinct
objects are fine. By-value overlap is fine too: a borrowed handle can
never release the caller's count (forwarding it to an `own` position
dups first).

With no local bindings there is nothing left to "invalidate": the old
borrow-invalidation gates were deleted along with the binding form.
Element handles from `get` survive any container operation — even
reassigning the container — because they own a +1 on the element
object.

## Escape hatches

`pragma(Pragma.AllowUnsafe);` exempts a whole file (std's audited
internals); `unsafe(expr)` marks a single expression. The raw-pointer
`Index` impl (`index : … -> *(T)`) is the supported zero-copy escape for
hot loops that measurably need it. See
[MEMORY_SAFETY.md](./MEMORY_SAFETY.md).

## Tests

`tests/ref_binding.test.yo`, `tests/ref_local_binding.test.yo`,
`tests/ref_params.test.yo`, `tests/ref_field_borrow.test.yo` (incl. the
owner pin and the ref/own call gate), `tests/ref_borrow_invalidation.test.yo`
(the gate matrix + the get-handle model), `tests/ref_return_ban.test.yo`,
and `tests/flowability_comprehensive.test.yo`.
