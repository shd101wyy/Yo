# Flowability — safe-by-default references

Yo guarantees, at compile time, that safe code cannot construct a
dangling reference. The design is **sound by construction**: the safe
language has no way to form a pointer into reallocatable storage, so
the classic invalidation footguns (grow a list, dangle a borrow) are
not rejected by a clever analysis — they are _inexpressible_.

## Where an `inout` can exist

`inout` is Yo's second-class reference, and it exists in exactly TWO
places: **parameter position** and **local binding position**.
`inout(name) : T` receives a caller lvalue (write-back, and no copy for big
structs); callback parameters that receive refs
(`body : Impl(Fn(inout(v) : T) -> R)`, as in `Mutex.with_lock`) are the
same thing one level down. `inout(name) := place;` binds `name`, for the
rest of the enclosing block, to the storage `place` denotes:

```rust
x := i32(1);
inout(y) := x;        // y names x's slot
y = i32(2);           // writes x
x = i32(5);           // y reads 5: the binding names the SLOT, not a value
inout(n) := h.n;      // a field of an RC object: h's object is pinned for the scope
inout(px) := p.x;     // a field of a value struct
copy := y;            // copies the pointee — there is no "inout type" to store
```

A local binding accepts the same **places** an argument does (below), with
one addition: a field reached through an RC object (`h.n`, `a.b.n`) is
allowed and **pins** the innermost object — a hidden owning local keeps it
alive until the binding's scope ends, on `break`, `return` and effect
`unwind` alike — so reassigning or dropping the visible handle cannot free
the storage the binding names. Two things a binding forbids: **moving its
root while it is live** (`sink(own(x))` with `inout(y) := x` in scope is a
compile error — copy the value out, or end the binding's scope first), and
**element places** (`xs(i)`, `p.*`): a pointer into a collection's storage
has no owner a binding could pin. Bindings are local (not at module level),
not available inside `io.async` bodies, and take `:=` only.

**Functions cannot return `inout`**, and refs cannot be stored in fields,
captured by closures, or placed inside generic types. An `inout` is born
at a call boundary or a binding and dies with the enclosing scope — it can
never outlive the storage it points into.

The argument passed to an `inout` parameter is a simple lvalue **place**:

- a whole variable (any scope — a variable's slot is stable storage);
- `var.field` (or a struct-field path) rooted at a **local or
  parameter** — the place lives inside the root's allocation, which the
  caller's handle keeps alive for the whole call;
- chains through an intermediate **object** (`a.b.s` where `b` is an
  object field) and field chains rooted at **module-level** variables
  are rejected — a callee could replace that handle's slot and free the
  borrowed storage. The recipe is one line: bind the object to a local
  first (`b := a.b`) — the local handle pins it naturally;
- an **indexed element** (`xs(i)`) or a chain through an **intermediate
  object** (including a `Box` deref `b.*`, since `Box` is an ordinary
  object and `*` is just a field) is a pointer into a heap object's
  storage; it may be an `inout` argument only when the callee cannot reach
  that object — passing the container/box (or an alias), indexing a
  module-level container, or passing **any other object/closure
  argument** that could hold a handle to it, is rejected (growth or
  reassignment could free the storage under the reference). Element-only
  uses (`to_string(xs(i))`, `${xs(i)}`, `bump(xs(i))`,
  `owner_box.*.id.clone()`) are safe and legal; to combine element and
  container in one call, copy the element out with `.get(i)` first.

> **Runtime backstop.** One shape evades the static argument-reachability
> check: a container that escaped into a _global_ heap structure earlier
> (`g.push(xs); bump(xs(i))` where `bump` grows `xs` through the global).
> Closing it statically would require whole-program escape analysis. A
> lightweight runtime borrow flag (`borrow_count` on the RC header, zero
> extra bytes in existing padding) closes this residual: the callee panics
> deterministically (`"container operation while an interior reference
borrows from it"`) instead of corrupting memory. Same-cache-line load
> and a predicted branch — measured ~0% overhead.

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

Elements can also be **borrowed**, in exactly one place: the borrowed
`for`.

```rust
for(enemies, inout(e) => { e.hp = (e.hp - i32(1)); });   // struct elements, in place
for(names, inout(s) => { s.push_str("!"); });            // RC elements, no dup per element
for(counts, inout(c) => { bump(c); });                   // hand the element to an inout param
for(scores, (k, inout(v)) => { v = (v + i32(10)); });    // maps: key by value, value borrowed
```

The macro binds the collection to a hidden local (it cannot be freed while
the loop runs), holds the collection's **runtime borrow flag** for the whole
loop, and binds each element as an `inout` local into the collection's own
storage through the pointer iterator `iter()` — which is why `iter()` exists
and why it yields `*(T)`: it is the protocol `for` consumes, not an API for
user code. `break`, `continue`, `return` and effect `unwind` all release the
flag. While it is held, any operation that could invalidate an element —
growth, shrink, removal, on the collection itself or through any alias —
**panics deterministically** (`container operation while an interior
reference … borrows from it`) instead of leaving the element reference
dangling. This is the one place where Yo's safety guarantee is a runtime
check rather than a compile-time rejection (Swift's model for shared
storage); the compiler emits the assert at the entry of every method of an RC object
whose body may mutate the object (decided from the body, since Yo has no
`mut`), so any collection — std or third-party — is covered without
annotations. The decision is a may-analysis and is not per-parameter: a
read-only method whose body mutates a *fresh local* (`clone` pushes into its
result) is still classed as mutating, so `xs.clone()` inside a borrowed loop
over `xs` panics — copy before the loop instead (`snapshot := xs.clone();`).
Read-only methods (`len`, `get`, `contains`, `index_of`, `==`, iteration)
carry no assert and cost nothing; a mutating method pays one load-compare
at entry (~7–9 % on a nanosecond-scale `push`/`pop` microbenchmark, unmeasurable
elsewhere). Plain
`inout(e)` over a map yields the whole entry; prefer `(k, inout(v))`, which
keeps keys immutable. `Array(T, N)` has no `iter()` and takes the value form
or an index loop. Inside an `io.async` body that suspends (a real state
machine) neither `inout` bindings nor the borrowed `for` are available yet;
use the value form there.

There is no `project` and no `Indexable`. `str` remains the immortal
static-bytes view (freely copyable, no constraints), and range indexing
**copies** (`arr(a..b)` returns a new `ArrayList`), so mutating the source
never affects the result.

## One call-site rule

**A single call may not receive the same object as both an `inout`-rooted
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
