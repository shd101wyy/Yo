# References as second-class types: `&T` in fields, root-joining containers, and an inferred single-root lifetime dependency

**Status: BACKLOG — the design of VALUES_BY_DEFAULT decisions 42 and 43
(2026-10-10); scheduled as its own phase after decision 42's Generation B
and V2b, timed by the VBD session.** It records the maintainer's position:
Yo keeps mutable value semantics for owned values and makes references
**types, second-class, with lifetimes elided** — the point Swift's `Span`
and Mojo's `ref` reached, taken without Rust's lifetime names, Mojo's
origins or Austral's regions. The rules below generalize one rule the plan
already had, §3.13 A2 (a borrowing future may be returned when every place
it borrows is rooted at the returning function's own parameters), from
futures to every type. `FnMut` (decision 37) lands in the same phase.

## 0. The gap this closes

Before decision 43 only two kinds of value could hold a borrow: a closure's
capture record (decision 35) and a future's capture slots (§3.13). The
consequences are catalogued in
[`RUST_REFERENCE_PATTERNS.md`](RUST_REFERENCE_PATTERNS.md): no stored or
returned borrowing iterator and no adapter chain over a borrowed container
(§5.1), no entry API (§4.5), no guard values (§3.2), no zero-copy view so
every sub-range is a copy (§2.4, and CODEGEN_PERFORMANCE §0.1's kernel), no
`Cow` (§4.4), no sink held in a struct (§3.5), parsers returning offsets
rather than remainders. The escape hatches — `Rc`/`RefCell`, indices,
closures, re-derivation — stay the right defaults; they are no longer the
whole answer.

## 1. What is reused unchanged

| Rule | Where | Used here as |
| --- | --- | --- |
| second-classness is structural: anything containing a borrow is second-class; where it may not go | decision 38 A | the rule set for every type containing a `&` |
| a borrowing future may be returned when every borrowed place is rooted at the callee's own parameters; at the call site the result borrows the argument places | §3.13 A2 | **R3**, generalized to every type |
| transitive freezes until last use; borrow sets join over reaching definitions | decision 38 A | a reference-holding value's lifetime |
| local borrows and their live ranges; re-pointing | decisions 18, 25 | binding and re-assigning reference-holding locals |
| the call-site sigils `&x` / `&mut x`; argument overlap (E0901/E0911) | decisions 33, 28 | constructing values; exclusivity of `&mut` components |
| projections `-> &T` / `-> &mut T` | decision 24 | element access on views; the entry API's `or_insert` |
| the borrowed `for`; the pin on an `Rc`-rooted container | §3.10, decision 39 | iteration over a view; the `Rc` root rule (R5) |
| `Fn`/`FnMut`/`FnOnce` | decision 37 | a borrowing iterator's `next(self : &mut Self)` is an ordinary method; a closure that writes a `&mut` capture is a `FnMut` |

## 2. The rules

### R1. Where a reference may live: the inline rule

`&T` and `&mut T` are types (decision 43). A reference, or any type
containing one, may be a component of anything laid out **inline** and the
element of a **root-joining buffer container** (R7); it may never be the
payload of a **cell**. The containing type is then second-class.

| Composite | Payload lives | May carry a `&` | Then |
| --- | --- | --- | --- |
| named `struct`, `enum` (payload per variant) | inline | yes: `xs : &ArrayList(T)`, `Borrowed(&String)` | the type is second-class |
| anonymous record `struct(...)` literal type (decision 35's capture record) | inline | yes | same as a named struct |
| tuple `(A, B)` | inline | yes: `(&ArrayList(T), usize)`; `(a, n) := t` binds `a` as a reference; a consumed tuple re-borrows its `&` components (nothing moves out of a borrow) | second-class per instantiation |
| `Array(T, N)` | inline | yes: `Array(&T, N)`; `Index` yields the element reference; all elements share one borrow set, the union of the literal's sources | second-class per instantiation |
| `Option(T)`, `Result(T, E)`, any user constructor | inline | yes, as an instantiation over a `&`: `Option(&T)`, `Result((View(u8), T), ParseError)` | second-class per instantiation |
| `ArrayList(T)`, `HashMap(K, V)`, every buffer-owning container | a buffer | yes, as a **root-joining** container (R7) | second-class, borrow set grows |
| `Box(T)`, `Rc(T)`, `Arc(T)`, `RefCell(T)`, `Dyn(Trait)`, a closure stored in `Impl`/`Dyn` | a cell | **no** — E0909 | — |

```yo
View :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(xs : &ArrayList(T), lo : usize, hi : usize)
);
Cursor :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(xs : &ArrayList(T), i : usize)
);
Entry :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))(
  struct(map : &mut HashMap(K, V), key : K, hash : u64, slot : BucketProbe)
);
StrArg :: enum(Borrowed(&String), Owned(String));
```

- **The type decides, not the live variant.** A `StrArg` built as `.Owned`
  still cannot be stored in a cell: decision 38 A's rule is structural
  over types. A program that wants a storable owned form declares a second
  enum, or stores the payload.
- **Reading a `&` component** through a value lent as `&` yields `&T`
  whatever the field's mode (a `&mut T` reached through a `&` path is
  read-only, decision 43); through `&mut` or an owned value it yields the
  field's mode. **Writing** one: `v.xs = &other` re-points it, `v.xs = ys`
  is a write through it (a type error unless the field is `&mut`) — the
  sigil on the right decides (decision 42).
- **`match`** follows decision 26: through a borrowed scrutinee a `&`
  payload binds as a reference capped by the scrutinee's mode; a by-value
  scrutinee consumes the enum and a `&` payload bound by value re-borrows
  with the enum's borrow set. `Option(&T)` is this case: `.Some(&x)` is a
  legal second-class value, and R3 lets a signature say it is returned.
- **`Copy`.** A type whose references are all `&` is `Copy` if the rest
  is, with second-class copies (as `&T` itself is `Copy`); a `&mut`
  component makes it move-only (a copy would be two exclusive borrows).
- **Where such a type may stand:** a local, a parameter, a result, a block
  or arm result, a field of another inline composite, an element of a
  root-joining container — never a cell payload, a `Dyn` payload, a
  spawned value, an escaping closure's capture, or a `Send` value.
- **Passing.** A reference-holding value is passed by value when the slot
  is a reference type (`f(v)` into `v : View(T)` copies an all-`&` value
  and moves a `&mut`-holding one; decision 38 A as amended by 43) or by
  lend (`f(&v)` into `v : &View(T)`); the callee is checked per
  instantiation and its result inherits the roots (R3).

### R2. Construction lends; the borrow set is the components' union

```yo
v := View(T)(xs : &xs, lo : lo, hi : hi);        // lends xs for v's life
e := map.entry(k);                                // lends map (&mut) for e's life
```

A `&` component is initialized with a sigiled argument (decision 33) or
with a reference already in hand. The value's borrow set is the union of
its components' sets, transitively (decision 38 A), and every source stays
frozen until the value's last use (decision 18). A `&mut` component
conflicts with every other access to its root while the value is live
(E0911). Re-assigning the value follows decision 25.

### R3. A function returns a reference-holding value only with a single, inferred root

§3.13 A2, verbatim, for every type:

- A function may return a reference-holding value iff every place in its
  borrow set is rooted at the function's own `&`/`&mut` parameters (or
  `self` in those modes). A borrow of a local, a temporary, a module-level
  root or a by-value parameter in the result is a compile error at the
  `return`, naming the place.
- **The dependency is inferred, never named.** With one reference
  parameter, the result depends on it. With several it depends on **all
  of them** unless a `depends(...)` clause, written like the contract
  clauses, narrows it:

```yo
slice :: (fn(xs : &ArrayList(T), lo : usize, hi : usize) -> View(T))(...);              // depends on xs, inferred
longest :: (fn(a : &ArrayList(u8), b : &ArrayList(u8)) -> View(u8))(...);               // depends on a AND b
pick :: (fn(a : &ArrayList(u8), b : &ArrayList(u8), depends(a)) -> View(u8))(...);      // narrowed: a view of b is an error
```

- At the call site the result borrows the argument places lent to the
  parameters it depends on, in their modes, frozen until the result's
  last use (A2's caller-side mapping). The clause is part of the type for
  `Impl`/`Dyn` purposes. Result types may be composites over references
  (`-> Option(&T)`, `-> (View(T), usize)`, `-> Result((View(u8), T), E)`).

### R4. Methods and iterators

A reference-holding type has ordinary `&Self`, `&mut Self` and `Self`
methods, `Dispose` (the scope-end drop is an access, decision 38 A, so a
guard's `dispose` runs while its borrow is live), and trait impls. A
borrowing iterator is `iter(self : &Self) -> Cursor(T)` (R3, root `self`)
with `next(self : &mut Self) -> Option(&T)`; the borrowed `for(&xs, …)`
dispatches through `impl(&C, IntoIterator(…))`, Rust's shape
(`issues/questions/borrowed-for-over-user-defined-collections.md`). A
closure that writes a `&mut` capture is a `FnMut` (decision 37).

### R5. Roots through `Rc`/`Arc`

A `&` component whose place crosses an `Rc`/`Arc` deref is allowed only
through the pin the borrowed `for` uses (§3.10: the cell's guard held for
the value's life), never `&mut` across a suspension; an `Arc` root follows
§3.8's `Sync` rules. The default root is a value place. A `RefCell(T)` root
is a `with`/`with_mut` body, never a component (the dynamic borrow is
call-scoped, decision 41).

### R6. Async and threads

A reference-holding value is not `Send` (decision 38 E) and cannot be
spawned or captured by an `io.async` body except under A2's own rules. It
may be held across an `await` only when its roots may be (A2's
`Rc`-crossing errors apply).

### R7. Root-joining containers — `ArrayList(&T)` and every buffer over a `&`

A buffer container instantiated over a `&` is legal and second-class, and
unlike a struct (R2) its borrow set **grows**. Every `&` lent into a
`&mut self` method of the container (`push`, `insert`, `extend`, `set`, an
`Index` place write) joins the container's roots for the rest of its life;
a `&self` method joins nothing; a `depends` clause on the method narrows it
(`push(self : &mut Self, v : &T, depends(self : v))` says only `v` flows
in). Joined roots keep their mode: a `&mut x` pushed in freezes `x`
exclusively for the container's live range, so a second `&mut x` or a read
of `x` while it lives is E0911; a `&x` freezes `x` against writes only.
Returning the container is R3 over the joined set:

```yo
// View(u8) is the L1 view into the String's bytes. `str` itself is the first-class
// Copy view of STATIC bytes and never takes `&`: `(x : str) = "Hi";` and
// `ArrayList(str)` are ordinary first-class values.
words :: (fn(self : &Doc) -> ArrayList(View(u8)))({
  out := ArrayList(View(u8)).new();
  for(&self.word_ranges(), r => { out.push(self.text.view(r)); });   // every root is self
  out                                                               // R3: depends on self
});
```

- Growth and reallocation are irrelevant to soundness: the elements are
  pointers and the roots are frozen or exclusively borrowed for the
  container's life.
- Elements rooted through an `Rc`/`Arc` deref are rejected (R5's pin is
  per value); a cell never holds such a container (`Rc(ArrayList(&T))` is
  E0909). A struct holding one is second-class by the structural rule.
- **The tracker is new** (the VBD implementer's review): the closures'
  capture-borrow sets (`g_capture_borrows`, keyed by the capture struct's
  type id) cannot carry it, since two `ArrayList(&T)` values share one type
  with different roots. Root-joining is a per-value borrow set on the
  binding — the single local-borrow root `VariableRare.inout_borrow_root_id`
  keeps today, extended to a set of `(root, mode)` pairs — joined at each
  `&mut self` call that receives a `&` argument, unioned over reaching
  definitions at control-flow joins, read by the freeze and exclusivity
  checks. Flow-sensitive and intraprocedural.
- Codegen: a buffer of `const T*` / `T*`, no count traffic, no element
  drops.

## 3. What it unlocks, mapped to the catalog

| Catalog gap | Now | Rust / Swift equivalent |
| --- | --- | --- |
| §2.4 sub-range arguments, `RUST_ADOPTION_CANDIDATES.md` L1 | `View(T)` (or a builtin `[T]` over it): `&xs` + range, zero-copy, `len` + `Index` projections, a `for` source | `&[T]`, Swift `Span` |
| §2.2 `fn words(&self) -> Vec<&str>` | `words(self : &Doc) -> ArrayList(View(u8))` (R7, root `self`), pass-local | `Vec<&'a str>` |
| §5.1 borrowing iterators, adapter chains over a borrowed container | `iter(self : &Self) -> Cursor(T)`, `next(self : &mut Self) -> Option(&T)`, adapters as inline structs holding the cursor; `impl(&C, IntoIterator)` for the `for` | `impl Iterator<Item = &T> + 'a` |
| §4.5 the entry API | `entry(self : &mut Self, k) -> Entry(K, V)` (R3), `or_insert(self, v) -> &mut V` | `Entry<'a, K, V>` |
| §3.2 guards | `lock(self : &mut Self) -> LockGuard(T)` with `Dispose` unlocking; `with_lock` stays the recommended form | `MutexGuard<'a, T>` |
| §3.5 sinks | `Serializer :: struct(out : &mut StringBuilder, depth : usize)` | `Serializer<'a, W>` |
| §4.4 `Cow` | `StrArg :: enum(Borrowed(&String), Owned(String))` | `Cow<'a, str>` |
| §2.4 parser remainders | `-> (View(u8), T)` (R3) | nom's `IResult<&str, T>` |
| §3.4 two-phase loans | `begin(self : &mut Self) -> Txn(S)` holding `store : &mut Store` | `Loan<'a>` |

Not unlocked, on purpose: a reference kept beyond its roots' frame with
more than one independent root, a reference in a cell or a `Dyn`, a
reference across threads — the shapes Rust needs named lifetimes for; they
keep their catalog answers (`RUST_REFERENCE_PATTERNS.md` §14).

## 4. What it costs

- **Evaluator.** A `TypeValue` reference variant replacing the slot flags
  (`param_is_ref`, `call_param_is_ref`/`is_owning` in `FnTraitT`,
  `FuncParam` modes) through the evaluator, the specializer, the verifier
  encoding and codegen — the largest refactor in the plan; the per-value
  borrow-set tracker (R7); the R3 return check and the `depends` clause
  (parsed with the contract clauses); the inline rule's declared-storage
  check; `FnMut` (decision 37).
- **Codegen.** A reference is a `const T*` / `T*`; a reference-holding
  struct is a plain C struct of pointers, `RawSlice`'s shape; no count
  traffic, no header. `&mut` components are `restrict` candidates under
  CODEGEN_PERFORMANCE CP1a.
- **Verifier.** A `&T` parameter is a lent, unchanged place; a bound `&T`
  local an alias of its root; a view carries `len` and the same
  `index-in-bounds` obligations as its container; containers of
  references are outside the subset until modelled.
- **Seed gating.** New syntax the seed never sees: Generation A lands the
  types, the rules and the test corpus in user code; Generation B converts
  std (`slice`, `iter`, `entry`, the `FnMut` slots) on the next seed.
- **Docs.** The catalog's §2.2, §2.4, §3.2, §4.5, §5.1 are rewritten with
  the phase; decision 38 A's type-position bullet, decision 24 and decision
  39 already carry the final rule.

## 5. Soundness argument

Every reference-holding value is a closure capture record with a name. The
borrow set, the freeze until last use, the no-escape positions, the overlap
rules and A2's caller-side mapping are the rules closures and futures
already obey. The places a reference could escape, and what stops it:

1. **Through a return** — R3 refuses any root that is not a parameter; the
   caller freezes the argument places.
2. **Through a component write** — a re-point follows decision 25, which
   forbids pointing at a shorter-lived place.
3. **Through storage** — the inline rule keeps cells and `Dyn` payloads
   reference-free; a container's roots grow with what flows in (R7).
4. **Through a copy** — an all-`&` value's copies carry the same roots; a
   `&mut`-holding value is move-only.

**The negative-test corpus, written before the rules land:** return a view
of a local; return a view of the wrong parameter under `depends`; store a
view in a cell (`Rc(View(T))`, `Box(View(T))`); a `Dyn` over a tuple with a
reference; capture a view in an escaping closure; spawn one; re-point a
component to a temporary; a `&mut` view and a `push` on its root in one
expression; a view through an `Rc` without the pin; store a `StrArg` whose
live value is `.Owned` in a cell; move a `.Borrowed` payload out of a
consumed scrutinee; return `.Some(&local)`; `derive(Copy)` on an enum with
a `&mut` payload; `ArrayList(&mut T)` with two pushes of one root (E0911);
a read of `x` while `ArrayList(&mut T)` holding `&mut x` lives; a return
of a container with a non-parameter root; an `Rc`-rooted element in a
container; a `&mut T` through a `&` path written (error). Positive
controls: a local `Array(&T, 3)` from three lends; `(a, n) := t`
re-borrowing; `-> Result((View(u8), T), E)`; `f(v)` copying an all-`&`
view; `words`.

## 6. Alternatives considered

| Alternative | Why not |
| --- | --- |
| Rust's lifetimes (`'a` in types and signatures) | the annotation burden and the error-at-a-distance this project rejected (ROADMAP non-goals); every shape in §3 is covered without a name because the root is a parameter |
| Mojo's origins (`ref [origin]`, parametric) | named lifetimes with inference; the inferred half is R3, the named half is what §3's "not unlocked" refuses |
| Austral's regions and linear types | regions are lexical names; linear "use exactly once" is heavier than Yo's affine moves plus `Dispose`, and ATS A2's must-use covers the useful part |
| references as modes only (the pre-decision-43 design) | correct but confusing (a mode written in a type slot that is not a type) and it blocks `impl(&T, …)` and `FnMut`; the maintainer chose types |
| keep only `Rc`/indices/closures | the measured copies and the catalogued gaps |
| multiple named roots | "depends on all of them" is the conservative order-free rule; distinguishing roots is naming them |

## 7. Open questions, with positions

- **`[T]` as a builtin or `View(T)` in std.** Position: std first, the
  builtin spelling only if the verifier or codegen needs a primitive.
  Decided in L1's PR. Related: whether `str` becomes the view of an owned
  `String`'s bytes in borrow position (L1).
- **`depends` spelling.** Position: a signature clause beside
  `requires`/`ensures`, since the caller must know it and `yo doc` must
  print it.
- **Whether a `&`-holding value may be a `match` scrutinee by value.**
  Position: yes, decision 26's by-value match consumes it; bindings borrow
  through it.

## 8. Phases

| Phase | Lands | Gate |
| --- | --- | --- |
| N0 | the negative-test corpus written and failing | the tests fail for the right reason |
| N1 | the `TypeValue` reference variant, R1–R3, `.*`/auto-deref/auto-borrow, `impl(&T, …)`, `depends`, `FnMut`; `View(T)` in std as the first consumer (Generation A: user code only) | the corpus, the fast suite, fixpoint |
| N2 | R7's per-value tracker; `iter()` on std's containers; adapter chains; `impl(&C, IntoIterator)` | decision 39's test requirement (growth mid-walk is a compile error for value roots, the pin panic for `Rc` roots) |
| N3 | the entry API, guards, parser remainders, the `FnMut` slots in std (Generation B, on the next seed) | the catalog's rewritten sections; CP0's rows for `slice` and `sort` |

After decision 42's Generation B and V2b; each phase is one PR or one
stack with one battery, per AGENTS.md.
