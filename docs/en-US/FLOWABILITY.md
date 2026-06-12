# Flowability — safe-by-default references

Yo guarantees, at compile time, that safe code cannot construct a
dangling reference. The design is **sound by construction**: the safe
language has no way to form a pointer into reallocatable storage, so
the classic invalidation footguns (grow a list, dangle a borrow) are
not rejected by a clever analysis — they are *inexpressible*.

## Where a `ref` can exist

`ref` is Yo's second-class reference. It appears in exactly two places:

- **Parameter position** — `ref(name) : T` receives a caller lvalue
  (write-back, and no copy for big structs). Callback parameters that
  receive refs (`body : Impl(Fn(ref(v) : T) -> R)`, as in
  `Mutex.with_lock`) are the same thing one level down.
- **Local lvalue borrows** — `ref(r) := lvalue;` borrows a local
  variable, a field of a `ref`-bound parameter, or an object field.

**Functions cannot return `ref`.** A returned ref would be a pointer
into storage the caller can reallocate or free; the compiler rejects
`-> ref(T)` (and the labeled forms) at signature evaluation. Refs also
cannot be stored in fields, captured by closures, or placed inside
generic types — they never outlive the frame below them.

Every safe `ref` therefore roots in either a **frame slot** (which
outlives the callee by construction) or an **object field** — and
object allocations never move. For object-field borrows the compiler
additionally **pins the owner**: `ref(r) := h.s` holds a +1 on `h`'s
object for the borrow's scope (two refcount operations per *binding*,
not per access), so the object cannot be freed while the borrow lives —
no matter what aliases exist anywhere.

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

## Borrow invalidation diagnostics

While a `ref(r) := …` binding is live, the variable its borrow roots in
may not be **reassigned**, **moved**, used as a **method receiver** or
**call argument**, or **aliased** (`h2 := h`) — each is a compile error
naming the borrow. Pre-existing aliases are constrained too (the marks
apply to the whole alias group), and creating another borrow from the
same owner stays allowed. The constraint ends with the binding's block.
These gates are diagnostics on top of the pin: they catch the mistake at
the line that makes it, rather than letting the pin silently extend the
object's lifetime.

One cross-function rule completes the story: **a single call may not
receive the same object as both a ref-rooted argument and an `own`
argument** (`use_and_sink(h.s, h)` with `own(victim)` is rejected) —
`own` moves the caller's count into a callee that could release it while
the borrow is still in use. Distinct objects are fine. By-value overlap
is fine too: a borrowed handle can never release the caller's count
(forwarding it to an `own` position dups first).

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
