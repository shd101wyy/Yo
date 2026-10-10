# Non-escapable types: borrow-mode fields with an inferred, single-root lifetime dependency

**Status: BACKLOG — design note, written 2026-10-10 at the maintainer's
request; not scheduled.** This is the design that two parked decisions in
[`VALUES_BY_DEFAULT.md`](../VALUES_BY_DEFAULT.md) point to without naming:
decision 39's "recorded for later, not adopted: borrow-mode struct fields"
and decision 37's parked stateful call, both "decided together, by the same
trigger". It generalizes one rule the plan already has — §3.13 A2, which
lets a *borrowing future* be returned when every place it borrows is
rooted at the returning function's own parameters — from futures to any
declared type. It adds no lifetime names. It fires only on the triggers
in §8.

**The position it records** (the maintainer's question of 2026-10-10,
"should Yo also have a borrow checker?"): Yo already has one — `imm`/`mut`
are modes, exclusivity is static for value-rooted places and spelled
`RefCell(T)` otherwise (decisions 18, 28, 33, 38, 41). What it lacks
relative to Rust is a borrow *as a type*. Mutable value semantics stays
the base; this note is the one bounded extension, the one Swift (non-
escapable types with lifetime dependencies, `Span`) and Mojo (`ref` with
origins) both added after starting where Yo is now, and it is taken in
Swift's shape, not Rust's.

## 0. The gap, in the tree's own words

- A borrow can never be a field type, an element type, a generic argument
  of a type constructor, a stored or returned value, or a `Dyn` payload
  (decision 38 A, "type positions"). Only two kinds of value hold a borrow
  today: a closure's capture record (decision 35) and a future's capture
  slots (§3.13).
- Consequences, each measured or catalogued in
  [`RUST_REFERENCE_PATTERNS.md`](RUST_REFERENCE_PATTERNS.md): no stored or
  returned borrowing iterator and no adapter chain over a borrowed
  container (§5.1, decision 39); no entry API
  (`issues/questions/hashmap-entry-has-no-sound-post-v2b-shape.md`); no
  guard values (§3.2); no zero-copy view — every sub-range is a copy
  (§2.4, and CODEGEN_PERFORMANCE §0.1's kernel); no `Cow` (§4.4); no
  sink-in-a-struct (§3.5); parsers return offsets, not remainders.
- The plan's own escape hatches for these are `Rc`/`RefCell` (count
  traffic and a run-time check), indices (a lookup per access), closures
  (`with`, `with_lock`: a non-escaping body), and re-derivation. They are
  right as defaults; they are the whole answer only if the shapes above
  stay rare.

## 1. What already exists and is reused unchanged

| Rule | Where | Used here as |
| --- | --- | --- |
| second-classness is structural: anything containing a borrow is second-class; where it may not go (returned, stored, captured by an escaping closure, spawned, by-value parameter) | decision 38 A | the rule set for every non-escapable value |
| a borrowing future may be returned when every borrowed place is rooted at the callee's own `imm`/`mut` parameters; at the call site the result borrows the argument places | §3.13 A2 (clarified 2026-10-07) | **R3**, generalized from futures to every non-escapable type |
| transitive freezes: a borrow, or any value built from one, keeps its source frozen until its own last use; borrow sets join over reaching definitions | decision 38 A | a non-escapable value's lifetime |
| local borrows and their live ranges end at last use; re-pointing a borrow to a place reached from itself | decisions 18, 25 | binding and re-assigning non-escapable locals |
| the call-site sigils `&x` / `&mut x`; argument overlap rules (E0901/E0911) | decisions 33, 28 | constructing a non-escapable value; exclusivity of its `mut` fields |
| projections `-> imm(T)` / `-> mut(T)`: one place, never bound | decision 24 | element access on views; the entry API's `or_insert` |
| borrowed `for` over a container place; the pin on an `Rc`-rooted container | §3.10, decision 39 | iteration over a view; the `Rc` root rule (R5) |
| a `mut(self)` receiver on a call (the "stateful call") | decision 37, parked | the iterator's `next(mut(self))` |

Nothing below needs a new checker. It needs the existing one to accept a
third holder of borrows, a declared struct, and to run A2's return rule
for it.

## 2. The rules

### R1. A struct may declare borrow-mode fields; the type is then non-escapable

```yo
View :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(imm(xs) : ArrayList(T), lo : usize, hi : usize)
);
Cursor :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(imm(xs) : ArrayList(T), i : usize)
);
Entry :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))(
  struct(mut(map) : HashMap(K, V), key : K, hash : u64, slot : BucketProbe)
);
```

- `imm(f) : T` and `mut(f) : T` are field declarations in exactly the
  spelling decision 35 uses for capture-list entries. A type with one is
  **non-escapable**: second-class by declaration, under every rule of
  decision 38 A. Enums may carry such a payload (`StrArg :: enum(Borrowed(imm(String)), Owned(String))`).
- A non-escapable type may have `imm(self)`, `mut(self)` and `self`
  methods, `Dispose` (a scope-end drop is an access, decision 38 A, so the
  drop runs while the borrow is still live), and may implement traits.
  It may not be `Clone` of its borrows (a copy of an `imm` field is a copy
  of the borrow; `Copy` is allowed for `imm`-only types, as for closures,
  and the copy is second-class too).
- Reading a borrow-mode field yields a place in the field's mode, capped
  by the receiver's: `v.xs` through `imm(v)` is `imm` even if the field is
  `mut`. Writing a borrow-mode field re-points it (decision 25's rule: a
  place reached from the current one, or a fresh lend at the same root).
- Declared storage of a borrow stays banned everywhere else: `ArrayList(View(T))`,
  a `View(T)` field in an ordinary struct, `Rc(View(T))`, `Dyn` over a
  non-escapable type, `Option(imm(T))` as a *declared* field type are all
  the decision 38 A errors they are today. A non-escapable type is the one
  way to hold a borrow in a named type, and it holds the second-classness
  with it.

### R2. Construction lends; the borrow set is the fields' union

```yo
v := View(T)(xs : &xs, lo : lo, hi : hi);        // lends xs for v's life
e := map.entry(k);                                // lends map (mut) for e's life
```

- A borrow-mode field is initialized with a sigiled argument (decision 33),
  or with a place already in the right mode (a parameter, a local borrow,
  another non-escapable value's field). The value's borrow set is the
  union of its fields' borrow sets, transitively (38 A), and every source
  stays frozen until the value's last use (decision 18). A `mut` field
  conflicts with every other access to its root while the value is live,
  as a `mut` local borrow does (E0911).
- The value is a local, an argument, a block or arm result, or an `=`
  target under the existing "may not outlive any place its value borrows"
  rule. It is not stored (R1) and not captured by an escaping closure.

### R3. A function returns a non-escapable value only with a single, inferred root

This is A2, verbatim, for every non-escapable type:

- A function may return a non-escapable value iff every place in its
  borrow set is rooted at the function's own `imm`/`mut` parameters (or
  at `self` in those modes). A borrow of a local, a temporary, a
  module-level root or a by-value parameter in the result is a compile
  error at the `return`, naming the place.
- **The dependency is inferred, never named.** With one `imm`/`mut`
  parameter of non-`Copy` type, the result depends on it. With several,
  the result depends on **all of them** unless the signature narrows it
  with a `depends(...)` clause, written like the contract clauses:

```yo
slice :: (fn(imm(xs) : ArrayList(T), lo : usize, hi : usize) -> View(T))(...);   // depends on xs, inferred
longest :: (fn(imm(a) : ArrayList(u8), imm(b) : ArrayList(u8)) -> View(u8))(...); // depends on a AND b
pick :: (fn(imm(a) : ArrayList(u8), imm(b) : ArrayList(u8), depends(a)) -> View(u8))(...); // narrowed; returning a view of b is an error
```

- At the call site the result borrows the argument places lent to the
  parameters it depends on, in their modes, and decision 38 A's transitive
  freeze holds them until the result's last use. This is the caller-side
  mapping A2 already specifies.
- The body is checked against the clause: a `return` whose borrow set
  reaches a parameter not in `depends` is the error above. The clause is
  part of the type for `Impl`/`Dyn` purposes (a function value returning a
  non-escapable type carries it).
- **Result types may be composites over borrows** when the function is an
  R3 function: `-> Option(imm(T))`, `-> (View(T), usize)`. Decision 38 A
  already makes `.Some(f)` a legal second-class *value*; this lets the
  signature say so. The *declared storage* ban of R1 is unchanged — the
  same `Option(imm(T))` as a field type is still an error. (Decision 39's
  sentence "`Option(imm(T))` is a borrow in a type-constructor argument"
  is narrowed to field and element positions by this rule.)

### R4. The stateful call, for the one method that needs it

A borrowing iterator advances its own index: `next(mut(self)) -> Option(imm(T))`.
That is the `mut(self)` receiver on a call that decision 37 parked
("added the way Hylo has it, not as a third trait"), and nothing else
here needs it. It is one of decision 30's three receiver modes applied to
a call; its spelling in a *type* (`Impl(Fn(...))` with a `mut` receiver)
is chosen when decision 37 lands, together with this note.

Without R4, views and the entry API still land (they need only
projections and `imm(self)`); only the `Iterator`-trait form of borrowing
iteration waits. The borrowed `for` over a non-escapable collection needs
no iterator value at all (`issues/questions/borrowed-for-over-user-defined-collections.md`,
option 2: `len` plus `Index` projections).

### R5. Roots through `Rc`/`Arc`

A2's rule carries over: a borrow-mode field whose place crosses an
`Rc`/`Arc` deref is allowed only through the pin the borrowed `for` uses
(§3.10: the cell's guard held for the value's life), and never `mut`
across a suspension; an `Arc` root follows the same `Sync` rules as an
`imm` lend through it (§3.8). The default root is a value place. A
`RefCell(T)` root is a `with`/`with_mut` body, never a field (the
dynamic borrow is call-scoped by decision 41).

### R6. Async and threads

A non-escapable value is not `Send` (a borrow never is, decision 38 E) and
cannot be spawned or captured by an `io.async` body except under A2's own
rules (a future holding it is a borrowing future). It may be held across
an `await` only when its roots may be (A2's `Rc`-crossing errors apply).

## 3. What it unlocks, mapped to the catalog

| Catalog gap | With this note | Rust / Swift equivalent |
| --- | --- | --- |
| §2.4 sub-range arguments, `RUST_ADOPTION_CANDIDATES.md` L1 | `View(T)` (or a builtin `[T]` spelled over it): `imm(xs)` + range, zero-copy, `len` + `Index` projections, a `for` source | `&[T]`, Swift `Span` |
| §2.2 `fn words(&self) -> Vec<&str>` | still a `ArrayList(Range(usize))` — a *list* of views is declared storage (R1) | — (Rust allows it; Yo does not, by design) |
| §5.1 borrowing iterators, adapter chains over a borrowed container | `iter(imm(self)) -> Cursor(T)` (R3, root `self`), `next(mut(self)) -> Option(imm(T))` (R4), adapters as non-escapable structs holding the cursor by value | `impl Iterator<Item = &T> + 'a` |
| §4.5 the entry API | `entry(mut(self), k) -> Entry(K, V)` (R3), `or_insert(self, v) -> mut(V)` (decision 24) | `Entry<'a, K, V>` |
| §3.2 guards | `lock(mut(self)) -> LockGuard(T)` with `Dispose` unlocking; `with_lock` stays the recommended form | `MutexGuard<'a, T>`, `RefMut` (the latter stays closure/projection-shaped, decision 41) |
| §3.5 sinks | `Serializer :: struct(mut(out) : StringBuilder, depth : usize)` | `Serializer<'a, W>` |
| §4.4 `Cow` | `StrArg :: enum(Borrowed(imm(String)), Owned(String))` | `Cow<'a, str>` |
| §2.4 parser remainders | `-> (View(u8), T)` (R3) | nom's `IResult<&str, T>` |
| §3.4 two-phase loans | `begin(mut(self)) -> Txn(S)` holding `mut(store)` | `Loan<'a>` |

Not unlocked, on purpose: a **collection of views** (R1), a view stored
in a long-lived struct, a view in a `Dyn`, a view across threads. Those
are exactly the shapes Rust needs named lifetimes for, and they keep
their catalog answers (indices, `Rc`, ownership).

## 4. What it costs

- **Evaluator.** A third borrow holder: the struct's borrow set computed
  at construction (R2), threaded through the existing transitive-freeze
  and last-use machinery; the R3 return check and the `depends` clause
  (a signature clause like `ensures`, parsed by the same path); field
  reads capped by the receiver mode (R1); the declared-storage check
  extended to "contains a non-escapable type" (it already runs per
  instantiation for closure types, 38 A).
- **Codegen.** A non-escapable struct lowers to a plain C struct whose
  borrow-mode fields are pointers (`const T*` / `T*`), exactly `RawSlice`'s
  shape; no count traffic, no header. `mut` fields are `restrict`
  candidates under CODEGEN_PERFORMANCE CP1a.
- **Verifier.** A view carries `len`; `index-in-bounds` obligations on
  `v(i)` are the same sited guards as on `xs(i)`; a non-escapable value
  with `imm` fields only is pure.
- **Seed gating.** New field syntax the seed never sees in `std` until
  `SEED_VERSION` carries it: Generation A lands the rules and a user-level
  test corpus; Generation B converts std's `slice`, `iter`, `entry`.
- **Docs.** The catalog's §5.1, §4.5, §3.2 and §2.4 are rewritten; the
  two parked decisions get their dated resolution.

## 5. Soundness argument

Every non-escapable value is a closure capture record with a name. The
borrow set, the freeze until last use, the no-escape positions, the
overlap rules and the A2 caller-side mapping are all the rules closures
and futures already obey, applied to one more holder. The three new
places a borrow could escape, and what stops it:

1. **Through a return** — R3 refuses any root that is not a parameter;
   the caller then freezes the argument places (A2's clarified mapping).
2. **Through a field write** — a borrow-mode field is re-pointed under
   decision 25, which already forbids pointing at a shorter-lived place.
3. **Through storage** — R1 keeps the declared-storage ban; a composite
   *value* over a view is second-class and cannot be stored either.

Negative tests, written before the rules land (the same discipline as
decision 38's audit): return a view of a local; return a view of the
wrong parameter under `depends`; store a view in a list; capture a view
in an escaping closure; spawn one; re-point a field to a temporary; a
`mut` view and a `push` on its root in one expression; a view through an
`Rc` without the pin; a `Dyn` over a non-escapable type.

## 6. Alternatives considered

| Alternative | Why not |
| --- | --- |
| Rust's lifetimes (`'a` in types and signatures) | named lifetimes are the annotation burden and the error-at-a-distance this project rejected (ROADMAP non-goals, decision 30); every shape in §3 is covered without a name because the root is a parameter |
| Mojo's origins (`ref [origin]`, parametric) | origins are named lifetimes with inference; the inferred half is R3, the named half is what §3's "not unlocked" row refuses |
| first-class `&T` as a type with escape analysis instead of names | an escape analysis across calls is the lifetime system again, implicit; A2's single-root rule is the part that stays intraprocedural |
| generational references (Vale) or a region system (Cyclone, Austral) | a different memory model; Yo's is settled (unique buffers, `Rc`, the collector) |
| keep only `Rc`/indices/closures | the measured copies and the catalogued gaps; this note exists because those answers are heavy exactly where std is hot |
| multiple named roots (`depends(a)` + `depends(b)` as distinct lifetimes) | "depends on all of them" is the conservative order-free rule; distinguishing roots is naming them |

## 7. Open questions, with positions

- **`[T]` as a builtin or `View(T)` in std.** Position: std first
  (`View(T)` over `ArrayList`/`Array`/`String`), the builtin spelling only
  if the verifier or codegen needs a primitive. Decided in L1's PR.
- **`depends` spelling.** Position: a signature clause beside
  `requires`/`ensures`, since it is a property of the function the caller
  must know and `yo doc` must print.
- **Whether `Dispose` on a non-escapable type may observe its borrows.**
  Position: yes, the scope-end drop is an access (38 A), which is what a
  guard needs.
- **Whether a non-escapable value may be a `match` scrutinee by value.**
  Position: yes, decision 26's by-value match consumes it; bindings borrow
  through it.
- **The `Option(imm(T))` result rule's effect on decision 39's wording.**
  Position: amend decision 39 to "declared storage" when this lands;
  nothing else there changes.

## 8. Triggers and phases

**Not before:** V3b Generation B (the modes are final) and V2b (the
collections are values; a view of a counted buffer would need the pin
everywhere). **Triggers**, any one of which opens the design: decision
39's (adapter chains over borrowed containers proving common enough that
`for` bodies and `indices()` are a burden); L1's (the count of
`slice`/`arr(a..b)` copies that exist only to pass a window);
the entry-API question resolving toward an `Entry` value.

| Phase | Lands | Gate |
| --- | --- | --- |
| N0 | this note promoted to `plans/`, the negative-test corpus written and failing | the tests fail for the right reason |
| N1 | R1–R3 in the evaluator, codegen of borrow-mode fields, `depends`; `View(T)` in std as the first consumer (Generation A: user code only) | the corpus, the fast suite, fixpoint |
| N2 | R4 (the stateful call, decision 37) and `iter()` on std's containers; adapter chains | decision 39's test requirement (growth mid-walk is a compile error for value roots, the pin panic for `Rc` roots) |
| N3 | the entry API, guards, parser remainders in std (Generation B, on the next seed) | the catalog's rewritten sections; CP0's rows for `slice` and `sort` |

Each phase is one PR or one stack with one battery, per AGENTS.md.
