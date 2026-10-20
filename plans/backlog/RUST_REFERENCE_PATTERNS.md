# Rust reference-in-structure patterns in post-VBD Yo

**Status: BACKLOG** — a reference catalog, not an implementation plan,
companion to [`VALUES_BY_DEFAULT.md`](../VALUES_BY_DEFAULT.md). It answers
one question: **Rust stores borrows in data structures**
(`struct S<'a> { r: &'a T }`) **and Yo's references carry declared
origins instead of region lifetimes — what is each shape's spelling, and
what does it cost?**

It describes the model **at V5 with decisions 41–43 landed**: every
declared type a value, sharing spelled `Rc`/`Arc`, the dynamic exclusivity
check spelled `RefCell(T)`, references as first-class `&(T, p)` types
parameterized by origins ([`NON_ESCAPABLE_TYPES.md`](NON_ESCAPABLE_TYPES.md),
O1–O10; rewritten to that design on 2026-10-20 — the R1–R7 rules it cited
before are the superseded `depends` design). Sections that depend on that design or on V2b say so. At V5
this document is the seed of the user-facing porting guide (`docs/en-US/`
+ `docs/zh-CN/`). Three shapes still have an open design question, each
filed with a recommendation and cited where it applies (a fourth, `Rc`'s
`get_mut`/`try_unwrap`/`make_mut`, was decided as Rust's on 2026-10-14:
`plans/VALUES_BY_DEFAULT.md` decision 46):
`issues/questions/hashmap-lookup-by-borrowed-key-form.md`,
`issues/questions/refcell-inside-a-plain-value.md`,
`issues/retired/borrowed-for-over-user-defined-collections.md`.

Decision numbers (`D18`, `D43`, …) refer to `VALUES_BY_DEFAULT.md` §4; bare
`§`-references (`§3.10`, `§3.13 A2`) are that plan's sections; `O1`–`O10`
are the design note's rules. Origin-spelled signatures abbreviate the
`generic(p : Origin)` clause that declares each origin, as the design
note does.

---

## 1. The rule, and the five replacement shapes

**A reference is a first-class type carrying an origin — a declared set
of places** (D43 as amended 2026-10-19; O1). `&(T, p)` and `&mut(T, p)`
stand anywhere their origin can follow: a parameter, a local, a result, a
field, an enum payload, a tuple or array component, `Option(&(T, p))`, a
container over a declared union (`ArrayList(&(T, (x, y)))`, O6), a `Box`,
a `RefCell`, a `Dyn(Trait, p)`. The positions that accept no origin are
the ones whose lifetime is unbounded — a spawned task, a `Send` value, an
`extern` signature, a module-level binding, an `Rc`/`Arc` payload — and
each says so with `where(T <: Escapable)` (O10, Rust's `T : 'static`). A
function's result names the origins it borrows (`-> View(u8, a)`), elided
to the union of its reference parameters (O2, O3). That is why no region
lifetimes exist: an origin after substitution is a ground set of caller
places, checked by intersection and subset, not solved.

A Rust struct that holds a reference therefore becomes one of five shapes,
in the order Yo prefers them; the first is now Rust's own, within one
frame:

| # | Shape | Costs | Use when |
| --- | --- | --- | --- |
| 1 | **Hold the reference** — the field is `&(T, p)`/`&mut(T, p)`, the struct carries `p` (O4) | nothing; the struct goes wherever `p`'s places are in scope and freezes them while it lives | a view, cursor, guard, entry or sink — Rust's own shape, `struct S<'a>` |
| 1b | **Own it** — the field holds the value `T` (a recursive child in `Box(T)`) | a move or `.clone()` at the boundary | this structure is the value's sole owner for its whole life |
| 2 | **Share it** — the field holds a handle: `Rc(T)` (one thread) or `Arc(T)` (across threads); `Rc(RefCell(T))` when the payload is mutated through the handle (decision 41) | one allocation, count traffic; marks and a write assert only inside a `RefCell` (§3.10) | aliasing is real and long-lived |
| 3 | **Index it** — the field holds an index/key into an owner living elsewhere (`usize`, an arena id, a map key) | a bounds/lookup step per access; the owner must outlive the index | graphs, caches, interners — often *faster* than a pointer (§12) |
| 4 | **Pass it, don't store it** — the function takes `x : &T` / `x : &mut T`, or a non-escaping closure (`body : Impl(FnMut(v : &mut T) -> R)`) | none (an `Impl(Fn)` body inlines) | the borrow's life is one call |
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

```yo
Lexer :: struct(pos : usize, len : usize);
derive(Lexer, Copy, Clone);

peek :: (fn(src : &ArrayList(u8), st : Lexer) -> Option(u8))(
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

`fn words(&self) -> Vec<&str>` has a direct spelling:
`words(self : &Doc) -> ArrayList(&(View(u8), self))`, a list whose
declared origin is `self` (O6; `View(u8)` is the L1 view into the
`String`'s bytes — `str` itself is the first-class static view, origin
`∅`, and never takes `&`). The list goes wherever `self`'s place is in
scope — a `Box`, a field, a `Dyn` — and `doc` is frozen while it lives.
For a list that must outlive the document or be shared through an `Rc`,
store **offsets** (shape 5) and re-derive:

```yo
Doc :: struct(text : String);
word_ranges :: (fn(self : &Doc) -> ArrayList(Range(usize)))(...); // Copy elements
// use — the view is re-derived at each step, never stored:
ranges := doc.word_ranges();
d := &doc;
for(ranges, r => {
  process(&d.text, r);
});
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

**Unexpressible and unnecessary** (D40, O5). Safe Yo cannot build a value
that references itself — a type may never name its own fields and a
binding's type never its own place (O1) — so the one hazard `Pin` polices
does not arise; heap storage (cells, buffers, state machines) never
relocates, and an async body borrows its own locals across an `await`
freely because its state machine is a heap cell from `io.async` on. The Rust pattern that *wants* a
self-view (a cursor into a own buffer) is shape 5: own `buf`, store
`Range(usize)`, re-derive.

### 2.4 Sub-slice arguments and parser remainders — `&xs[a..b]`, `fn parse(&str) -> (&str, T)`

```rust
// Rust
fn sum(xs: &[i32]) -> i32 { .. }
sum(&v[lo..hi]);                                   // a view, no copy
fn number(input: &str) -> IResult<&str, i32>;      // nom: the REMAINDER is a borrow
```

Yo has no slice type (`std/collections/array_list.yo`: "Yo has no slice
type, so each chunk is a freshly allocated `ArrayList(T)`"), and
`ArrayList.slice(start, end)` returns a **copy**. A window into a buffer
is passed as the pair "the whole buffer, lent, plus a `Copy` range" and
re-derived in the callee (shape 4 + shape 5):

```yo
sum :: (fn(xs : &ArrayList(i32), r : Range(usize)) -> i32)({
  acc := i32(0);
  for(r, i => {
    acc = (acc + xs(i));
  });
  acc
});
sum(&v, lo .. hi);
```

- A parser that returns "the rest of the input" returns the **offset**
  (`(usize, T)`, or a `Result((usize, T), E)`) and takes the whole input
  as `input : &String` plus the start position; the caller threads the
  offset. This is §2.1's cursor again, applied to the signature rather
  than to a struct.
- Error values that borrow the input (`enum Error<'a> { Unexpected(&'a str) }`)
  carry the offset or own a clone of the fragment; an error is a stored
  value and can never hold a borrow.
- A function that must **own** a sub-range (store it, return it as a
  value) calls `slice`, which is the explicit copy.

## 3. A borrow held across calls

### 3.1 The context struct — `struct Ctx<'a> { db: &'a Db }`

```rust
// Rust
struct Ctx<'a> { db: &'a mut Db, cfg: &'a Config }
fn work(ctx: &mut Ctx) { ctx.db.write(..) }
```

Two Yo shapes, picked by where the context lives:

```yo
// Shape 4: call-local — no Ctx type at all; the borrows are the signatures
work :: (fn(db : &mut Db, cfg : &Config) -> unit)(...);
work(&mut db, &cfg); // the sigils say what is lent (V3b)

// Shape 2: stored (a task, a spawn, a registry) — handles, not borrows
Ctx :: struct(db : Rc(Db), cfg : Rc(Config));
```

- The stored form is exactly what the compiler's ~60 context objects become at
  V5 (`Rc(struct(...))`, the plan's V5 list).
- Through a handle, `ctx.db.read(...)` auto-derefs (§3.3). A write through
  `Rc(Db)` compiles only where the summaries prove no borrow is live
  (§3.10 outcome (a)); a `Db` that is mutated through the handle in general
  is `Rc(RefCell(Db))` and writes `ctx.db.get_mut().write(...)` or
  `ctx.db.with_mut(d => d.write(...))` (decision 41). Sharing the `Db`
  across threads is `Arc(Db)` for reads (needs `Db <: (Send, Sync)`) or
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

Two Yo forms, the closure one preferred:

```yo
n := m.with_lock(v => (v.* + i32(1))); // Mutex(T): the borrow is the closure's scope
cell.with_mut(v => {
  v.* = (v.* + i32(1));
}); // RefCell(T) (D41)
g := m.lock(); // a guard VALUE: LockGuard(T, m) holds &mut(Mutex(T), m) (O3's return rule)
v := g.get_mut(); // the payload, a projection rooted at g
v.* = (v.* + i32(1)); // g dropped at scope end, which unlocks (Dispose is an access, D38 A)
```

- `with_lock`'s body is `Impl(FnMut(v : &mut T) -> R)`: the lend is exactly
  the `&mut` the guard held, scoped structurally, and an `Impl(Fn)` body
  inlines — the zero-cost property Rust gets from stack guards.
- A guard value is `LockGuard(T, p)`, a struct holding `&mut(Mutex(T), p)`
  with `get`/`get_mut` projections to the payload (there is no `Deref`, so
  `g.*` is not defined; `g.get_mut().*` is the payload): it freezes the
  mutex exclusively while it lives and goes wherever `p` is in scope —
  Rust's `MutexGuard<'a, T>` exactly, a drop that unlocks included. `RefCell` keeps the closure and
  projection forms only (`with_mut`, `get_mut() -> &mut T`), since its
  dynamic borrow is call-scoped (D41).
- std's own RAII guards over raw pointers (`__MutexUnlocker`,
  `__RwLock*Unlocker`, `__BorrowGuard`) exist only in
  `pragma(Pragma.AllowUnsafe)` std files (§3.4 of the plan); at N3 they
  become ordinary origin-carrying structs.

### 3.3 Split borrows — `split_at_mut`, two `&mut` fields at once

```rust
// Rust
let (a, b) = buf.split_at_mut(mid);
```

- **Distinct fields are free** (D18): `a := &mut s.left; b := &mut s.right;`
  is accepted — siblings never conflicted.
- **A container splits as in Rust** (O3 step 2):
  `split_at_mut(&mut xs, mid) -> (&mut(View(T), xs), &mut(View(T), xs))`
  lends `xs` once and returns two views; the checker compares loans to
  accesses, never two reference values, so both halves are usable at once
  and the disjointness is the callee's (`requires`, an `AllowUnsafe` std
  body — Rust's `unsafe` inside `split_at_mut`). Index ranges over
  `xs.indices()` (D39) remain the cursor form.
- To swap two elements, `xs.swap(i, j)` (D20) needs no second borrow.

### 3.4 Two-phase loans — `fn begin<'a>(&'a mut self) -> Loan<'a>`

A value that holds a borrow of its argument for later use (a builder that
borrows a sink, a transaction that borrows a store) cannot exist. Restructure:

- **immediate scope** (shape 4): `begin`/`commit` collapse into one call that
  takes `&mut x` and the closure or body;
- or the loaned state moves in (shape 1): the builder owns its sink and is
  consumed by `finish`;
- or the loan becomes a handle (shape 2): `Rc(RefCell(Store))`, with the
  cell's assert in place of the exclusivity Rust proved.

### 3.5 A sink held in a struct — `fmt::Formatter<'a>`, `Serializer<'a, W: Write>`

```rust
// Rust
impl fmt::Display for Point {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "({}, {})", self.x, self.y) }
}
struct Serializer<'a, W: Write> { out: &'a mut W, depth: usize }
```

`Formatter` is a struct wrapping `&mut dyn Write`, handed down a call
tree. Yo's `ToString` (`std/fmt/to_string.yo`) **returns the text**
instead: `to_string : (fn(self : &Self) -> String)`, so there is no
sink to borrow and the trait object is the returned `String`. A real
streaming serializer takes its sink per call (shape 4):

```yo
serialize :: (fn(self : &Doc, out : &mut StringBuilder, depth : usize) -> unit)(...);
```

and a serializer that must be a value (it is passed around, or it is a
`Dyn`) owns its sink (shape 1) and gives it back on `finish` —
`StringBuilder.to_string` already detaches the buffer that way.

### 3.6 Take-and-replace transitions, and optional fields in place

```rust
// Rust: the state-machine idiom, and the as_ref/as_mut idiom
self.state = match std::mem::replace(&mut self.state, State::Empty) { .. };
if let Some(conn) = &mut self.conn { conn.send(..) }
let n = self.name.as_deref().unwrap_or("?");
```

Decision 19 (no partial moves) and decision 26 (a `match` on a borrowed
scrutinee binds borrows) carry both idioms with no struct change:

```yo
self.state = match(take(&mut self.state), .Running(j) => step(j), .Empty => .Empty); // leaves Default
old := replace(&mut self.state, .Empty); // Rust's mem::replace
match(&mut self.conn, .Some(c) => c.send(msg), .None => ()); // `as_mut` + `if let`
n := match(&self.name, .Some(s) => s.clone(), .None => String.from("?")); // `as_deref().unwrap_or`: own it (see below)
```

- `take(&mut place)` needs `Default` on the field type, like `mem::take`;
  `replace` does not.
- `match(&x, …)` / `match(&mut x, …)` are decision 33's sigils on the
  scrutinee: the bindings are `&`/`&mut` places and `x` stays usable
  afterwards. A bare `match(self.conn, …)` would be a consuming match and
  is a partial move, which decision 19 rejects.
- `Option.as_ref() -> Option(&T)` and `as_mut() -> Option(&mut T)` are
  expressible since D43 (`Option(&T)` is an inline instantiation over a
  reference, returned with `self`'s origin under O3's return rule); whether std adds them
  beside the `match` is a std question, and the `match` form above needs
  neither. `as_deref().unwrap_or("?")` has no direct transliteration:
  `.Some(s)` binds `s : &String` and `"?"` is a `str`, and nothing coerces
  between them (D43), so the honest row is re-derive or clone, as shown.

### 3.7 Builders — `fn name(&mut self, ..) -> &mut Self`

```rust
// Rust: the mutable-chaining builder
let req = Request::builder().method("GET").header("a", "b").body(())?;
```

A method cannot return a borrow of its receiver (§6), so the **consuming
builder** is the shape: every step takes `self` by value and returns it,
the chain moves the value along, and `finish` consumes it. This is Rust's
other builder convention (`std::thread::Builder`, `Command` by `&mut`
aside) and it costs nothing — a move of a stack value is a register copy
under decision 30.

```yo
req := RequestBuilder.new().method("GET").header("a", "b").build();
method : (fn(self : Self, m : str) -> Self)({
  self.method = m;
  self
});
```

A builder that must be mutated in place across statements (`b.a(); if c { b.b(); }`)
is an ordinary `mut` local whose steps are `&mut self` methods returning
`unit`; the two conventions are the same ones Rust offers, minus the
reference-returning one.

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

```yo
Node :: struct(
  value : i32,
  children : ArrayList(Rc(RefCell(Node))),
  parent : Option(Rc(RefCell(Node)))
);
```

- The parent cycle is reclaimed by the thread-local trial-deletion collector
  (`docs/en-US/CYCLE_COLLECTION.md`); only cells whose payload reaches a
  `RefCell`/`Mutex`/`RwLock` that reaches an `Rc` are tracked (decision 41),
  and this graph qualifies by construction — a tree whose nodes are plain
  `Rc(Node)` does not, and is never tracked.
- **The graph is mutated through `RefCell`**, exactly as in Rust minus the
  guard value (decision 41): `node.get_mut().value = 5` (a projection, D24)
  or `node.with_mut(n => { n.value = 5; })`. A conflicting live borrow
  panics at `get_mut`/`with_mut` entry, `RefCell::borrow_mut`'s panic. A
  write through a plain `Rc(Node)` compiles only where the summaries prove
  no borrow is live (§3.10 outcome (a)) and is otherwise a compile error
  naming `RefCell(T)`.
- An `Arc` graph is rejected: `arc` requires `T <: Acyclic`, because an atomic
  cycle is never collected. Cross-thread graphs use arena + ids (below) or
  `Arc(Mutex(...))` nodes without parent handles.
- **The alternative is the arena** (shape 3), and it is what big Rust systems
  do too (rustc's interners, ECS storages, Cranelift's arenas):

```yo
Forest :: struct(nodes : ArrayList(Node)); // the one owner
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
  is a `RefCell(T)` over a `Copy` payload (`c.get_mut().* = v`). There is no
  `Cell` in the language and no hole it leaves.
- **`RefCell<T>` is `RefCell(T)`** (decision 41; `std/sync`, beside
  `Mutex(T)`). `Rc<RefCell<T>>` becomes `Rc(RefCell(T))`: the cell holds the
  shared and exclusive marks, `with(v => …)`/`with_mut(v => …)`
  scope a borrow in a closure, and `get()`/`get_mut()` are projections
  usable in one expression (`cell.get_mut().field = x`). What does not
  carry over is the guard value: `borrow_mut()` returning a `RefMut` is a
  stored borrow (D38 A). The failure mode is Rust's (`RefCell` panic at
  `with_mut`/`get_mut`). A plain `Rc(T)` is read-only through the handle
  except where §3.10's summaries prove a write exclusive, and its cell
  carries no marks at all.
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

`get(self : &Self, id : usize) -> View(u8, self)` translates directly
(the view's origin is the interner); the id is still the answer for
anything stored beyond the interner's frame (shape 3), as in rustc's own
interner:

```yo
Interner :: struct(map : HashMap(String, usize), strings : ArrayList(String));

intern :: (fn(self : &mut Interner, s : String) -> usize)(...);
// the text is re-derived (shape 5), never stored:
text := &it.strings(id); // a local borrow of the interner
it.strings(id).clone(); // or own a copy
```

A hot list of borrowed entries (`Vec<&'a V>`) is `ArrayList(&(V, owner))`
beside its owner (O6); beyond the owner's frame it is `ArrayList(usize)`
of ids/keys, or `ArrayList(Rc(V))` when the entries are themselves shared.

### 4.4 `Cow<'a, str>` — borrowed-or-owned

Post-VBD Yo has no copy-on-write (§0.1 of the plan dropped it); an explicit
enum is the shape:

```yo
StrArg :: enum(Borrowed(str), Owned(String));
```

The `Borrowed` arm is sound only because a safe `str` cannot alias a mutable
buffer (2.2). Most former-`Cow` call sites simply own the value: a copy is
already explicit everywhere, so `Owned` alone is usually the honest type. For
real structural sharing (snapshots, undo stacks) there is no persistent
collection in std: the `std/imm` family was deleted on 2026-10-09 (#1289,
the maintainer's decision, to be revisited later); until then snapshots
are explicit clones or `Rc` handles to immutable nodes.

### 4.5 The entry API — `HashMap::entry(k).or_insert_with(..)`, `get_or_insert_with() -> &mut V`

```rust
// Rust
*counts.entry(word).or_insert(0) += 1;
let v = cache.entry(k).or_insert_with(compute);   // &mut V into the map
```

`Entry<'a, K, V>` is a value holding a loan of the map, and since D43 that
is an ordinary origin-carrying struct: `Entry(K, V, p) :: struct(map : &mut(HashMap(K, V), p), key : K, hash : u64, slot : BucketProbe)`,
returned by `entry(self : &mut Self, k : K) -> Entry(K, V, self)` (O3's
return rule), with `or_insert(self, v) -> &mut(V, p)` carrying the
entry's origin out. The Rust lines read the same:

```yo
c := counts.entry(word).or_insert(i32(0)); // c : &mut i32, one lend of counts
c.* = (c.* + i32(1));
counts.update_with(word, n => (n + i32(1))); // the closure form, shorter
cache.entry(k).or_insert_with(() => compute(k));
```

The closure-taking methods std already has (`get_or_insert_with`,
`update_with`) stay as the short spellings. Lands with the design note's
phase N3.

### 4.6 Two kinds of "arena" — index arenas (§4.1) versus `bumpalo`/`typed_arena` returning `&'a T`

```rust
// Rust
let arena = Bump::new();
let n: &Node = arena.alloc(Node { .. });   // a borrow with the arena's lifetime
```

§4.1's arena is a `ArrayList(Node)` with `usize` edges: the index IS the
reference. Rust's *bump* arena is a different thing — a placement
decision — and in Yo it is the explicit allocator of
[`EXPLICIT_ALLOCATORS.md`](../reference/EXPLICIT_ALLOCATORS.md) and
VALUES_BY_DEFAULT §3.11:

```yo
a := Arena.new();
with_allocator(a.allocator(), () => {
  xs := ArrayList(Node).new(); // its buffer, and every cell it creates, lives in `a`
  ...
  });
a.deinit(); // panics while any block is live
```

- The value built in the arena is an **ordinary value** (`xs`, `Rc(Node)`,
  a `String`); nothing in its type says where it lives, so no lifetime
  parameter appears on anything that holds it. Ownership still decides when
  it dies; the arena decides where.
- Moving a value out is an explicit `clone_in(alloc)` (lands with V2b's
  `alloc` parameter); a plain `clone()` lands where its source lives
  (decision 12).
- A plain struct, enum, tuple or array allocates nothing, so a bump arena
  changes only where cells and buffers go — the same thing `Bump` changes.

## 5. Iteration

### 5.1 Borrowing iterators — `iter()`, `impl Iterator<Item = &T>`, adapter chains

| Rust | Post-V2b Yo (with the design note's N3) |
| --- | --- |
| `for x in &xs` (a read-only walk) | `for(&xs, x => …)` — the sigil on the source; dispatches through `impl(&ArrayList(T), IntoIterator(…))`; each `x` is a `&T` |
| `for x in &mut xs` | `for(&mut xs, x => …)` — each `x` is a `&mut T`, written in place through `x.*` or its fields |
| `for x in xs` (by value) | `for(xs, x => …)` — consumes `xs` (D42); `Copy` elements copy |
| `xs.iter().map(...).filter(...)` (a lazy chain over a borrowed container) | `xs.iter().map(…).filter(…)` — `iter(self : &Self) -> Cursor(T, self)` holds `&(ArrayList(T), p)`, `next(self : &mut(Cursor(T, p))) -> Option(&(T, p))`, and each adapter is an inline struct carrying `p`; the chain goes wherever `xs`'s place is in scope (a `Box`, a `Dyn(Iterator(…), p)`), never into an `Rc` |
| `xs.iter()` where `xs : Rc<C>` | `h.*.items.iter()` — the cursor's origin is the handle `h`, frozen for the cursor's life (O9); the borrowed `for` keeps its pin until decision 39 is revisited |
| a stored read-only iterator (`it := xs.iter(); … it.next()`) | legal as a local or a field; `ArrayList(Cursor(T, p))` declares `p`; `Rc(Cursor(T, p))` is E0909 (`Escapable`) |
| `ptr()`-style raw iteration | only beside `ptr()`, in `pragma(Pragma.AllowUnsafe)` std files |

- **Growth mid-walk**: with a value-rooted `xs`, `xs.push(..)` inside the
  walk is E0911 (the cursor holds `&xs`); with an `Rc`-rooted one, the pin
  panics (D39's test requirement).
- **Cost:** a bounds check per `next` where the verifier cannot elide it;
  `indices()` (a `Copy` `Range(usize)`) remains for cursor walks that must
  survive a mutation of the container.

### 5.2 `iter_mut` — mutable iteration

`for(&mut xs, x => { x.* = (x.* + i32(1)); })`: each `x` is a `&mut T` into
the container's storage, in place, no copy; `xs.iter_mut()` is the cursor
form with `next(self : &mut(Cursor(T, p))) -> Option(&mut(T, p))`, and
its items may be held together — `xs.iter_mut().collect()` is
`ArrayList(&mut(T, xs))`, Rust's `Vec<&mut T>` — because the checker
compares loans to accesses, never two reference values (O3 step 2); the
items' disjointness is the cursor's obligation. A `&mut T` reached
through a `&` path is read-only (D43), so a shared view of a container
never hands out mutable elements.

### 5.3 `impl IntoIterator for &MyCollection`, `LendingIterator`

Rust's shape, exactly: `impl(&MyColl, IntoIterator(Item := &T, …))` and
`impl(&mut MyColl, IntoIterator(…))` make `for(&c, …)` work on a user
container, and the iterator they return carries `c`'s place as its
origin (O3). A `LendingIterator` (Rust's GAT `type Item<'a>`) needs no
GAT in Yo: the elided `next(self : &mut Self) -> Option(&T)` IS the
lending reading (the item's origin is `self`, O2). Position recorded in
`issues/retired/borrowed-for-over-user-defined-collections.md`.

## 6. Returning a borrow

```rust
// Rust
fn find(&self, k: Key) -> &Val;
fn longest(w: &[String]) -> &String;
fn parts(&mut self) -> (&mut A, &mut B);
fn name(&mut self, s: &str) -> &mut Self;
```

A function may return a reference, or anything holding one, when every
origin in its result names an origin parameter or a reference-typed
parameter's place — elided, the union of its reference parameters;
spelled, exactly the one it borrows (O3's return rule). So:

| Rust | Yo |
| --- | --- |
| `fn find(&self, k) -> &Val` | `find(self : &Self, k : Key) -> &Val` — a projection (D24), bindable since D43 |
| `fn longest(a: &[u8], b: &[u8]) -> &[u8]` | `longest(a : &ArrayList(u8), b : &ArrayList(u8)) -> View(u8)` — elided, borrows both; `longest(generic(q : Origin), a : &(ArrayList(u8), q), b : &ArrayList(u8)) -> View(u8, q)` borrows `a` only |
| `fn parts(&mut self) -> (&mut A, &mut B)` | `parts(self : &mut Self) -> (&mut A, &mut B)` — two distinct fields (D18) |
| `fn get_mut(&mut self, i) -> &mut T` | `get_mut(self : &mut Self, i : usize) -> &mut T` |
| the chaining builder `fn name(&mut self, ..) -> &mut Self` | `name(self : &mut Self, s : str) -> &mut Self` compiles under the return rule; the consuming builder (§3.7) stays the idiom when the value is being assembled |
| `fn parts(&mut self) -> (&mut A, &mut B)` from one container (`split_at_mut`) | two `&mut(View(T), xs)` out of one lend — loans are compared to accesses, never to each other (O3 step 2); the callee owns the disjointness |
| a reference into a **local** or a temporary | a compile error at the `return` naming the place — the one thing Rust also refuses (`let r = &make();` extension to the block is an open position, design note §7) |
| a value out instead | `get(i)` for `Copy` payloads, `get_cloned(i)` otherwise; `take(i)`, `pop`, `remove` for ownership |
| a reference to hold beside others, long-lived | `Rc(V)` values and `Rc.clone(v)`; or the key/index (shape 3) |

`Rc::get_mut`/`try_unwrap`/`make_mut` out of a handle are Rust's, with
`Arc` mirrors (`plans/VALUES_BY_DEFAULT.md` decision 46, 2026-10-14).

## 7. Closures and async

### 7.1 Escaping closures that capture `&`/`&mut`

```rust
// Rust
let logger = move || sink.write(&buffer);   // buffer borrowed/moved along
register(logger);                            // stored, escapes
```

A closure's capture list spells its borrows' origins like fields (O7), so a
borrowing closure is a value that goes wherever those places are in scope —
returned, stored in a struct or a `Dyn(Fn(...), p)` — and is rejected only
where no origin can follow: a spawn, a `Send` slot, an `Rc`. A closure
that must outlive what it reads still owns or shares:

```yo
// owns (shape 1): moves at last use, or clones
{ s2 : sink.clone() }() => s2.write(...);
// shares (shape 2): a handle moves in; the outer keeps using its own handle
{ s }() => s.write(...); // s : Rc(Sink) moves in
{ s2 : Rc.clone(s) }() => s2.write(...); // if s is used afterwards
```

Non-escaping callbacks borrow freely, including `mut` captures, with no
allocation (such a closure is a `FnMut`, D37, and the slot that calls it
says `Impl(FnMut(…))`):

```yo
n := i32(0);
xs.for_each({ n : &mut n }(x : i32) => {
  n.* = (n.* + x);
}); // a FnMut; `.*` because operators never auto-deref (D43)
```

### 7.2 Listener/observer registries — `Vec<Box<dyn Fn(&Event) + 'a>>`

```rust
// Rust
struct Bus { listeners: Vec<Box<dyn Fn(&Event) + 'a>> }   // borrow outlives register
```

The `+ 'a` is `Dyn(Fn(Event), p)` (O4): a registry whose listeners borrow
places in scope at the registry's frame carries `p` and freezes them.
A registry that outlives its listeners' sources, or is shared through an
`Rc`, holds **owned or shared values**:

```yo ignore
Bus :: (fn(comptime(p : Origin) -> comptime(Type))(struct(listeners : ArrayList(Dyn(Fn(Event), p))))); // borrowing listeners, within p
Bus :: struct(listeners : ArrayList(Dyn(Fn(Event)))); // owned, move-only (Escapable payloads)
Bus :: struct(listeners : ArrayList(Rc(Dyn(Fn(Event))))); // shared with several buses
```

- A listener that mutates shared state holds an `Rc(S)` capture (D37's counter
  forms); the emitter it observes is reached the same way — neither borrows
  the other.
- One-shot callbacks that consume their captures are `FnOnce`
  (`Thread.spawn`'s `Impl(FnOnce(...), Send)` by value, D37).
- **Re-entry** — a listener that mutates the bus that is dispatching to it
  (`self.listeners.push(..)` from inside `emit`). Rust rejects it at
  compile time through the `&mut self` borrow. Yo rejects the borrowing
  form statically too (D38 B: a closure holding a `mut` borrow cannot be
  reached by anything it is called with), and through an `Rc(RefCell(Bus))`
  it is the cell's assert: a panic at the `with_mut`, the `RefCell` failure
  mode (decision 41). The ported code that first trips the assert is
  usually this shape; the fix is to collect the mutations and apply them
  after `emit` returns.

### 7.3 Async tasks borrowing state

§3.13 A2, stated in the type at N3: a future that borrows is
`Future(T, p)` with `p` the places its body captures from the caller. It
may be awaited, combined, returned (ordinary substitution — forwarding
works), bound and stored wherever `p` follows; it cannot be spawned
(`Escapable`). Its body borrows its own locals across an `await` freely
(O5). Today it is second-class (not bindable or storable); that narrows
to the spawn rule at N3.

```yo ignore
// rejected: an exclusive lend through a shared handle across a suspension (E0919, decision 46)
shared.next(io)                    // shared : Rc(Stream)
// a shared (&) borrow through the handle is fine and carries the handle's place (O9):
peek(&shared.*.head, io)           // Future(T, shared)
// for the exclusive case: move the stream into the task and own it there,
// or share the mutable state as Arc(Mutex(S))
```

A result several tasks need is awaited once and shared as `Rc(T)`, or moved
through a channel.

### 7.4 Scoped threads and data parallelism — `thread::scope`, rayon's `par_iter`

```rust
// Rust: lend STACK data to worker threads, joined before the scope ends
let (left, right) = data.split_at(mid);
thread::scope(|s| { s.spawn(|| sum(left)); s.spawn(|| sum(right)); });
let total: i64 = data.par_iter().map(|x| cost(x)).sum();   // rayon borrows `data`
```

This is the one Rust borrow shape with **no Yo counterpart at all**: a
borrow is never `Send` (D38 E, `PARALLELISM_RULES.md` D10 — "a closure
that borrows its captures is never `Send`"), a borrowing closure cannot be
spawned (D38 A), and `std/thread.yo` has no scoped spawn
(`Thread.spawn` takes `Impl(FnOnce(io : Io) -> T, Send)` by value). The
shapes that exist:

```yo
// shape 2: Sync-bounded read sharing — Arc(ArrayList(T)) needs T <: (Send, Sync, Acyclic)
shared := arc(data); // one move in; data is not used afterwards
l := Thread.spawn({ d : Arc.clone(shared) }(io : Io) => sum_range(&d, 0 .. mid));
r := Thread.spawn({ d : shared }(io : Io) => sum_range(&d, mid .. n));
total := (l.join() + r.join());

// shape 1: owned chunks moved in, results joined — rayon's `into_par_iter`
chunks := data.into_chunks(k); // each chunk an owned ArrayList(T)
handles := chunks.into_iter().map(c => Thread.spawn({ c }(io : Io) => reduce(c))).collect();
```

- `Arc(Mutex(S))` for a shared accumulator; a channel for results.
- Moving a whole `Rc` graph to one other thread is `^v` (`Iso(T)`,
  `PARALLELISM_RULES.md` D2): the uniqueness check is deep and runs once,
  at the move — the thing Rust cannot do with `Rc` at all.
- **Not yet decided:** a `par_map`/`par_join` std layer is
  [`LANGUAGE_FEATURE_CANDIDATES.md`](LANGUAGE_FEATURE_CANDIDATES.md) §1,
  whose open question is exactly this section — whether `Arc` sharing plus
  owned chunks covers rayon's real workloads. A borrowing scoped spawn is
  decision 43's recorded trigger 2 (design note §3.1): a scope whose join
  is structural, tasks whose origins are within the scope's lent places,
  `Sync` for `&` — a parallelism-runtime design, parked on a counted need.

## 8. Trait objects — `&dyn Trait`, `Box<dyn Trait>`

| Rust | Yo |
| --- | --- |
| `fn f(x: &dyn Trait)` | `f(x : &Dyn(Trait))` — the borrowed trait object (D44): a fat reference carrying its origin, no allocation, made by `dyn(&v)` or by lending an owned `Dyn` |
| `Box<dyn Trait + 'a>`, `Box<dyn Iterator<Item = &T> + 'a>` | `Dyn(Trait, p)` — the payload's origins are within `p` (O4); `Dyn(Trait)` alone is `Dyn(Trait, ∅)`, an `Escapable` payload |
| `Box<dyn Trait>` (unique) | `Dyn(Trait)` — uniquely owned, uncounted cell (D7); `dyn(v)` moves in |
| `Rc<dyn Trait>` | `Rc(Dyn(Trait))` |
| `Arc<dyn Trait + Send + Sync>` | `Arc(Dyn(Trait, Send))` (`dyn(v)` into it checks `Send`) |
| a stored `&dyn` field | `t : &(Dyn(Trait), p)` — a field carrying `p` (O4); beyond `p`'s places `Rc(Dyn(Trait))` or `Impl(Trait)` |

A `Dyn` copies explicitly through its `clone` vtable slot when the trait or
payload provides one, and is move-only otherwise.

## 9. Collections of borrows

| Rust | Post-VBD Yo |
| --- | --- |
| `Vec<&str>` of literals/statics | `ArrayList(str)` — first-class; `str` is the `Copy` view of static bytes and never takes `&` (D43) |
| `Vec<&str>` of sub-strings of an owned buffer | `ArrayList(&(View(u8), s))` — declared origin `s` (O6); goes wherever `s` is in scope, freezes `s` |
| the same, kept beyond the string's life or shared through an `Rc` | `ArrayList(Range(usize))` + re-derivation (§2.2), or own the values |
| `Vec<&T>` beside the owner | `ArrayList(&(T, owner))`; several owners is a declared union `ArrayList(&(T, (x, y)))`, a push outside it a local error |
| `Vec<&mut T>` | `ArrayList(&mut(T, xs))`: legal, filled from one `&mut` cursor (O3 step 2); a second `&mut xs` by name while it lives is E0911 |
| `Vec<&T>` shared through an `Rc` | `ArrayList(Rc(T))` handles, `ArrayList(usize)` indices, or the values themselves — an `Rc` payload is `Escapable` (O9) |
| `HashMap<&K, V>` | `HashMap(&(K, p), V)` with `p` declared; own the keys, or `HashMap(Rc(K), V)`, beyond `p` |
| `map.get("literal")` on a `HashMap<String, V>` (`Borrow<Q>`) | **undecided** — `get` takes `key : &K`; a `str` lookup is `String.from(s)` per call today; `issues/questions/hashmap-lookup-by-borrowed-key-form.md` |

## 10. Globals — `&'static`

An unmarked module-level binding is never written after its initializer
(D47), so a borrow of it carries the empty origin — Rust's `&'static`,
storable anywhere (O1). A borrow of a `mut(G)` binding is restricted (D18
rule 3: its live range may contain no call or `await`) and a module-level
binding itself may hold only `Escapable` values. So a Rust registry of
`&'static` references becomes:

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
| stored `&`/`&mut` in a struct, with one root or several, in a `Box`/`RefCell`/`Dyn` | free (borrow checker, named lifetimes) | free: an origin-carrying struct of pointers (O4), origins erased in C | none |
| stored `&`/`&mut` inside an `Rc`/`Arc`, or lent across threads | free (`Rc<&'a T>`, `thread::scope`) | `Rc`/`Rc(RefCell)`: one alloc + count traffic + a write assert, or indices; `Arc` sharing or owned chunks across threads | **the residue** — §14 |
| interior mutability | `RefCell` (run-time flag) or `UnsafeCell` | `RefCell(T)` marks at `with_mut`/`get_mut` (decision 41); a plain `Rc(T)` carries no marks | identical |
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

## 13. What simply vanishes

Lifetime machinery that exists only because Rust borrows are types. None of
it has, or needs, a Yo spelling:

| Rust | Why it is gone |
| --- | --- |
| `impl<'a> Foo<'a>` as a separate spelling | an impl quantifies over every origin of its type; origins are erased from coherence and specialization identity (O1). `PhantomData<&'a T>` is a phantom origin parameter, which stays |
| `impl<T: Display> Display for &T` and the other blanket impls over `&T`/`&mut T` | a borrow has the lent type; `x : &T` dispatches on `T` |
| HRTB `for<'a> Fn(&'a T) -> &'a U` as a spelling | the elided parameter origin of a `Fn(...)` type is universally quantified per call (O2): `Fn(v : &T) -> &U` says it, nothing is written |
| variance | one rule: subset coercion in covariant positions, exact through a `&mut` pointee (O3-3) |
| `T: 'static` on `spawn`, `+ 'static` on `Box<dyn Error>` | not gone — it is `where(T <: Escapable)` (O10), carried by `spawn`, `Rc`, `Arc` and `Dyn(Trait)` themselves |
| `Deref` coercions (`&String → &str`, `&Vec<T> → &[T]`, `&Box<T> → &T`) | none (D43): a view is explicit (`View(u8)`, L1); `str` is the first-class static view; `.field` and `.method()` auto-deref through `&` and `Box`/`Rc` |
| `RefMut<'a, T>` / `Ref<'a, T>` guard values | §4.2: `with`/`with_mut` closures and `get`/`get_mut` projections (`MutexGuard` has a value form, §3.2) |
| `Pin<&mut Self>`, `Unpin` | §2.3 |
| `Cell<T>` | §4.2 (a `RefCell(T)` over a `Copy` payload) |
| `Weak<T>` | §4.1 |
| `Cow<'a, T>` | §4.4 |
| `as_deref` | no coercion from `&String` to `str`: re-derive or clone (§3.6); `as_ref`/`as_mut` are expressible (`Option(&T)`, D43) |

## 14. What Yo does not cover, and what each costs instead

The residue after decisions 41–43 and the design note's phases land,
re-audited 2026-10-20 against Rust (design note §3.1): three former rows —
multi-root borrows beyond a frame, references in cells and long-lived
structures, lifetime-polymorphic trait objects — are expressed now
(`&(T, (p, q))` unions, `Box`/`RefCell`/`Dyn(Trait, p)` payloads, O4), and
`Vec<&mut T>` out of `iter_mut` and `&*rc` joined them. The porting guide
at V5 states this list up front.

| Rust shape | Why Yo does not express it | What you write instead | What it costs |
| --- | --- | --- | --- |
| lending stack data to other threads — `thread::scope`, rayon `par_iter` over a local `Vec` | a reference is never `Send` (D38 E, O8); the fill is a scoped spawn whose join is structural (decision 43's trigger 2), a parallelism-runtime design parked on a counted need | `Arc(ArrayList(T))` read sharing, owned chunks moved in and joined, `^v` for a whole `Rc` graph (§7.4) | one `Arc` allocation and count traffic, or the chunking copy |
| a reference inside a counted cell — `Rc<&'a T>`, `Rc<Vec<&'a T>>` | an `Rc`/`Arc` payload is `Escapable` (O9): the cycle collector runs drops at an unbounded later time, after the places an inner reference names may have died; Rust escapes only because a leaked cycle never runs `Drop` | `Rc(T)` elements, ids, or own the values; a `Box` or `Dyn` payload may carry the origin instead | a count, a lookup, or a copy |
| a `&mut` through a shared handle held across an `await`, shared by several tasks | §3.13 A2 and decision 46: an exclusive lend through an `Rc`/`Arc` is E0919 | own the state in the task, `Arc(Mutex(S))`, or a channel | a lock, or a message |
| self-referential values and `Pin` — a parser holding `&self.buf`, an intrusive node pointing at its siblings | O5: a type may never name its own place or fields; heap storage never relocates so `Pin` has nothing to police — safe Rust cannot write these either | offsets into the owned buffer (§2.3), an arena of indices (§4.1), or `pragma(Pragma.AllowUnsafe)` (§11) | a bounds check, or unsafe |
| `let r = &make();` — a temporary extended to the block | rejected today as a borrow of a temporary; the fill is Rust's rule at decision 18's phase (design note §7) | bind the value first | one line |
| `unsafe` systems idioms as idioms — `UnsafeCell`, `MaybeUninit` arrays, `ptr::read`/`write`, `transmute`, `#[repr]` layouts | the pragma exists and std uses it, with no language vocabulary for layouts or uninitialized memory beyond `spare_capacity`/`assume_init` (ATS A4's init token is the planned safe form) | the pragma, raw pointers, `c_include` for C-side layout | the same risks as Rust's unsafe, with less tooling around them |
| zero-cost as a guarantee | the collector tracks `Rc` payloads reaching a `RefCell`/`Mutex`/`RwLock` (D41), safe mode traps on integer overflow at every `-O` (SAFE_MODE D1), `push` runs its contract as an assert until CP2g | `Acyclic` where the predicate is conservative, `wrapping_*` at a measured hot site, the CODEGEN_PERFORMANCE levers | measured in `CODEGEN_PERFORMANCE.md` §0.1: parity on float and index loops, 5–7× on trapping integer loops until CP2f, 1.9× on `push` until CP2g |
| the ecosystem — crates, registries, `serde`, `tokio`, `rayon`, `nom` | not a language gap | git dependencies in `yo.toml`, std's `json`/`toml`/`http`/`regex`, the async runtime, derive rules over AST reflection | writing it |

## Maintenance

Parked in `backlog/` because it is a reference catalog, not an implementation
plan. It still moves in lockstep with the plan's phases: when V1 step 2, V2b,
V2c or V5 land, drop the corresponding "(V2b)"-style markers here; at V5,
graduate it into the user-facing `docs/en-US/` + `docs/zh-CN/` porting guide
and archive this file.

**Deferred follow-up (recorded 2026-10-08): teach the five shapes in the
toolchain, not only here.** Once V2b/V5 make the spellings real, fold §1's
five shapes into the agent surface, so a model that "knows" the Rust pattern
meets its replacement in the cheatsheet, not in a backlog doc:

- `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md` first — it is
  the skills' patterns home, and "I want to store a borrow" is a pattern;
- the `yo-syntax` cheatsheet's ownership rows (which positions `&(T, p)`
  exists in, and which require `Escapable`);
- the `yo context` pack's ownership section;

following [`AGENT_KNOWLEDGE_CONSOLIDATION.md`](../AGENT_KNOWLEDGE_CONSOLIDATION.md)'s
one-home-per-fact rule — the skills carry the trigger and a pointer, this
catalog (then `docs/`) holds the detail. Held until V2b/V5 on purpose: a
cheatsheet that teaches spellings the current tree cannot compile sends
agents to copy examples that fail.
