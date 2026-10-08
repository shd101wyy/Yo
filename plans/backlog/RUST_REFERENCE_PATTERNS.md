# Rust reference-in-structure patterns in post-VBD Yo

**Status: BACKLOG** — a companion to
[`VALUES_BY_DEFAULT.md`](../VALUES_BY_DEFAULT.md), written 2026-10-08 and
parked here on the maintainer's call (2026-10-08): it is a reference catalog,
not an implementation plan — nothing here drives a phase. It answers one
question: **Rust stores borrows in data structures**
(`struct S<'a> { r: &'a T }`), **and Yo's borrows are second-class — what
replaces each shape?**

The catalog describes the model **at V5**: every declared type a value,
`ref(...)`/`atomic(...)` gone, sharing only where `Rc`/`Arc` is spelled. It was
written against the 2026-10-07 tree (landed: the `Rc` rename and canonical
spelling, decision 32's clash error, the `Send`/`Sync` split, `FnOnce`,
decision 36 part 1, local borrows and re-points, capture lists, V3b Generation
A); the shapes that depend on V1 step 2 (the unique `Box`), V2b (projections,
`with`, `indices`, value collections), V2c (explicit `Rc.clone`) and V5 are
marked and land with those phases. At V5 this document is the seed of the
user-facing porting guide (`docs/en-US/` + `docs/zh-CN/`, linked from the
plan's V5 docs list).

Decision numbers (`D18`, `D39`, …) refer to `VALUES_BY_DEFAULT.md` §4; bare
`§`-references (`§3.10`, `§3.13 A2`) are that plan's sections.

---

## 1. The rule, and the five replacement shapes

**A borrow is a mode, never a type** (D30, D38 A). `imm`/`mut` annotate
positions — parameters and receivers (`imm(x) : T`), local bindings
(`imm(y) := place`), re-points (`mut(cur) = place`), projection results
(`-> mut(T)`), capture-list entries, and the argument sigils `&x`/`&mut x` at
call sites (D33). A borrow can never be a field type, an element type, a
generic argument of a type constructor, a stored/returned value, or a `Dyn`
payload. That is why no lifetimes exist: every check is intraprocedural.

A Rust struct that holds a reference therefore becomes exactly one of five
shapes, in the order Yo prefers them:

| # | Shape | Costs | Use when |
| --- | --- | --- | --- |
| 1 | **Own it** — the field holds the value `T` (a recursive child in `Box(T)`) | a move or `.clone()` at the boundary | this structure is the value's sole owner for its whole life |
| 2 | **Share it** — the field holds a handle: `Rc(T)` (one thread) or `Arc(T)` (across threads) | one allocation, count traffic, per-cell borrow marks on write (§3.10) | aliasing is real and long-lived |
| 3 | **Index it** — the field holds an index/key into an owner living elsewhere (`usize`, an arena id, a map key) | a bounds/lookup step per access; the owner must outlive the index | graphs, caches, interners — often *faster* than a pointer (§12) |
| 4 | **Pass it, don't store it** — the function takes `imm(x) : T` / `mut(x) : T`, or takes a non-escaping closure (`imm(body) : Fn(mut(v) : T) -> R`) | none (an `Impl(Fn)` body inlines) | the borrow's life is one call |
| 5 | **Re-derive it** — store a small `Copy` cursor (an offset, a `Range(usize)`), re-derive the place at each use through an owner you can name | one bounds check per re-derivation | zero-copy views, cursors, walkers |

Everything below is these five shapes applied to the recurring Rust patterns.

## 2. Borrowed views into a buffer

### 2.1 The zero-copy lexer/parser — `struct Lexer<'a> { src: &'a str }`

```rust
// Rust
struct Lexer<'a> { src: &'a [u8], pos: usize }
impl<'a> Lexer<'a> {
    fn peek(&self) -> Option<u8> { self.src.get(self.pos).copied() }
}
```

The Yo lexer **stores no view** (shape 5): its state is a `Copy` cursor, the
buffer is borrowed per call (shape 4), and each access re-derives the place:

```rust
Lexer :: struct(pos : usize, len : usize);
derive(Lexer, Copy, Clone);

peek :: (fn(imm(src) : ArrayList(u8), st : Lexer) -> Option(u8))(
  cond(st.pos < st.len, .Some(src(st.pos)), .None)
);
```

- `src(st.pos)` is element access **by place** (D20): it borrows in read
  position, costs one bounds check, and copies nothing.
- If the lexer must be a value (stored in a task, a token stream), it owns the
  buffer (`src : String`, shape 1) or holds a handle (`src : Rc(String)`,
  shape 2).
- On `String`: the byte index is read-only (post-S3), and a `str` view into an
  owned buffer is not a safe value — see 2.2.

### 2.2 Stored sub-views — `&'a [T]` / `&'a str` fields, `fn words(&self) -> Vec<&str>`

```rust
// Rust
struct Doc { text: String }
impl Doc {
    fn words(&self) -> Vec<&str> { self.text.split_whitespace().collect() }
}
```

A view into an owned buffer cannot be stored. Store **offsets** (shape 5) and
re-derive:

```rust
Doc :: struct(text : String);
word_ranges :: (fn(imm(self) : Doc) -> ArrayList(Range(usize)))(...);   // Copy elements
// use — the view is re-derived at each step, never stored:
ranges := doc.word_ranges();
imm(d) := doc;
for(ranges, r => { process(&d.text, r); });
```

- `Range(usize)` is `Copy` (a conditional `derive` pair, D36's sweep), so the
  ranges list is plain data.
- A `str` **is** storable when it is derived from a literal or from another
  `str` only (that is the one condition on `str`'s `Copy` impl, D36): an
  `ArrayList(str)` of static names is fine; a view of a `String`'s interior is
  not (`String.as_str` is removed at V2b; D40 rules out storable borrows).
- If the sub-strings are needed as values, clone them out (`x.clone()`); the
  copy is visible, which is the point.

### 2.3 Self-referential structs — `Pin` + unsafe

```rust
// Rust: needs unsafe + Pin
struct BufReader { buf: String, cur: &'a str /* into buf */ }
```

**Unexpressible and unnecessary** (D40). Safe Yo cannot build a value that
references itself or a sibling — borrows are places, never fields — so the one
hazard `Pin` polices does not arise; heap storage (cells, buffers, started
state machines) never relocates, and a suspended async task is a stable heap
state machine, not a moved stack frame. The Rust pattern that *wants* a
self-view (a cursor into a own buffer) is shape 5: own `buf`, store
`Range(usize)`, re-derive.

## 3. A borrow held across calls

### 3.1 The context struct — `struct Ctx<'a> { db: &'a Db }`

```rust
// Rust
struct Ctx<'a> { db: &'a mut Db, cfg: &'a Config }
fn work(ctx: &mut Ctx) { ctx.db.write(..) }
```

Two Yo shapes, picked by where the context lives:

```rust
// Shape 4: call-local — no Ctx type at all; the borrows are the signatures
work :: (fn(mut(db) : Db, imm(cfg) : Config) -> unit)(...);
work(&mut db, &cfg);                      // the sigils say what is lent (V3b)

// Shape 2: stored (a task, a spawn, a registry) — handles, not borrows
Ctx :: struct(db : Rc(Db), cfg : Rc(Config));
```

- The stored form is exactly what the compiler's ~60 context objects become at
  V5 (`Rc(struct(...))`, the plan's V5 list).
- Through a handle, `ctx.db.write(...)` auto-derefs (§3.3) and a write asserts
  no conflicting borrow mark on the cell (§3.10). Sharing the `Db` across
  threads is `Arc(Db)` for reads (needs `Db <: (Send, Sync)`) or
  `Arc(Mutex(Db))` for writes (D3: no write through an `Arc` root in safe
  code).
- A handle copy is explicit: `Rc.clone(ctx.db)` (D17/D32 — `ctx.db.clone()` is
  the clash error when `Db` is also `Clone`).

### 3.2 Guard objects — `MutexGuard<'a, T>`, `RefMut<'a, T>`, lock-then-hold APIs

```rust
// Rust
let g = m.lock().unwrap();   // holds &mut T through a guard value
*g += 1;
```

Safe Yo **returns no guards**: the borrow is scoped by a non-escaping closure
(shape 4):

```rust
n := m.with_lock(v => (v + i32(1)));              // Mutex(T)
xs.with(usize(0), mut(e) => { e.hits = (e.hits + i32(1)); });   // element (V2b)
```

- `with_lock`'s body parameter is `imm(body) : Fn(mut(v) : T) -> R` — the
  `mut(v)` lend is exactly the `&mut` the guard held, with the scope checked
  structurally (the closure cannot escape, D38 A).
- An `Impl(Fn)` body is monomorphized and inlines; the zero-cost property
  Rust gets from stack guards, Yo gets from inlining the closure.
- std's own RAII guards (`__MutexUnlocker`, `__RwLock*Unlocker`,
  `__BorrowGuard`) hold a raw pointer into a `Box`ed move-only state and exist
  only in `pragma(Pragma.AllowUnsafe)` std files (§3.4). A library that truly
  needs guard values (an FFI lock, a scoped queue) uses the same pattern —
  see §11.

### 3.3 Split borrows — `split_at_mut`, two `&mut` fields at once

```rust
// Rust
let (a, b) = buf.split_at_mut(mid);
```

- **Distinct fields are free** (D18): `mut(a) := s.left; mut(b) := s.right;`
  is accepted — siblings never conflicted.
- **A container splits by index ranges** (shape 3/5): walk `[0, mid)` and
  `[mid, len)` as two cursor loops over `xs(i)` places, or over
  `xs.indices()` (V2b, D39). Each side's exclusivity is the place system's.
- To swap two elements, `xs.swap(i, j)` (D20) needs no second borrow.

### 3.4 Two-phase loans — `fn begin<'a>(&'a mut self) -> Loan<'a>`

A value that holds a borrow of its argument for later use (a builder that
borrows a sink, a transaction that borrows a store) cannot exist. Restructure:

- **immediate scope** (shape 4): `begin`/`commit` collapse into one call that
  takes `mut(x)` and the closure or body;
- or the loaned state moves in (shape 1): the builder owns its sink and is
  consumed by `finish`;
- or the loan becomes a handle (shape 2): `Rc(Store)`, with §3.10's assert in
  place of the exclusivity Rust proved.

## 4. Shared graphs and caches

### 4.1 Parent pointers and graphs — `Rc<RefCell<Node>>` + `Weak<Node>`

```rust
// Rust
struct Node {
    children: Vec<Rc<RefCell<Node>>>,
    parent: Option<Weak<Node>>,          // Weak breaks the cycle
}
```

Yo has **no `Weak`** — the cycle collector is the `Weak`. Children and parents
are plain handles (shape 2):

```rust
Node :: struct(
  value : i32,
  children : ArrayList(Rc(Node)),
  parent : Option(Rc(Node))
);
```

- The parent cycle is reclaimed by the thread-local trial-deletion collector
  (`docs/en-US/CYCLE_COLLECTION.md`); only cells whose payload can reach an
  `Rc` are tracked, and this graph qualifies by construction.
- **Writes through any handle are plain writes** with the cell's borrow marks
  asserted at the write site (§3.10, D4): `node.value = 5` on an
  `Rc(Node)`-typed place is legal and panics if a conflicting borrow is live.
  This is `RefCell::borrow_mut`'s panic with no annotation — the run-time
  rule `RefCell` encodes, moved to the write.
- An `Arc` graph is rejected: `arc` requires `T <: Acyclic`, because an atomic
  cycle is never collected. Cross-thread graphs use arena + ids (below) or
  `Arc(Mutex(...))` nodes without parent handles.
- **The alternative is the arena** (shape 3), and it is what big Rust systems
  do too (rustc's interners, ECS storages, Cranelift's arenas):

```rust
Forest :: struct(nodes : ArrayList(Node));          // the one owner
Node :: struct(value : i32, children : ArrayList(usize), parent : Option(usize));
```

  `usize` children are `Copy`, never touch the collector and never pay a
  count; and an index survives its owner's buffer reallocation (a growing
  `ArrayList` does move the nodes) because it is re-derived through the owner
  at each use, not held as an address. Choose the arena
  when the graph is a closed world built in phases; choose `Rc` when nodes
  escape, are shared with callbacks, or the graph is open.

### 4.2 Interior mutability — `RefCell<T>`, `Cell<T>`

- **`Cell<T>` disappears.** Its whole job — mutate a field through a shared
  reference — is either unnecessary (you own the value: mutate the field) or
  is the `Rc` write of §4.1. There is no `Cell` in the language and no hole it
  leaves.
- **`RefCell<T>` is `Rc(T)`.** `Rc<RefCell<T>>` (Rust) becomes `Rc(T)` (Yo):
  the cell header carries the shared and exclusive borrow marks, every write
  through the cell asserts no conflicting mark, and `imm` lends through the
  handle mark the cell for the call (D28). The failure mode is the same class
  as Rust's (`RefCell` panic), checked at the same place (the mutation), with
  no spelling at the type.
- Cross-thread: `Arc<Mutex<T>>` → `Arc(Mutex(T))`; `Arc<RwLock<T>>` →
  `Arc(RwLock(T))` (both need `T <: (Send, Sync, Acyclic)`).
- A `OnceCell`/lazy shape: initialize eagerly, or hold
  `Mutex(Option(T))` / `RwLock(Option(T))` and `take`/`swap` it (D19's
  non-copying access). Per-thread state is `thread_local`.

### 4.3 Interners and hot-entry caches — `Vec<&'a V>` beside the owner

```rust
// Rust
struct Interner { map: HashMap<String, usize>, strings: Vec<String> }
impl Interner { fn get(&self, id: usize) -> &str { &self.strings[id] } }
```

The `&str` return is the only part that does not translate — and the id
already is the answer (shape 3). rustc's own interner works this way;

```rust
Interner :: struct(map : HashMap(String, usize), strings : ArrayList(String));

intern :: (fn(mut(self) : Interner, s : String) -> usize)(...);
// the text is re-derived (shape 5), never stored:
imm(text) := it.strings(id);       // a local borrow of the interner
it.strings(id).clone();            // or own a copy
```

A hot list of borrowed entries (`Vec<&'a V>`) becomes `ArrayList(usize)` of
ids/keys, or `ArrayList(Rc(V))` when the entries are themselves shared.

### 4.4 `Cow<'a, str>` — borrowed-or-owned

Post-VBD Yo has no copy-on-write (§0.1 of the plan dropped it); an explicit
enum is the shape:

```rust
StrArg :: enum(Borrowed(str), Owned(String));
```

The `Borrowed` arm is sound only because a safe `str` cannot alias a mutable
buffer (2.2). Most former-`Cow` call sites simply own the value: a copy is
already explicit everywhere, so `Owned` alone is usually the honest type. For
real structural sharing (snapshots, undo stacks), the persistent structures
are the `std/imm` family — which leaves std as its own package at V5.

## 5. Iteration

### 5.1 Borrowing iterators — `iter()`, `impl Iterator<Item = &T>`, adapter chains

Decision 39 (amended) settles the whole area:

| Rust | Post-V2b Yo |
| --- | --- |
| `for x in &xs` (a read-only walk) | the **borrowed `for`**: `for(xs, mut(x) => …)` — the container place is pinned, each element re-derived per step, no iterator value exists |
| `xs.iter().map(...).filter(...)` (a lazy chain over a borrowed container) | **not expressible**: write the loop, compose `xs.indices()` with non-escaping closures (`xs.indices().map(i => xs(i).len())`), or `xs.clone().into_iter()` when the chain must own its source — an explicit copy |
| `for x in xs` (by value) | `xs.into_iter()` — consumes; `Copy` elements are copies |
| `xs.iter()` where `xs : Rc<C>` | `xs.iter()` — iterating a shared container through a first-class handle is allowed (D38 D's per-call marks) |
| a stored read-only iterator (`it := xs.iter(); … it.next()`) | not expressible in safe code (a stored borrow); the cursor is `xs.indices()` — a `Copy` `Range(usize)` — with `xs(i)` re-derived by the user |
| `ptr()`-style raw iteration | only beside `ptr()`, in `pragma(Pragma.AllowUnsafe)` std files |

- **Growth mid-walk is an out-of-bounds error**, not UB (the borrowed `for`
  and `indices()` re-derive; D39's test requirement).
- **Cost:** one bounds check per re-derivation. Hot loops that need raw
  pointers use `ptr()` under the pragma (§11) — the same decision Rust makes
  when its iterators fail to elide.

### 5.2 `iter_mut` — mutable iteration

The borrowed `for` with a `mut` binding **is** `iter_mut`:
`for(xs, mut(x) => { x = (x + i32(1)); })` — each element is an exclusive place
into the container's storage, in-place, no copy (the pinned borrow flag makes
invalidation a run-time panic). A stored `iter_mut` cursor is a `Range(usize)`
plus `xs(i) = v` place writes, or `xs.with(i, body)` for one element.

## 6. Returning a borrow

```rust
// Rust
fn find(&self, k: Key) -> &Val;
fn longest(w: &[String]) -> &String;
fn parts(&mut self) -> (&mut A, &mut B);
```

Nothing can return a borrow (a projection result `-> mut(T)` exists only in
expression position and "may not be bound, stored, captured or returned",
D24). Pick by what the caller needs:

| The caller needs | Return | Read/use |
| --- | --- | --- |
| to read one field now | the call itself borrows: `imm(v) := xs(i)` — a local borrow (V2b places), or `xs(i).field` in place | free |
| to mutate one entry | a non-escaping closure: `xs.with(i, mut(v) => …)` (D20, V2b) | free (inlines) |
| the value out | a copy: `get_cloned(i)` for `Copy` payloads, `.clone()` otherwise; or ownership: `take(i)`, `pop`, `remove` (D20) | the copy |
| to hold it beside others | a handle: store `Rc(V)` values and return `Rc.clone(v)` | count bump |
| to find it again later | the key/index: `Option(usize)` / the key (shape 3) | a lookup |

`longest` returns the index (`Option(usize)`), and `parts` returns a tuple of
two of the above (two indices are the common case).

## 7. Closures and async

### 7.1 Escaping closures that capture `&`/`&mut`

```rust
// Rust
let logger = move || sink.write(&buffer);   // buffer borrowed/moved along
register(logger);                            // stored, escapes
```

A **borrow capture is second-class** (D35, D38 A): the closure cannot be
stored, returned or spawned. Escaping closures own or share:

```rust
// owns (shape 1): moves at last use, or clones
{ s2 : sink.clone() }() => s2.write(...);
// shares (shape 2): a handle moves in; the outer keeps using its own handle
{ s }() => s.write(...);                     // s : Rc(Sink) moves in
{ s2 : Rc.clone(s) }() => s2.write(...);     // if s is used afterwards
```

Non-escaping callbacks borrow freely, including `mut` captures, with no
allocation:

```rust
n := i32(0);
xs.for_each({ mut(n) }(x : i32) => { n = (n + x); });   // no Rc counter needed
```

### 7.2 Listener/observer registries — `Vec<Box<dyn Fn(&Event) + 'a>>`

```rust
// Rust
struct Bus { listeners: Vec<Box<dyn Fn(&Event) + 'a>> }   // borrow outlives register
```

The `+ 'a` is what Yo refuses: a stored callback cannot borrow the emitter.
The registry holds **owned or shared first-class values**:

```rust
Bus :: struct(listeners : ArrayList(Dyn(Fn(Event))));     // owned, move-only
Bus :: struct(listeners : ArrayList(Rc(Dyn(Fn(Event))))); // shared with several buses
```

- A listener that mutates shared state holds an `Rc(S)` capture (D37's counter
  forms); the emitter it observes is reached the same way — neither borrows
  the other.
- One-shot callbacks that consume their captures are `FnOnce`
  (`Thread.spawn`'s `Impl(FnOnce(...), Send)` by value, D37).

### 7.3 Async tasks borrowing state

§3.13 A2: a future that borrows is **second-class** — legal as the direct
operand of `io.await` or of a future-taking combinator, and (transitively)
returned only when every borrowed place is rooted at the returning function's
own `imm`/`mut` parameters. It cannot be spawned, stored or bound.

```rust
// rejected: an exclusive lend through a shared handle across a suspension
shared.next(io)                    // shared : Rc(Stream)
// the error names the fixes:
f(imm(shared), io)                 // pass the handle; re-derive shared.*.next at each use
// or move the stream into the task and own it there,
// or share the mutable state as Arc(Mutex(S))
```

A result several tasks need is awaited once and shared as `Rc(T)`, or moved
through a channel.

## 8. Trait objects — `&dyn Trait`, `Box<dyn Trait>`

| Rust | Yo |
| --- | --- |
| `fn f(x: &dyn Trait)` | `f(imm(x) : Dyn(Trait))` — the borrow is the parameter mode |
| `Box<dyn Trait>` (unique) | `Dyn(Trait)` — uniquely owned, uncounted cell (D7); `dyn(v)` moves in |
| `Rc<dyn Trait>` | `Rc(Dyn(Trait))` |
| `Arc<dyn Trait + Send + Sync>` | `Arc(Dyn(Trait, Send))` (`dyn(v)` into it checks `Send`) |
| a stored `&dyn` field | not expressible — one of the rows above |

A `Dyn` copies explicitly through its `clone` vtable slot when the trait or
payload provides one, and is move-only otherwise.

## 9. Collections of borrows

| Rust | Post-VBD Yo |
| --- | --- |
| `Vec<&str>` of literals/statics | `ArrayList(str)` — legal, `str` is `Copy` for literal-derived views |
| `Vec<&str>` of sub-strings of an owned buffer | `ArrayList(Range(usize))` + re-derivation (2.2), or clones |
| `Vec<&T>` beside the owner | `ArrayList(Rc(T))` handles, `ArrayList(usize)` indices, or the values themselves |
| `HashMap<&K, V>` | own the keys; or `HashMap(Rc(K), V)` if the key is shared |

## 10. Globals — `&'static`

A module-level value has no cell, and a borrow of one is restricted (D18
rule 3: its live range may contain no call or `await`) and can never be
stored. So a Rust registry of `&'static` references becomes:

- **name the global at each use** — a module-level value needs no reference to
  be reached, just its name;
- or share real handles: a module-level `Rc(Registry)` whose consumers store
  `Rc.clone(reg)` (module-level roots and `Rc` cells are different mechanisms;
  only the latter can be held in a value);
- thread-local mutable global state is `thread_local`.

## 11. The escape hatch — when the shapes are not enough

`pragma(Pragma.AllowUnsafe)` files may use `addr_of(x)`, raw pointers `*(T)`,
and the `__yo_cell`/`__yo_atomic_cell` primitives (D6). This is where std
itself writes the patterns safe code cannot:

- RAII guards holding `*(State)` into a `Box`ed move-only resource (§3.4);
- pointer-yielding iterators beside `ptr()` (D39);
- FFI objects and C callbacks that must hold C pointers.

The rules that keep it honest: a raw pointer is neither `Send` nor `Sync`
unless its type opts in (D38 E); the address contract is D40's (a cell or
buffer's address is good until its free; an inline value's until it is moved
or dropped); and the allocator-scope rules of
[`EXPLICIT_ALLOCATORS.md`](../reference/EXPLICIT_ALLOCATORS.md) apply. Porting
advice: exhaust §1–§10 first; reach for a pointer when a measurement names
the spot (the `for` bounds check, one `Rc` in a hot loop), not before.

## 12. Performance — where this matches Rust, and where it pays

**Parity is the default.** Post-VBD Yo's ownership model *is* Rust's for
everything unshared: one owner per buffer, in-place mutation with no
uniqueness test (§0.1), implicit moves at last use, `Clone` elision for dead
`.clone()`s (D27) — the same machine code clang or LLVM emits for the
analogous Rust. Function-level borrows lower to `const T*`/`T*` and are
checked statically; small `Copy` types pass by value in registers (D34's
register-pair argument); `Rc`-tree code costs what Rust's `Rc`-tree code
costs (rustc itself runs on `Rc`); the single-threaded async runtime avoids
cross-thread synchronization by construction.

**The tax is narrow, and it is exactly where Rust would also pay:**

| Pattern | Rust | Post-VBD Yo | Delta |
| --- | --- | --- | --- |
| stored `&`/`&mut` in a scoped struct | free (borrow checker) | `Rc`: one alloc + count traffic + write assert | **the structural gap** — appears where Rust had a lifetime-parameterized struct |
| interior mutability | `RefCell` (run-time flag) or `UnsafeCell` | `Rc` borrow marks at the write | same class of check, similar cost |
| shared mutation across threads | `Arc<Mutex<T>>` | `Arc(Mutex(T))` | none — identical |
| iterator chains | zero-cost (pointer iterators, elided checks) | one bounds check per re-derived step; `ptr()` under the pragma for hot loops | measurable in tight loops; escape hatch exists |
| cyclic graphs | `Weak` bookkeeping or an arena | collector traversal (tracked cells only), or the arena (nothing) | arena = Rust arena |
| indices vs pointers | a choice | often forced | frequently a *win*: 4-byte `Copy` ids, cache-friendly, no dereference chain — the reason rustc, ECS and Cranelift already use indices |

The honest statement: **Yo can match Rust wherever the Rust program's
aliasing is call-scoped or already `Rc`/`Arc`/index-shaped — which is most
systems code — and pays a counted, visible tax exactly where a Rust program
stored a borrow in a long-lived structure.** That tax is a design decision,
not an accident: sharing is visible in the type (§0.1), so the cost of
sharing is visible in the profile, and §11's escape hatch covers the measured
exceptions. What Yo gives up outright: lifetime-polymorphic APIs (a function
returning `impl Iterator<Item = &T> + 'a`), guard-returning lock APIs in safe
code, and self-referential types — each has a replacement above, and none is
zero-cost in Yo the way its Rust form is.

---

## Maintenance

Parked in `backlog/` because it is a reference catalog, not an implementation
plan. It still moves in lockstep with the plan's phases: when V1 step 2, V2b,
V2c or V5 land, drop the corresponding "(V2b)"-style markers here; at V5,
graduate it into the user-facing `docs/en-US/` + `docs/zh-CN/` porting guide
and archive this file.
