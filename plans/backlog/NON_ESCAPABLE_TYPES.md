# References as first-class types with origins: the `Origin` kind, `&(T, p)`, and declared place sets

**Status: BACKLOG — the design of VALUES_BY_DEFAULT decision 43, amended
2026-10-19 by the maintainer: references become FIRST-CLASS types
parameterized by origins.** An origin is a named set of places — a new
comptime kind beside `Type`, spelled `p : Origin` in `generic(...)`, and a
trailing argument of the reference types: `&(T, p)`, `&mut(T, p)`. Yo keeps
mutable value semantics for owned values (decision 42's spelling; decisions
18, 24, 25, 28, 33, 35, 37, 38, 47 unchanged) and keeps the freeze model —
`&` means unchanged, `&mut` exclusive — but a reference, and any type
containing one, may now stand anywhere its origins can follow, storage
included. The second-class caste of the 2026-10-10 decision becomes one
structural predicate: **this position accepts no origin parameters** (E0909
restated; the positions are §2 O4's list). This amendment supersedes the
2026-10-13 `depends`-clause and root-joining-tracker design (this file
before the amending PR, in git history); the mapping from every clause form
to an origin spelling is §2 O7, and the reason each half was retired is
§6.

The design follows Ante's place-based borrow checker
(<https://antelang.org/blog/safe_cyclic_mutability/>, read 2026-10-19):
places rather than abstract regions, a place parameter on `Rc`, union
places, place paths. §6 records what was adopted and what was rejected,
with reasons. One principle frames the surface language (maintainer,
2026-10-19): **Yo is written by LLMs, so contracts are explicit** — origins
are spelled in signatures and type declarations, and elided only to defaults
the checker still verifies (O2).

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
whole answer. The origin amendment additionally opens **storage**: a
reference-holding value in a cell, behind an owning pointer, in a shared
structure — the shapes the second-class wall (E0909) refused outright —
become ordinary types whose origin parameters propagate outward to a frame
that owns the places.

## 1. What is reused unchanged

| Rule | Where | Used here as |
| --- | --- | --- |
| local borrows and their live ranges; freeze until last use; re-pointing | decisions 18, 25 | the intraprocedural half of checking (O3); origins replace only the interprocedural bookkeeping |
| transitive freezes; second-class escape positions | decision 38 A | restated as the no-origin positions (O4) |
| argument overlap and shared/exclusive conflict at a call | decision 28, 38 B | origin intersection (O3) |
| projections `-> &T` / `-> &mut T`; a `&mut` projection borrows its base | decision 24 | unchanged; the projection's result carries the base's origin |
| the call-site sigils `&x` / `&mut x` | decision 33 | unchanged; a construction site names its own origin — `&x`'s origin is `x`, self-describing, never spelled |
| capture lists | decision 35 | entries spell origins like fields (O7) |
| `Fn`/`FnMut`/`FnOnce` | decision 37 | unchanged; `Fn(...)` types carry origin parameters |
| the borrowed `for`; the pin on an `Rc`-rooted container | §3.10, decision 39 | unchanged (a loop, not a value) |
| a future may borrow when rooted at the body's `&`/`&mut` parameters | §3.13 A2 | the origin spelling of the same rule (O8); A2's wrapper-id registry is replaced by type-carried origins |
| `Rc` is read-only through the handle; the three doors | decision 46 | unchanged for `Rc(T)`; the gated `Rc(T, p)` (O9) extends it |
| `mut(G)`/`mut(x)` markers | decision 47 | unchanged; a marker grants writability of a binding, an origin names the places a borrow touches — orthogonal facts |

## 2. The design

### O1. The `Origin` kind and the reference types

`Origin` is a comptime kind beside `Type`: a value of the kind is a **set of
places**. Reference types take it as a trailing argument.

```yo ignore
// a function abstract over an origin:
next :: (fn(generic(T : Type, p : Origin), self : &mut(Cursor(T, p))) -> Option(&(T, p)))(...);
// a type constructor binding one (the comptime fn's parameter list grows by the kind):
Cursor :: (fn(comptime(T : Type, p : Origin) -> comptime(Type))(
  struct(xs : &(ArrayList(T), p), i : usize)
));
// unions are spelled as tuples in origin position; q and r are declared first:
longest :: (fn(generic(q : Origin, r : Origin), a : &(ArrayList(u8), q), b : &(ArrayList(u8), r)) -> View(u8, (q, r)))(...);
```

- **An origin value is one of:** an origin parameter (`p`, abstract,
  instantiated at each application exactly as a `Type` argument is); **a
  reference-typed parameter's place** — a `&`/`&mut` parameter, whose
  place is the *caller's lent place*, spelled by the parameter's name
  (`self`, `xs`): `iter(self : &Self) -> Cursor(T, self)` names the
  receiver's lent place. A **by-value** parameter of reference-holding
  type contributes only the origin parameters its type carries, never its
  own place (that slot is the callee's frame; E0912's rule); or **a
  declared union** `(p, q)`. Field-path origins
  (`self._buf`) are designed (§7) and phased with the access clause. A
  local's place is an origin **inside bodies only** (flow-inferred, O2);
  it can never appear in a signature (O3's return rule rejects it).
- **An origin parameter is declared before use** (maintainer, 2026-10-20):
  an abstract origin named in a signature must be declared in the
  `generic(...)` clause (`generic(q : Origin, r : Origin)`), exactly as a
  type name must be; a type constructor declares it among its `comptime`
  parameters. An undeclared origin name in a signature is an error naming
  the declaration site. A **reference-typed parameter's own place**
  (`self`, `a`, `b`) needs no declaration — it names a parameter the way
  a field path names a field.
- **The parse.** `&(A, B)` in type position is an origin-qualified reference
  iff `B` resolves to an `Origin`-kinded name; if both `A` and `B` resolve
  to types it is a reference to a tuple, exactly as today. The two readings
  never compete: an origin is not a type, so `&(i32, p)` with `p : Origin`
  has exactly one well-formed parse. The rule will be stated in the syntax
  documentation with the example when N1 lands it. (`&mut(A, B)` is the
  same rule.) If
  parsing the pair ever proves friction in practice, the reserved fallback
  is a named slot (`&(i32, origin : p)`); it is designed, not adopted.
- **The pointee comes first** (`&(i32, p)`, not `&(p, i32)`): every other
  parameterized type takes the payload first and qualifiers after
  (`ArrayList(T, p)`, `Cursor(T, p)`), the origin slot of a reference is
  the same trailing position, and the pointee type keeps its fixed place —
  `&i32` extends to `&(i32, p)` without moving anything. Rust's
  origin-first `&'a T` habit is deliberately not matched; Yo diverges from
  Rust's spellings everywhere else and internal consistency wins.
- **Well-formedness — no self-origin.** A binding's type may not name the
  binding's own place, and a type definition may not name its own fields:
  `xs : ArrayList(&(T, xs))` and `struct(next : &(Node, self.field))` are
  errors. This one rule is what makes self-reference unrepresentable and
  keeps `Pin` out of Yo (O5).
- **Origins are comptime values.** `TypeInfo` gains the `Origin` kind
  beside `Reference(T, mutable, origin)`; reflection reads them. Comptime
  algebra over them (an `overlaps` predicate for `where(...)` aliasing
  preconditions) is an open question (§7), not part of the first phases.
- **Codegen erases origins.** A reference is a `const T*` / `T*`; a
  reference-holding struct is a plain C struct of pointers, `RawSlice`'s
  shape; no count traffic, no header, no runtime mark. The only runtime
  borrow state in the language remains `RefCell`'s (§3.10).

### O2. Elision: defaults the checker verifies, never inference it trusts

Every origin may be elided; elision is a **default the checker still checks
the body against**, so it changes what is written, never what is proven
(the guarantee that does the work is O3's coercion rule: a body storing
`&(T, q)` into a `&(T, p)`-typed place checks `q ⊆ p`, so an elided
signature that lies fails in the callee, not at a caller far away).

| Position | Elided means |
| --- | --- |
| a reference parameter | a fresh anonymous origin, per occurrence: `f(xs : &ArrayList(T), key : &T)` is `f[p, q](...)`, two unrelated borrows |
| the result's origin | the union of every reference-holding parameter's origin (the conservative R3-era default): `longest(a, b) -> View(u8)` elided borrows both |
| a `&` field of a type definition | a fresh anonymous origin parameter per field: `struct(xs : &ArrayList(T), lo : usize)` binds one; spell them when fields must relate |
| a local binding or container in a body | flow-inferred by the intraprocedural checker; diagnostics print the inferred set |

- Elision is for simple signatures; the load-bearing ones spell. std's
  `Iterator` trait spells `next`'s origin so every impl is checked against
  the non-lending contract; an elided `next(self : &mut Cursor(T)) ->
  Option(&T)` is the conservative lending reading (the item's origin is
  the union of the ref parameters = the cursor's place), exactly the old
  default.
- **std's `depends(self : ())` obligation disappears.** Distinct elided
  origins never unify: `map.remove(&k)` and `list.binary_search(&probe)`
  keep the key usable after the call with nothing spelled, because the
  key's fresh origin is unrelated to the container's. What `depends`
  existed to narrow is now the default, and spelling is what narrows
  further.

### O3. The checking rules: set algebra over declared places

Checking an origin-parameterized program is four mechanisms, none of them a
region solver:

1. **Application** substitutes origin arguments at every call, exactly as
   `Type` arguments are substituted today (the receiver's type fixes the
   method's origin args; the arguments must match the substituted
   signature).
2. **Conflict is origin intersection.** A `&mut(T, p)` live (decision 18's
   live ranges) conflicts with any other live use of any place in `p`
   (E0911); two `&mut` arguments of one call with intersecting origins are
   E0910 (decision 28 restated); reads of `p` coexist — Ante's use-vs-
   mention distinction falls out of set algebra without an effect system.
3. **Coercion is subset.** `&(T, p)` coerces into `&(T, (p, q))` (widening
   a union) and into a fresh-elided parameter's position; nothing else
   coerces. This is the whole subtyping story — there is no variance
   lattice.
4. **Liveness** is decision 18's, unchanged: freezes end at last use,
   re-pointing is decision 25's, moves and drops are accesses.

Around them:

- **The return rule** (R3's successor): an origin in a result type may name
  only origin parameters or reference-typed parameters' places (a by-value
  parameter contributes its type's origin parameters, never its own
  place). A local's place — or a by-value parameter's slot, which is one —
  in a result is a compile error at the `return`, naming the place —
  the caller-side mapping is the substitution of step 1 plus the freeze of
  step 2, so the "re-rooting" A2 could not do for futures becomes ordinary
  type application.
- **Place writes.** `v.xs = &y` requires `y`'s origin ⊆ `v`'s declared
  origin set; `v.xs.* = ys` writes through it (an error unless the field
  is `&mut`); `v.xs = ys` with `ys : ArrayList(T)` is a type error (a
  reference is a value; only `.field`/`.method()` auto-deref, decision
  43). No tracker state: the type of `v` is the whole contract.
- **Containers declare their unions** (O6): a push outside the declared set
  is a local error naming both sets; `yo fix` widens the declaration.
- **`mut` markers stay orthogonal** (decision 47): writing through a
  `&mut(T, p)` requires the roots of `p` to be `mut`-marked at their
  bindings; an origin names where a borrow touches, a marker grants that a
  binding is writable.
- **Sibling sub-loans** (from R4): the two `&mut(T, self._buf)` results of
  `get2_mut` share one origin by construction — multiple `&mut` results of
  one call are sibling sub-loans, disjoint by the callee's raw-pointer body
  and its `requires(i != j)` (the verifier discharges it; the body's safety
  assert stays in every build). This is the one place the checker accepts
  two live `&mut` over one origin, and only from a single call's results.
- **Reborrows** (decision 43): a `&mut` passed to a `&mut` slot is
  reborrowed (`&mut r.*`); read through a `&` path a `&mut` component
  yields a `&` reborrow over the same origin — the holder stays frozen
  while the reborrow lives.
- **Drops that use no root** (R4's `may_dangle` obligation): std's buffer
  containers free their buffer without touching the joined roots'
  referents, so `x`'s scope-end drop after `out`'s last use is not a
  conflict. A user-written `Drop` on a reference-holding type keeps every
  root live until the drop.

### O4. First-classness: where origin-carrying types may stand

| Position | May carry origin parameters |
| --- | --- |
| locals, parameters, results, block and arm results | yes |
| fields of inline composites (named/anonymous structs, enums, tuples, `Array(T, N)`, `Option`, `Result`, any user constructor) | yes — the composite gains the origin parameters of its fields' types |
| buffer containers (`ArrayList`, `HashMap`, …) | yes, over a declared union (O6) |
| cells — `Box`, `RefCell`, `Dyn` payload, an escaping closure's capture, a spawned value | **`Box` and `RefCell`: yes** (the pointer points outward; moving the cell moves the pointer, never its target — O5), **`Dyn`, spawn and an escaping closure's capture: no** (E0909, initially) |
| `Send` values, thread boundaries | no — structurally: a type with origin parameters is not `Send` |
| module-level bindings | no, initially (§7) |
| `extern` signatures | no — FFI takes raw pointers, the existing unsafe boundary |
| self-referential (an origin naming the value's own fields or its own place) | never — the well-formedness rule of O1 |

E0909 is restated: **"this position accepts no origin parameters"** — one
structural check off the type, replacing the per-position enumeration of the
second-class wall. A `Box(&(T, p))` is legal wherever `p` is in scope; a
`RefCell(&(T, p))` legal beside it (the cell's dynamic marks govern the
payload's mutation, the origin governs the borrow — orthogonal); an
`Rc(&(T, p))` waits for O9.

### O5. No self-reference, therefore no `Pin`

Rust needs `Pin` because a value can contain a pointer into itself (an
async generator holding a borrow of its own saved local across an `await`),
so moving the value after construction would dangle the pointer. Yo's
design makes that state **unrepresentable**:

- An origin may only name places that exist **before** the value:
  parameters, enclosing bindings, earlier origins. A type definition cannot
  name its own fields and a binding's type cannot name its own place (O1's
  well-formedness rule). Every reference inside a value points **outward**,
  at a place owned by an enclosing frame.
- Moving a value therefore never dangles anything it contains: the pointers
  aim at other frames' storage. This is the same trade Hylo and Swift make,
  and the same position the second-class design already had — nothing is
  lost relative to the landed baseline, and the escape it names is the
  existing one: a self-referential struct is not writable in safe Yo at all
  (Rust can, with `Pin` and `unsafe`).
- **Async.** §3.13 A2 already restricts a borrowing future to borrows
  rooted at its body's `&`/`&mut` parameters; the origin spelling is
  `Future(T, p)` with `p` those parameters' places, and the state machine
  (heap-allocated once cold) stores only outward pointers to the caller
  frame. A borrow of an async body's **own local** living across an
  `await` would need an origin naming the state machine's own field —
  prohibited by the same rule; the await-point check (O8) rejects a live
  body-local origin at the `await`. No `Pin`, no address-stability
  reasoning, no projection-safe move analysis.
- `Box` gives the stable-address escape hatch FFI-style code needs: the
  payload never moves when the handle does. Holding `&(T, box_place)`
  across a move of the box is rejected anyway (the move is an access,
  decision 18) — no aliasing subtlety reaches the user.

### O6. Containers: declared origin unions

A buffer container instantiated over a type containing a reference carries
the reference's origin parameter as its own — spelled as a declared union
at the instantiation:

```yo ignore
out := ArrayList(&(View(u8), self))(...);       // may ever hold views rooted at self
both := ArrayList(&(T, (x, y)))(...);           // two roots, declared up front
out.push(self.text.view(rng));                  // the view's origin is self ⊆ self: accepted
both.push(&z);                                  // error naming {x, y} and {z}; yo fix widens
```

- Growth and reallocation are irrelevant to soundness: the elements are
  pointers and the roots are frozen or exclusively borrowed for the
  container's life (the elements never move within their buffer in a way
  the references could miss — realloc copies pointers, not referents).
- A push outside the declared union is a local, deterministic error — the
  friction of rigidity is accepted deliberately (maintainer, 2026-10-19:
  LLM authorship prefers a declaration to fix over an inference to
  understand), and a `yo fix` widening proposes the widened union.
- Returning the container is the return rule over the union:
  `words(self : &Doc) -> ArrayList(&(View(u8), self))` — every pushed
  view's origin ⊆ `self`, checked in the body, stated in the type.
- In a body, the union may be elided and flow-inferred (O2); the signature
  it must satisfy is still spelled or defaulted.
- Codegen: a buffer of `const T*` / `T*`, no per-element retain/release, no
  element drops.

### O7. What replaces `depends`: the mapping

Every clause form of the superseded design is an origin spelling now.
The clause grammar, its zone after `where`, its `Fn(...)-type` subtyping
order and its callee checks are **not built** — parametricity does their
work (the rows abbreviate the `generic` clause that declares each origin
parameter):

| Superseded clause | Origin spelling |
| --- | --- |
| `depends(view : a)` | `-> View(u8, a)` |
| the default (every ref-holding param) | the elided result origin (O2) |
| `depends(item : self.*)` | `self : &mut(Cursor(T, p)) -> Option(&(T, p))` — the origin `p` the cursor carries |
| a projection into the parameter's own storage (`p`, not `p.*`) | the parameter's place origin: `get(self : &Self, ...) -> Option(&(V, self))` |
| `depends(self : value)` on `push` | `self : &mut(ArrayList(&(T, r))), value : &(T, r)` — one shared variable; the caller's subset coercion is the join |
| `depends(self : ())` on a lookup | nothing — distinct elided origins never unify (O2) |
| `swap(a : &mut T, b : &mut T, depends(a : b.*, b : a.*))` | `swap(a : &mut(&(T, r), p), b : &mut(&(T, r), q))` — both referents typed `&(T, r)`, so exchanging values needs no flow clause: origins travel with values |
| a trait's clause binding every impl | the trait method's signature carries the origin parameters; an impl may instantiate narrower (subset), never wider |

- **Closures.** A capture-list entry spells origins like a field:
  `{ y : &(T, y), z : &mut(T, z) }` — the closure's type carries them; a
  lent `Impl(Fn(...))` slot's own origin parameters must subsume the
  literal's (the coercion rule, O3-3). A closure's parameters are fresh
  origins like any function's.
- **`Impl(Fn(...))` types carry origin parameters** in their argument and
  result positions; `Dyn(Fn(...))` payloads stay origin-free initially
  (§7).
- **Effect handlers and `Dyn` dispatch:** a handler's `return(expr)` resume
  value is checked against the operation's signature — its result origins
  may name the operation's own parameters, never the handler's captures;
  `unwind` at the enclosing function's return. `Dyn(Trait)` dispatch maps
  from the trait method's declared origins; every impl was checked against
  them.

### O8. Async and threads

- A borrowing future carries its origins in its type (`Future(T, p)`,
  `p` the body's `&`/`&mut` parameter places, §3.13 A2 unchanged in
  substance): the wrapper-id registry A2 built is replaced by the type, and
  **forwarding works** — `f(c : &mut C, io)` returning `bump(&mut c, io)`
  is ordinary substitution, closing A2's recorded "forwarding is not
  accepted yet" gap.
- **The await-point rule:** a live origin naming a body-local place at an
  `await` is an error (O5); module-level places follow decision 18 rule 3
  (no call or `await` in the live range), now visible in the type as the
  named global.
- An origin-carrying type is not `Send` (structural), cannot be spawned,
  cannot be captured by an `io.spawn` body. `Arc` stays origin-free and
  read-only across threads (decision 46, D3).

### O9. `Rc(T, p)`: statically checked shared mutation (gated phase)

Decision 46 stays true for the plain handle: `Rc(T)` carries no marks, the
payload is read-only through it, and the doors are `RefCell(T)`,
`Rc.get_mut`, `Rc.make_mut`. The origin amendment adds a fourth door, on
its own phase and gated on a counted need (the census below):

- **`Rc(T, p)`** is a handle whose payload's mutation rights are tied to
  the origin `p`. Every clone constructed from it shares `p` — the type
  says so, so a clone cannot lose the tracking. A read projection through
  any handle yields `&(T, p)`; a write projection yields `&mut(T, p)` and
  requires exclusivity over `p` — statically, by O3's intersection, with
  **no runtime marks and no runtime cost** (the marks decision 41 removed
  do not come back; the check is compile-time set algebra).
- **Cycles become writable without `RefCell`**: a node whose next-pointers
  are `Rc(Node(T), p)` — the graph's nodes share `p`; mutation through
  any handle is exclusive over `p`. Rust needs `GhostCell`-style machinery
  for this; Yo spells it as an instantiation. Leaks stay possible (a cycle
  outliving its root cannot be freed deterministically) — the cycle
  collector keeps that job, exactly as Ante treats leaks as a separate
  collection concern.
- **Granularity, honestly:** exclusivity is over the whole origin, so
  concurrent disjoint-node mutation is rejected; it goes to `get2_mut`-
  style contracts (R4's sibling sub-loans) or stays behind `RefCell`.
  Ante's invalidation semantics (§6) would buy that granularity at the
  cost of "`&` means unchanged" — rejected, recorded.
- **Adoption target:** decision 46's census — 379 `Rc`-write sites (std's
  async channel and mutex states among them). Each site becomes either a
  `p`-tracked handle (proof where the summaries proved outcome (a)) or
  keeps its `RefCell`. `Arc(T, p)` does not exist (threads share no
  places); `Rc(T, p)` is not `Send`/`Sync`.

## 3. What it unlocks, mapped to the catalog

(The signatures abbreviate the `generic(...)` clause that declares each
origin parameter, as O7's table does.)

| Catalog gap | Now | Rust / Swift equivalent |
| --- | --- | --- |
| §2.4 sub-range arguments, `RUST_ADOPTION_CANDIDATES.md` L1 | `View(T, p)`: `&(xs, p)` + range, zero-copy, `len` + `Index` projections, a `for` source | `&[T]`, Swift `Span` |
| §2.2 `fn words(&self) -> Vec<&str>` | `words(self : &Doc) -> ArrayList(&(View(u8), self))` | `Vec<&'a str>` |
| §5.1 borrowing iterators, adapter chains | `iter(self : &Self) -> Cursor(T, self)` with `next(self : &mut(Cursor(T, p))) -> Option(&(T, p))`; adapters as inline structs holding the cursor | `impl Iterator<Item = &'a T> + 'a` |
| §4.5 the entry API | `entry(self : &mut(Self, p), k) -> Entry(K, V, p)`; `or_insert(self, v) -> &mut(V, p)` | `Entry<'a, K, V>` |
| §3.2 guards | `lock(self : &mut(Self, p)) -> LockGuard(T, p)` with `Drop` unlocking | `MutexGuard<'a, T>` |
| §3.5 sinks | `Serializer(out : &mut(StringBuilder, p), depth : usize)` | `Serializer<'a, W>` |
| §4.4 `Cow` | `StrArg :: enum(Borrowed(s : &(String, p)), Owned(s : String))` | `Cow<'a, str>` |
| §2.4 parser remainders | `parse_int(input : View(u8, p)) -> Result(((View(u8, p), T)), ParseError)` | nom's `IResult<&str, T>` |
| §3.4 two-phase loans | `begin(self : &mut(Self, p)) -> Txn(S, p)` | `Loan<'a>` |
| **storage behind owning pointers and shared cells** | `Box(View(T, p))`, `RefCell(&(T, p))` — the old E0909 wall | `Box<&'a T>` |
| **mutable cyclic graphs without runtime marks** | `Rc(Node(T), p)` (O9, gated) | `GhostCell` / `RefCell` |

Not unlocked, on purpose: a reference across threads, a reference in an
`extern` signature, a self-referential value (O5). They keep their catalog
answers (`RUST_REFERENCE_PATTERNS.md` §14).

## 4. What it costs — and why the checker is not Rust's

The maintainer's question on adoption (2026-10-19) was whether this makes
Yo's borrow checker as hard to implement as Rust's. It does not; the
difficulty moves into places Yo already has machinery:

| Rust's cost | Yo's corresponding mechanism |
| --- | --- |
| region-variable solving (NLL constraints, the Polonius class of accept problems) | none — after substitution an origin is a ground set of places; "do these conflict" is lookup, not constraint solving. Rust's accept problems were artifacts of regions being abstract |
| variance and the subtyping lattice | one rule: subset coercion into a declared union (O3-3) |
| higher-ranked trait bounds (`for<'a>`) | none — an origin parameter is an ordinary generic parameter, instantiated at application like `T` |
| lifetime elision interacting with closures and traits | four stated defaults (O2), each checked against the body |

What actually remains to build:

- **Evaluator / checker.** The `TypeValue.Reference(T, mutable, origin)`
  variant and the `Origin` kind through the evaluator, specializer,
  verifier encoding and codegen — still the largest refactor in the plan,
  and unchanged in size by this amendment (it was step 1 before, it is
  step 1 now). The checking itself is application + set intersection +
  liveness; the per-value root-joining tracker of the superseded R7 — the
  one genuinely new analysis that design needed — is **deleted**, replaced
  by declared unions read off types.
- **Parser.** The `&(T, p)` pair with its kind-directed disambiguation;
  `generic(p : Origin)`; `Fn(...)` types with origin parameters. The
  `depends` zone is never built — a net deletion relative to the
  superseded design.
- **Diagnostics.** Every origin error names the two sets and the places in
  their intersection or difference; `yo doc` prints elided defaults (§7).
  New error codes: the self-origin well-formedness rule, the
  no-origin-position escape, the return of a local origin, the
  await-point rule, the union-violating push.
- **Tooling.** `yo fix` proposes widened unions; LSP hover shows a value's
  origin set; signature help shows a call's origin substitution.
- **Seed gating.** Generation A lands the kind, the parse and the rules in
  user code; the tree and std convert on the next seed (Generation B), as
  every phase of this plan does.

## 5. Soundness argument

**The invariant (I1):** every live reference's origins resolve to places
whose owners are still alive, and every live `&mut` is exclusive over the
places its origin names. The mechanisms, and the escape routes they close:

1. **Through a return** — the return rule restricts result origins to
   origin parameters and reference-typed parameters' places; sound by
   induction on the call stack (a lent place's owner is the caller, one
   frame up — a by-value parameter's slot is the callee's own and is
   rejected as a local's), with the
   caller freezing the substituted places until the result's last use.
2. **Through storage** — origin parameters propagate through type
   application, so storing a reference-holding value grows the storing
   type's origin set by construction; a place write checks the subset
   relation (O3). There is no tracker to fall out of sync with the type.
3. **Through a copy** — copies carry identical origins (all-`&` values are
   `Copy`); a `&mut`-holding value is move-only, so two exclusive borrows
   cannot exist.
4. **Through a closure** — capture entries spell origins into the
   closure's type; a slot's parameters subsume the literal's (coercion);
   an escaping closure's capture and a `Dyn` payload are no-origin
   positions (E0909).
5. **Through an unknown callee** — a `Dyn`/function-value call is checked
   from the signature it dispatches on (traits carry origin parameters;
   every impl was checked against them); an `extern` takes no origins.
6. **Through a move or drop of a root** — moves and drops are accesses
   (decisions 18, 38 A); a drop that uses no root keeps its std obligation
   (O3).
7. **Through self-reference** — unrepresentable (O1's well-formedness
   rule); this is also what removes any need for `Pin` (O5).
8. **Through C, a thread, or a module-level binding** — no-origin
   positions, structural.

**Over-approximation is the safety margin, never a hazard:** declared
unions over-freeze (a container holding only `x`-borrows still freezes
`y`), elided defaults over-freeze, and disjointness is never guessed — it
is a contract the verifier discharges (`get2_mut`). Incompleteness here is
the deliberate trade for checkability; unsoundness would require a place
entering an origin set without passing through a spelled or defaulted
position, and every such position is one of the eight above.

**`Rc(T, p)`:** clones share `p` by construction (the type parameter is
copied with the clone); a write projection needs exclusivity over `p`, so
any live use through any clone conflicts by set identity. The refcount
keeps the payload alive; the collector handles cycles; leaks stay
possible — the cycle collector keeps that job
(VALUES_BY_DEFAULT §3.12).

**Async:** the state machine's stored references point only at the
caller-frame places named by `p` (A2), which the await/spawn site freezes
for the future's life; body-local origins at an `await` are rejected
(O8), so no pointer into the machine itself can exist (O5).

The **negative-test corpus is written before the rules land** (N0) and
includes, beside the superseded design's rows restated in origin terms: a
binding whose type names its own place; a type naming its own field; a
result naming a local's origin **or a by-value parameter's own place**
(E0912's rule); a push outside the declared union; a
`Box`/`RefCell` carrying origins crossing a `Send`/spawn/`extern`/
module-level position; an elided `push` signature with unrelated fresh
origins (the body check must reject it); a live body-local origin at an
`await`; a `Rc(T, p)` write beside a read through another clone; a clone
stored where `p` is out of scope; sibling sub-loans misused (a second
`get2_mut`-style call on the same base while the first pair lives);
`swap` on referents of different origin types (a type error); a closure
literal whose captures exceed a slot's origin parameters. Positive
controls mirror them, `words` and `get2_mut`'s pair among them.

## 6. Alternatives considered

| Alternative | Verdict |
| --- | --- |
| Rust's lifetimes (`'a` as abstract regions, outlives, variance, HRTB) | **still rejected as regions** — the solving, the variance and the error-at-a-distance are what §4 refuses; the names-in-types half is now adopted as origins, which are ground place sets, not region variables |
| Mojo's origins (`ref [origin]`, parametric, inferred) | **adopted in modified form** — parametric origins with explicit spelling at contracts and checked defaults elsewhere; no inference at semantic distance |
| Austral's regions | **adopted in modified form** — declared and explicit; its linear types stay rejected (affine moves + `Drop` are lighter) |
| the 2026-10-13 `depends`-clause + root-joining-tracker design (this file's predecessor) | **superseded** — the clause grammar, its `Fn(...)` subtyping order and its per-value flow tracker (the design's one new analysis) all collapse into parametricity and declared unions (O7, O6); the mapping table shows nothing lost |
| inferring a callee's borrow behaviour from its body | still rejected — the contract would live in the body; an edit inside one function silently changes what callers may do, and a body edit re-checks every caller (the incremental checker) |
| proving element disjointness inside the borrow checker | still rejected — a second, weaker prover beside the verifier; disjointness is a `requires` (R4) |
| Ante's unstable-place invalidation (`!` — mutation kills outstanding borrows) | **rejected** — it contradicts "`&` means unchanged" (§3.10), which the verifier's alias reasoning leans on; Yo freezes the base instead, and last-use liveness already legalizes the stale-view-then-mutate patterns |
| Ante's shared-mutable `ref`/`mut` kinds (exclusivity dropped single-threaded) | **rejected** — Yo keeps exclusivity everywhere and buys shared mutation through `Rc(T, p)` (O9) at root granularity instead |
| Ante's body-inferred `Mutate` effect | **rejected** — signature-based checking keeps `Dyn` dispatch, effect handlers and the incremental checker sound; Ante's own handler interaction is their experimental part |
| elision-only surface (no explicit `Origin` kind) | **rejected** (maintainer, 2026-10-19) — LLM authorship wants contracts explicit; the failure mode of explicit systems is a local declaration mismatch, of implicit ones a distant inference surprise |

Adopted from the post beyond the foundation: the `Rc` place parameter (O9),
union places (O1), place paths (§7, phased). Already Yo's by other means:
the no-Polonius claim (last-use liveness), `Send`/`Sync`, leaks as a
collection concern.

### Compared with Mojo, the other origin system

Mojo's origins (`ref[o] a : A`, `origin_of(x)`,
`Pointer(T, origin=...)`) are the closest relative, and the differences
are deliberate:

| | Mojo | Yo |
| --- | --- | --- |
| what an origin is | the one owning variable a value came from — a singular provenance token, split into `ImmOrigin`/`MutOrigin` kinds | a **set of places** (parameter places, spelled unions `(p, q)`, later field paths); mutability lives in the reference (`&`/`&mut`), not in the origin kind |
| who writes it | the compiler, transparently; a user writes it around pointer indirection, and `origin_of(x)` recovers one | the author, at every contract (`generic(p : Origin)`, `&(T, p)`), because Yo is written by LLMs; elision is four stated defaults the checker verifies |
| where it attaches | the argument-convention system (`ref[o]` beside the borrowed/mut conventions) and `origin=` slots on `Pointer` | the type itself: a reference is a type taking the origin as a trailing argument, uniform in every type position, container and cell |
| storage | a struct gains an origin parameter and threads it into each `Pointer`'s `origin=` slot | any composite or cell gains the origin parameters of its fields' types (O4) — the same capability with no per-pointer slot |
| what it drives | lifetime tracking and eager destruction at last use | the freeze/exclusivity checks (O3); Yo's last-use liveness is decision 18's and its drops decision 45's — both independent of origins |
| shared mutation | not covered by origins | the gated `Rc(T, p)` (O9 — from Ante, not Mojo) |

Both reject Rust's region machinery — no outlives lattice, no variance, no
higher-ranked bounds — and both make checking parametric. The name is
shared; the shape is not: Mojo's origin is singular provenance the compiler
writes, Yo's is a declared place set the author writes.

## 7. Open questions, with positions

- **Field-path origins and the access clause.** `self._buf` as an origin
  value, legal exactly where the path is (an `_`-prefixed field inside its
  private scope, `plans/reference/MEMBER_VISIBILITY.md`), with the
  companion access clause (`len` reads only `self._len`) that makes
  outside callers gain from the narrow borrow. A field path must root at
  a reference-typed parameter or an enclosing binding, never at a
  by-value parameter's slot — the callee-frame principle of O1/O3 and
  §5 route 1 covers field paths too. Positions unchanged from
  the superseded design: the scoping rule may land once the base does; the
  access clause waits for a counted need. Ante's convergence here (their
  motivating examples are the same cases) is a soft data point, not a
  counted need.
- **`Dyn` payloads with origin parameters.** Position: not initially — a
  no-origin position; revisit when a trait-object shape that borrows is
  asked for by a counted need (the catalog's §14 residue).
- **Module-level origins.** A global's place as an origin is well-formed
  (`&(ArrayList(i32), COUNTS)`), and decision 18 rule 3 (no call or
  `await` in the live range) is the checking rule; the open question is
  whether a module-level *binding* may carry origin parameters at all.
  Position: no, initially — no frame owns the roots.
- **`[T]` as a builtin or `View(T, p)` in std.** Position: std first,
  decided in L1's PR, unchanged from the superseded design.
- **`yo doc` printing elided defaults.** Position: yes, so a reader sees
  the effective origins without reading the body.
- **Comptime origin algebra.** `overlaps(p, q)` as a comptime predicate
  usable in `where(...)` (a static aliasing precondition) and the
  verifier consuming origins as its alias relation (admitting
  origin-carrying `Rc` into proofs). Position: the kind lands first; both
  wait for their consumers to exist.
- **The `&(A, B)` parse fallback.** The named slot `&(i32, origin : p)` is
  reserved if kind-directed disambiguation proves friction. Position: not
  adopted; the rule is stated in this document and will be stated in the
  syntax documentation when N1 lands it.

## 8. Phases

| Phase | Lands | Gate |
| --- | --- | --- |
| N0 | the negative-test corpus written and failing | the tests fail for the right reason |
| N1 | the `Origin` kind and `TypeValue.Reference(T, mutable, origin)` (behavioral identity: every test, the fixpoint, an emit-diff with no C change); Generation A: the `&(T, p)` parse, `generic(p : Origin)`, the elision defaults, O3's checking rules (freeze/exclusivity by origin, the return rule, place writes), `.*`/auto-deref/auto-borrow, `impl(&T, ...)`, `FnMut`. The storage wall stays as it is today — origins are vocabulary and checking, first-class storage waits for N2, so no build accepts an escape it cannot see | the corpus minus its storage rows, the fast suite, fixpoint |
| N2 | first-class storage: O4's table — cells and containers carry origin parameters, E0909 becomes the no-origin-position rule, O6's declared unions with the widening `yo fix` | the storage rows of the corpus |
| N3 | std and `src/` adopt (Generation B, on the next seed): `iter`, `slice`, `entry`, the borrowed `for` by `impl(&C, IntoIterator)`, the `FnMut` slots, the `Future(T, p)` spelling replacing A2's registry | the catalog's rewritten sections; CP0's rows for `slice` and `sort` |
| N4 | `Rc(T, p)` (O9), gated on the counted need: the census sites that can prove exclusivity migrate off `RefCell` | the `Rc` rows of the corpus; the decision-46 census counts as the adoption metric |

After decision 42's Generation B and V2b, as before; each phase is one PR
or one stack with one battery, per AGENTS.md. The ctl-handler open point
and the `.*` / `str` decisions recorded under "Decision 43" in
`plans/VALUES_BY_DEFAULT.md` §6 carry over unchanged.
