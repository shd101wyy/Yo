# References as first-class types with origins: the `Origin` kind, `&(T, p)`, and declared place sets

**Status: BACKLOG — the design of VALUES_BY_DEFAULT decision 43, amended
2026-10-19 by the maintainer: references become FIRST-CLASS types
parameterized by origins.** (This file was `NON_ESCAPABLE_TYPES.md` until
2026-10-20; the old name described the second-class design, and
"non-escapable" is now one bound, O10. `git log --follow` carries the
history.) An origin is a named set of places — a new
comptime kind beside `Type`, spelled `p : Origin` in `generic(...)`, and a
trailing argument of the reference types: `&(T, p)`, `&mut(T, p)`. Yo keeps
mutable value semantics for owned values (decision 42's spelling; decisions
18, 24, 25, 28, 33, 35, 37, 38, 47 unchanged) and keeps the freeze model —
`&` means unchanged, `&mut` exclusive — but a reference, and any type
containing one, may now stand anywhere its origins can follow, storage
included. The second-class caste of the 2026-10-10 decision becomes one
structural predicate: **this position accepts no origin parameters** (E0909
restated; the positions are §2 O4's list, the bound behind them O10's
`Escapable`, decided 2026-10-20). This amendment supersedes the
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
reference-holding value in a `Box` or a `RefCell` payload, behind an
owning pointer — the shapes the second-class wall (E0909) refused
outright —
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
| the borrowed `for`; the pin on an `Rc`-rooted container | §3.10, decision 39 | unchanged as a rule (a loop, not a value); its lowering moves to `impl(&C, IntoIterator)` at N3 |
| a future may borrow when rooted at the body's `&`/`&mut` parameters | §3.13 A2 | the origin spelling of the same rule (O8); A2's wrapper-id registry is replaced by type-carried origins |
| `Rc` is read-only through the handle; the three doors | decision 46 | unchanged; a `&` borrow through a handle's deref carries the handle's place (O9), a `&mut` through one stays E0919 |
| `mut(G)`/`mut(x)` markers | decision 47 | unchanged; a marker grants writability of a binding, an origin names the places a borrow touches — orthogonal facts |

## 2. The design

### O1. The `Origin` kind and the reference types

`Origin` is a comptime kind beside `Type`: a value of the kind is a **set of
places**. Reference types take it as a trailing argument.

```yo ignore
// a function abstract over an origin:
next :: (fn(generic(T : Type, p : Origin), self : &mut(Cursor(T, p))) -> Option(&(T, p)))(...);
// a type constructor binding one (the comptime fn's parameter list grows by the kind):
Cursor :: (fn(comptime(T) : Type, comptime(p) : Origin) -> comptime(Type))(
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
- **A phantom origin parameter is legal.** A type constructor may declare
  `p : Origin` and use it in no field — Rust's `PhantomData<&'a T>` — so
  a `Copy` handle can be tied to an owner it does not point into:
  `Id(T, arena)` is an index that cannot outlive `arena` (the
  generational-arena harvest of `LIFETIME_REPLACEMENT_PATTERNS.md` §8
  becomes a type, 2026-10-20).
- **Origins are comptime values.** `TypeInfo` gains the `Origin` kind
  beside `Reference(T, mutable, origin)`; reflection reads them. Comptime
  algebra over them (an `overlaps` predicate for `where(...)` aliasing
  preconditions) is an open question (§7), not part of the first phases.
- **Codegen erases origins.** A reference is a `const T*` / `T*`; a
  reference-holding struct is a plain C struct of pointers, `RawSlice`'s
  shape; no count traffic, no header, no runtime mark. The only runtime
  borrow state in the language remains `RefCell`'s (§3.10).
- **Origins are erased from every identity but the checker's** (added
  2026-10-20, review of #1483). Two types that differ only in their origin
  arguments are ONE type for specialization (the memo and `type_key` keys
  V4 rebuilt in #1329, the clfid keys of `create_specialization_at_call`),
  for C type identity, for trait coherence (`impl(&(T, p), Tr)` quantifies
  over every origin; an impl may not name a concrete place) and for
  reflection equality (`type_of(&x) == type_of(&y)`); they differ only for
  the borrow checker. Without this rule every `f(&x)` / `f(&y)` pair would
  mint a specialization and `ArrayList(&(T, x))` and `ArrayList(&(T, y))`
  would be two C structs. Rust does the same: monomorphization sees erased
  regions.
- **The empty origin.** A borrow that names no place — `str`'s view of
  static bytes (decision 36), a lend of a never-written module-level
  binding (decision 47: an unmarked module-level binding is never
  written after its initializer) — carries the empty set. The set
  algebra needs nothing new for it: `∅ ⊆ p`, so such a reference coerces
  into every origin position that widens — the covariant positions of
  O3-3, not an origin behind a `&mut` — which is Rust's `'static`.

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
- **A `Fn(...)` type's elided parameter origins are per-call.**
  `f : Impl(Fn(&(T, q)) -> &(U, q))` with `q` elided is a fresh origin at
  EVERY call of `f`, universally quantified: a closure literal in that slot
  is checked with `q` rigid (abstract), so it may not return a captured
  `&(U, y)` (`y ⊆ q` fails for an abstract `q`), and each call inside the
  callee instantiates `q` with that call's argument. This is what Rust
  spells `for<'a>`; Yo has it, always elided, never spelled (§4's table
  says so).
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
2. **Conflict is a loan against an access, by origin intersection.** A
   `&mut(T, p)` live (decision 18's live ranges) conflicts with any
   **access** to a place in `p` — a read, write, move, drop, or the taking
   of a new borrow of that place **by name** (E0911); a `&(T, p)` conflicts
   with a write, move or drop of one; two `&mut` arguments of one call with
   intersecting origins are E0910 (decision 28 restated); reads of `p`
   coexist with `&` loans — Ante's use-vs-mention distinction falls out of
   set algebra without an effect system. **The checker never compares two
   reference values to each other** (restated 2026-10-20, review round 2;
   the first text read as "two live `&mut` over one origin conflict", which
   made `iter_mut` items and `get2_mut`'s pair need an exception): holding
   two `&mut(T, p)` is not a conflict, obtaining a second one by an access
   to `p` is. A write through a reference is an access to its referent,
   not to `p`'s other paths. This is Rust's rule exactly, and it carries
   Rust's division of labour: safe code cannot manufacture two overlapping
   `&mut` into one place without an access conflict in its own body, so a
   call that lends `&mut xs` once and returns several `&mut(T, xs)` is
   accepted by construction, and the disjointness of what it returns is the
   **callee's** obligation — a safe callee is checked by this same rule, an
   `AllowUnsafe` std body (`get2_mut`, `split_at_mut`, a `&mut` cursor's
   `next`) carries it as a `requires` or an invariant, as Rust's `unsafe`
   does.
3. **Coercion is subset — in covariant positions only.** `&(T, p)` coerces
   into `&(T, (p, q))` (widening a union) and into a fresh-elided
   parameter's position; so does the OUTER origin of a `&mut(T, p)`, a
   `&`'s pointee, a result and an owned composite's field. **An origin
   reached through a `&mut` pointee, a `RefCell` payload or a `&mut`
   capture is invariant: it unifies exactly and never widens** (added
   2026-10-20, review of #1483 — the first text said "nothing else
   coerces; there is no variance lattice", one rule short). The hole it
   closes:

   ```yo ignore
   store :: (fn(generic(T : Type, r : Origin), dst : &mut(Option(&(T, r))), v : &(T, r)) -> unit)(dst.* = .Some(v));
   x := i32(1);
   mut(slot) := Option(&(i32, x)).Some(&x);
   {
     y := i32(2);
     store(&mut slot, &y);   // r := x from dst, so `&y : &(i32, y)` fails `y ⊆ x`: error.
   }                         // Were `&mut slot` allowed to widen to `&mut(Option(&(i32, (x, y))))`,
   slot                      // r := (x, y) would type and `slot` would hold `&y` past y's drop.
   ```

   A method call is safe by step 1 already (the receiver fixes the origin
   arguments before the other arguments are matched); the rule matters for
   free functions and for any `&mut`-lent argument whose origin a second
   argument would otherwise widen. These two rows are the whole subtyping
   story — no variance lattice beyond them.
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
- **Several `&mut` out of one lend** (step 2's consequence, no longer an
  exception): `get2_mut(&mut xs, i, j)` returns two `&mut(T, xs)` and
  `it.next()` on a `&mut` cursor returns a fresh `&mut(T, xs)` each call
  while earlier items are still held, because neither accesses `xs` by
  name again — `xs` is lent once, exclusively, for as long as any of them
  lives. The disjointness is the callee's: `requires(i != j)` on
  `get2_mut` (the verifier discharges it; the body's safety assert stays
  in every build), a monotone cursor index for `next`. A second
  `get2_mut(&mut xs, …)` while the first pair lives IS an access to `xs`
  and is E0911.
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
| cells — `Box`, `RefCell`, `Dyn`, an escaping closure's capture, a spawned value | **`Box`, `RefCell` and `Dyn`: yes** (the pointer points outward; moving the cell moves the pointer, never its target — O5). `Dyn(Trait, p)` admits a payload whose origins are within `p` (Rust's `Box<dyn Trait + 'a>`), and `Dyn(Trait)` written without an origin is `Dyn(Trait, ∅)`, an `Escapable` payload (O10) — decided 2026-10-20, it was "initially no". An escaping closure's capture is the same thing: a closure whose capture list carries origins stands wherever they follow, including in a `Dyn(Fn(...), p)`. **Spawn: no** (E0909) |
| `Send` values, thread boundaries | no — structurally: a type with origin parameters is not `Send` |
| module-level bindings | no, initially (§7) |
| `extern` signatures | no — FFI takes raw pointers, the existing unsafe boundary |
| self-referential (an origin naming the value's own fields or its own place) | never — the well-formedness rule of O1 |

E0909 is restated: **"this position accepts no origin parameters"** — one
structural check off the type, replacing the per-position enumeration of the
second-class wall; the bound a generic body writes to satisfy it is O10's
`Escapable`. A `Box(&(T, p))` is legal wherever `p` is in scope; a
`RefCell(&(T, p))` legal beside it (the cell's dynamic marks govern the
payload's mutation, the origin governs the borrow — orthogonal); a
`Dyn(Trait, p)` payload may carry them; an `Rc`/`Arc` payload accepts
none (O9's second rule, for the collector's reason).

### O5. No self-reference, therefore no `Pin`

Rust needs `Pin` because a value can contain a pointer into itself (an
async generator holding a borrow of its own saved local across an `await`),
so moving the value after construction would dangle the pointer. Yo's
design makes that state **unrepresentable**:

- A **declared** type — a signature, a type definition, a binding's
  spelled type — may only name places that exist **before** the value:
  parameters, enclosing bindings, earlier origins. A type definition cannot
  name its own fields and a binding's type cannot name its own place (O1's
  well-formedness rule). Every reference inside a value points **outward**,
  at a place owned by an enclosing frame. Inside a body, a flow-inferred
  set (O2) may come to hold a place declared LATER in the same or an inner
  scope (`out := ArrayList(&i32).new(); x := i32(5); out.push(&x);`); what
  keeps that sound is liveness, not scoping — a drop is an access
  (decision 18) and bindings drop in reverse declaration order, so `x`'s
  scope-end drop while `out` is still used is E0911, and `out`'s own later
  drop is O3's `may_dangle` obligation (made precise 2026-10-20, review of
  #1483; the first text stated the "exists before" rule for every origin,
  which O2 and O3 contradicted).
- Moving a value therefore never dangles anything it contains: the pointers
  aim at other frames' storage. This is the same trade Hylo and Swift make,
  and the same position the second-class design already had — nothing is
  lost relative to the landed baseline, and the escape it names is the
  existing one: a self-referential struct is not writable in safe Yo at all
  (Rust can, with `Pin` and `unsafe`).
- **Async.** §3.13 A2 already restricts what a borrowing future carries
  OUT of its body to borrows rooted at the body's `&`/`&mut` parameters;
  the origin spelling is `Future(T, p)` with `p` those parameters' places.
  The body's **own locals** are a different matter (corrected 2026-10-20,
  review of #1483 — the first text rejected a body-local borrow live at an
  `await`, which is legal today: an `io.async` body that lends `&mut c` of
  its own local `c` to an inner future and awaits it checks, compiles and
  runs under v0.2.66). They live in the state machine, which is HEAP
  storage allocated at `io.async` and never relocated (decision 40's
  invariant; `docs/en-US/ASYNC_AWAIT.md`), so a borrow of one across an
  `await` is an ordinary intraprocedural borrow (decision 18) over a
  stable place; it never reaches the future's type, because `Future(T, p)`
  names only what the body captures from the caller. The machine does
  contain pointers into itself in Rust's sense, and that is harmless for
  the reason decision 40 gives — a cell moves by its handle, never by its
  bytes. No `Pin`, no address-stability reasoning, no projection-safe
  move analysis.
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

- **Which set freezes** (made precise 2026-10-20, review of #1483): the
  declared union is the type-level BOUND — every stored origin must be a
  subset of it, and a callee receiving the container through `&mut` with
  the union abstract treats the whole union as frozen in the mode of the
  element reference. The LIVE freeze in a body is the flow-inferred actual
  set (O2): the places that have entered the container, unioned over
  reaching definitions, from the point each enters until the container's
  last use. The declared union itself freezes nothing — otherwise
  `both.push(&mut x)` would conflict with `both`'s own exclusive hold over
  `x` and no `&mut` could ever be pushed.
- Growth and reallocation are irrelevant to soundness: the elements are
  pointers and their roots are frozen (`&`) or exclusively borrowed
  (`&mut`) from entry to the container's last use (the elements never move
  within their buffer in a way the references could miss — realloc copies
  pointers, not referents).
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
  result positions; a `Dyn(Fn(...), p)` holds a closure whose captures'
  origins are within `p` (O4).
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
- **At an `await`:** a borrow of a body-local place may be live across
  it — the local sits in the heap state machine (O5, decision 40); no new
  rule. Module-level places follow decision 18 rule 3 (no call or `await`
  in the live range), now visible in the type as the named global.
- An origin-carrying type is not `Send` (structural), cannot be spawned,
  cannot be captured by an `io.spawn` body. `Arc` stays origin-free and
  read-only across threads (decision 46, D3).

### O9. `Rc`/`Arc`: read-only, borrowable through the handle, never carrying origins inside

Decision 46 is the rule and the amendment leaves it intact (maintainer,
2026-10-20: Rust's split makes sense — the runtime exclusivity check
happens on `RefCell` only, and `Rc` stays read-only like Rust's). Two
consequences, one relaxed on 2026-10-20 (review round 2) to Rust's rule:

- **A `&` borrow through a read-only handle's deref has the handle's
  place as its origin** — `&h.*.x : &(X, h)`, `View(T)(xs : &h.*.items)`
  and `out.push(&h.*.x)` are legal, and `h` is frozen (not dropped,
  moved or reassigned) while the borrow lives. This is Rust's
  `let r = &*rc;`, and it is sound for the same reasons: the payload is
  never written through a handle (decision 46; a `&mut` lend through an
  `Rc`/`Arc` deref stays E0919), `Rc.get_mut`/`make_mut` take
  `h : &mut Rc(T)` and so conflict with the freeze, the frozen handle
  cannot be dropped, moved or reassigned, so its strong count is never
  decremented while the borrow lives — the payload is therefore neither
  freed nor a collection candidate (the collector considers only objects
  whose count was decremented, `CYCLE_COLLECTION.md`) — and heap storage
  never relocates (decision 40). The
  first text kept R5's "no origin crosses an `Rc`/`Arc` deref; hold the
  handle and re-derive at each use", whose reason — a plain `Rc` holds no
  marks for a borrow to take — was the pre-decision-46 model, and the
  §3.13 A2 predicate `handle_payload_is_read_only` already made exactly
  this move for borrowing futures (#1421). The borrowed `for` over an
  `Rc`-rooted container keeps its pin until decision 39 is revisited on
  the same ground.
- **`Rc(T)` and `Arc(T)` payloads accept no origin parameters** —
  `where(T <: Escapable)` (O10). Rust allows `Rc<&'a T>`; Yo does not,
  and the reason is the cycle collector, not the borrow model: a leaked
  cycle in Rust never runs `Drop`, while Yo's collector runs the
  payloads' drops at an unbounded later time (`CYCLE_COLLECTION.md`,
  CollectWhite), after the places an inner reference names may have
  died — a user `Drop` on such a payload could dereference a dead place.
  `Box` and `Dyn` have one owner and die at a known point, so they may
  carry origins; a counted cell may not. A plain `Rc` carries no borrow
  marks (decision 41) and costs what Rust's `Rc<T>` costs (CP2d).
- **Shared mutation keeps the three doors**: `RefCell(T)` in the payload's
  type — the one spelling of the dynamic exclusivity check, unchanged —
  `Rc.get_mut` (`.None` unless the count is 1) and `Rc.make_mut`
  (clone-on-write). A `RefCell` payload may itself hold a reference
  (`RefCell(&(T, p))`, O4): the marks govern the payload's mutation, the
  origin governs the borrow — orthogonal. A borrow INTO a `RefCell`'s
  payload goes through its guard and carries the guard's place.
- **Mutable cycles** stay `Rc(RefCell(Node))` with the runtime check, as
  in Rust and as today; immutable cycles stay plain `Rc` plus the cycle
  collector. The `Rc(T, p)` extension that would have made cycles
  writable without runtime checks was considered and rejected — §6's row
  records why.

### O10. `Escapable`: the no-origin positions as a bound

Decided 2026-10-20 (the maintainer delegated the point raised by the
review of #1483; the alternatives are in §6).

- **`Escapable` is a prelude marker trait, structurally derived like
  `Send`** (§3.8): a type holds it iff it carries no origin parameters.
  `&(T, p)`, any type containing one, a borrowing closure and a borrowing
  future are not `Escapable`; `Send` implies `Escapable`. `TypeInfo`
  answers it from the origin list; no impl is ever written by hand.
- **O4's no-origin positions are where the language requires it.** The
  payload parameter of `Rc`, `Arc` and `Dyn`, `io.spawn`'s task, an
  `extern` signature and a module-level binding carry
  `where(T <: Escapable)`; E0909's message is "this position requires an
  `Escapable` type; `X` carries origin `p`".
- **No implicit bound.** A `generic(T : Type)` parameter admits
  origin-carrying arguments by default, exactly as it admits non-`Send`
  ones: the restrictive contract is the one spelled, and the permissive
  default costs nothing because every other position propagates origins
  structurally (O4). Yo checks a generic body per instantiation (the
  evaluator defers a `generic(...)` body to call time), so the bound is
  what makes the error local: with `where(T <: Escapable)` on `f`, a
  caller's `f(&x)` fails at that call against `f`'s signature; without
  it, the specialization fails inside `f`'s body at the `Rc(T)` with the
  instantiation trace — the same shape as any missing trait bound in Yo
  today — and `yo fix` proposes the bound. `Rc`, `Arc`, `Dyn` and
  `io.spawn` carry it themselves, so `Rc(&(X, x))` always fails at the
  user's call naming `Rc`'s bound (corrected 2026-10-20: the first text
  said "at the declaration", which is Rust's abstract check, not Yo's).
- **Rust has this bound: it is `T : 'static`** — "`T` holds no reference
  shorter than the program", required by `thread::spawn`, implied by
  `Box<dyn Trait>` (`+ 'static` by default). Swift spells it `Escapable`.
  Yo needs it for the same positions and the same reason, and names the
  property rather than the lifetime.
- **Why not Swift's split** (implicit `Escapable`, `~Escapable` opt-in):
  Swift's default exists for source compatibility of pre-existing
  generics, which Yo has none of; a suppressed conformance is a negative
  bound Yo has no precedent for; and counted over std, the positive bound
  is written at a handful of cell constructors, spawn and the globals,
  where the opt-in would be written on every container, view and
  adapter. Rust's `T : 'static` is the same shape and reads the same way.

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
| **storage behind owning pointers and dynamic cells** | `Box(View(T, p))`, `RefCell(&(T, p))` — the old E0909 wall | `Box<&'a T>` |
| §5.2 collecting `iter_mut` items, `split_at_mut` | `ArrayList(&mut(T, xs))` filled from a `&mut` cursor; `split_at_mut(&mut xs, mid) -> (&mut(View(T), xs), &mut(View(T), xs))` (O3 step 2) | `Vec<&mut T>`, `split_at_mut` |
| §7.2 / §8 `Box<dyn Fn(&Event) + 'a>`, `Box<dyn Iterator<Item = &T> + 'a>` | `Dyn(Fn(Event), p)`, `Dyn(Iterator(Item := &(T, p)), p)` (O4) | `dyn Trait + 'a` |
| §4.1 / §5.1 a view or cursor into an `Rc`-held value | `&h.*.items : &(ArrayList(T), h)`, `h.*.items.iter()` with the handle's place as origin (O9) | `let r = &*rc;` |
| §4.6 a typed handle tied to its owner | `Id(T, arena)` by a phantom origin parameter (O1) | `PhantomData<&'a T>` |

Not unlocked, on purpose: a reference across threads, a reference in an
`extern` signature, a reference inside an `Rc`/`Arc` cell (O9), a
self-referential value (O5), mutable cycles without a runtime check
(`Rc(RefCell(Node))`, as Rust). They keep their catalog
answers (`RUST_REFERENCE_PATTERNS.md` §14, rewritten 2026-10-20 with
§3.1's verdicts).

### 3.1 Against Rust: what each expresses that the other does not

Audited 2026-10-20 (the maintainer's question "is there anything Rust can
express but Yo cannot, and can we fill the gap?"). The frame: Rust's
lifetime is an abstract region solved by constraints, Yo's origin is a
ground set of caller places substituted at the call; every Rust check has
a Yo mechanism — NLL liveness is decision 18, two-phase borrows decision
28, reborrows decision 43, `T : 'static` is `Escapable` (O10), variance
is O3-3's one invariance rule, `for<'a>` is O2's per-call origin, `'a: 'b`
is subset coercion into a union, `'static` is the empty origin.

| Rust can write | Yo | Verdict |
| --- | --- | --- |
| `Vec<&mut T>` out of `iter_mut`, `split_at_mut` | `ArrayList(&mut(T, xs))`, two `&mut(View(T), xs)` | **filled 2026-10-20** — O3 step 2 compares loans to accesses, never two reference values (the first text did) |
| `let r = &*rc;` held across calls | `&(X, h)` with the handle's place as origin | **filled 2026-10-20** — O9, sound under decision 46 |
| `Box<dyn Trait + 'a>`, `Box<dyn Fn(&E) + 'a>` | `Dyn(Trait, p)` | **filled 2026-10-20** — O4; `Dyn(Trait)` is `Dyn(Trait, ∅)` |
| `PhantomData<&'a T>` | a phantom origin parameter | **filled 2026-10-20** — O1 |
| `let r = &make();` (temporary lifetime extension to the block) | rejected today ("a root that is a temporary") | **fills at decision 18's phase** — §7: the temporary is bound to a hidden local of the enclosing block, Rust's rule |
| `Rc<&'a T>` | `Rc(T)` requires `T <: Escapable` | **stays closed** — the cycle collector runs drops at an unbounded later time (O9); Rust escapes only because leaked cycles never run `Drop` |
| `thread::scope`, rayon over a local `Vec` | none: a borrow is never `Send` | **parked on decision 43's trigger 2** — the fill is a scoped spawn whose join is structural, with origins ⊆ the scope's lent places and `Sync` for `&`; a parallelism-runtime design, not a borrow-model one |
| `type Item<'a>` (GATs) for lending iterators | not needed: the elided `next(self : &mut Self) -> Option(&T)` IS the lending reading (O2) | **not a gap**; an associated type constructor over `Origin` for other GAT shapes is §7 |
| self-referential values via `Pin` + `unsafe` | unrepresentable in safe code (O5); `AllowUnsafe` raw pointers otherwise | **not a gap in safe code** — Rust's safe subset cannot either |
| `static mut` | `mut(G)`, a safe lend with decision 18 rule 3 (no call or `await` in the live range) | **Yo is safe where Rust is `unsafe`** — every access to a `static mut` is unsafe in Rust; the trade is the live-range restriction |

| Yo can write | Rust |
| --- | --- |
| a lending iterator with no GAT: `next(self : &mut Self) -> Option(&(T, self))` by elision | needs `type Item<'a>` |
| a borrow of an async body's own local across an `await`, with no `Pin` (O5) | `Pin` + the self-referential generator |
| field-path origins in a signature, once §7 lands them (`-> &mut(V, self._buf)`) | view types, an RFC |
| a projection (`-> &T` whose body yields a place, decision 24) checked without a region | the same thing spelled through lifetimes |
| a declared union read off the type (`ArrayList(&(T, (x, y)))`) with a local, deterministic error on a push outside it | region inference, an error wherever the regions meet |

After the fills, safe Rust and safe Yo express the same borrowing patterns
except lending stack data across threads, and Yo adds lending iteration
and (later) field paths for free.

## 4. What it costs — and why the checker is not Rust's

The maintainer's question on adoption (2026-10-19) was whether this makes
Yo's borrow checker as hard to implement as Rust's. It does not; the
difficulty moves into places Yo already has machinery:

| Rust's cost | Yo's corresponding mechanism |
| --- | --- |
| region-variable solving (NLL constraints, the Polonius class of accept problems) | none — after substitution an origin is a ground set of places; "do these conflict" is lookup, not constraint solving. Rust's accept problems were artifacts of regions being abstract |
| variance and the subtyping lattice | two rules: subset coercion in covariant positions; exact unification through a `&mut` pointee, a `RefCell` payload or a `&mut` capture (O3-3) |
| higher-ranked trait bounds (`for<'a>`) | present but never spelled — a `Fn(...)` type's elided parameter origin is universally quantified per call (O2), which is what `for<'a>` writes; a named origin parameter is an ordinary generic parameter instantiated at application like `T` |
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
  no-origin-position escape (and its generic form: the missing
  `where(T <: Escapable)` at a generic's declaration, O10), the return of
  a local origin, the union-violating push.
- **Tooling.** `yo fix` proposes widened unions; LSP hover shows a value's
  origin set; signature help shows a call's origin substitution.
- **Seed gating.** Generation A lands the kind, the parse and the rules in
  user code; the tree and std convert on the next seed (Generation B), as
  every phase of this plan does.
- **Every lowering is an escape route** (2026-10-20). The set algebra is
  the small part; the cost is applying O3 in every walk that creates or
  moves a value: macro expansions (`ExprInfo.macro_expansion`), closure
  capture structs, async state machines (captures and slots), effect
  handlers (`return`/`unwind`), `match` and `cond` arms, the specializer's
  per-instantiation bodies (Yo checks a generic body per specialization,
  so the checker runs per instantiation). A rule added to the evaluator
  without its closure-side and macro-side checks is silently swallowed
  there — the 2026-10 audits found 86 of 125 E0617 sites that way — so
  each phase's gate includes one corpus row per lowering.

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
   relation, and an origin behind a `&mut` or a `RefCell` is invariant
   (O3-3), so a callee cannot slip a wider origin into a place the
   caller's type does not cover. There is no tracker to fall out of sync
   with the type.
3. **Through a copy** — copies carry identical origins (all-`&` values are
   `Copy`); a `&mut`-holding value is move-only, so a copy never
   duplicates an exclusive loan. Two `&mut(T, p)` values MAY coexist
   (O3 step 2: a callee returned both out of one lend); what the rule
   forbids is any further access to `p` by name while either lives, and
   their disjointness is the callee's obligation — safe code cannot
   produce overlapping ones without an access conflict in its own body.
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
   positions, structural (`Escapable`, O10); a generic body cannot
   smuggle a `T` into one — the bound is checked at the call, and an
   unbounded `T` fails inside the specialization.

**Over-approximation is the safety margin, never a hazard:** declared
unions over-freeze (a container holding only `x`-borrows still freezes
`y`), elided defaults over-freeze, and disjointness is never guessed — it
is a contract the verifier discharges (`get2_mut`). Incompleteness here is
the deliberate trade for checkability; unsoundness would require a place
entering an origin set without passing through a spelled or defaulted
position, and every such position is one of the eight above.

**Shared cells:** a reference into a shared payload carries the handle it
went through (O9), and that handle is frozen while the reference lives —
so the payload cannot be freed (the handle's count is never decremented,
so it is neither dropped nor a collection candidate) and cannot be written through any
handle (decision 46; `&mut` through a deref is E0919). Mutation of a
shared payload happens only through `RefCell`'s dynamic marks (§3.10),
whose guard is the origin of any borrow into it. A payload never carries
origins of its own (`Escapable`), because the collector runs drops at an
unbounded later time. Leaks stay possible, as before.

**Async:** what a future's type names (`p`, A2) are caller-frame places
the await site freezes for the future's life; the body's own locals, and
the borrows among them, live in the heap-allocated machine that never
relocates (decision 40), so a pointer into the machine is a pointer into
stable heap storage (O5).

The **negative-test corpus is written before the rules land** (N0) and
includes, beside the superseded design's rows restated in origin terms: a
binding whose type names its own place; a type naming its own field; a
result naming a local's origin **or a by-value parameter's own place**
(E0912's rule); a push outside the declared union; a
`Box`/`RefCell` carrying origins crossing a `Send`/spawn/`extern`/
module-level position; an elided `push` signature with unrelated fresh
origins (the body check must reject it); a widening through a `&mut`
pointee (`store(&mut slot, &y)`, O3-3) and through a lent
`&RefCell(&(T, p))`; a body-local borrow live across an `await` as a
POSITIVE control (O5); a second `get2_mut(&mut xs, …)` while the first
pair lives (an access to `xs`, E0911) beside the POSITIVE control of two
items from one `&mut` cursor held at once (O3 step 2); `&mut h.*.x`
through an `Rc` (E0919) and a handle dropped or reassigned while
`&(X, h)` lives (E0911), beside the POSITIVE `out.push(&h.*.x)` (O9);
`rc(v)` with a reference-holding `v` (the `Escapable` bound, O10);
`swap` on referents of different origin types (a type error); a closure
literal whose captures exceed a slot's origin parameters; a generic body
passing an unbounded `T` to `Rc(T)` (fails in the specialization naming
`where(T <: Escapable)`) and `Rc(&(X, x))` at a call (error at the call,
O10). Positive
controls mirror them, `words` and `get2_mut`'s pair among them.

## 6. Alternatives considered

| Alternative | Verdict |
| --- | --- |
| Rust's lifetimes (`'a` as abstract regions, outlives, variance, HRTB) | **still rejected as regions** — the solving, the variance and the error-at-a-distance are what §4 refuses; the names-in-types half is now adopted as origins, which are ground place sets, not region variables |
| the 2025 `FUTURE_ORIGINS.md` sketch (`&(T, R)`, `forall(R : Origin)`, `where(R1 < R2)` constraints, a solver, no `&`/`&mut` split, second-classness inferred) — rejected then as "Rust lifetimes wearing Yo's clothes" | **its vocabulary is kept, its machinery is not** (the sketch was deleted 2026-10-20; `git log -- plans/backlog/FUTURE_ORIGINS.md` has it): the kind beside `Type` and the trailing-argument spelling are this design's; the ordering constraints and the solver are replaced by ground place sets with subset coercion, the missing `&mut` split by decision 42's freeze model, and inference by declaration with checked defaults — which is what answers the 2025 rejection |
| Mojo's origins (`ref [origin]`, parametric, inferred) | **adopted in modified form** — parametric origins with explicit spelling at contracts and checked defaults elsewhere; no inference at semantic distance |
| Austral's regions | **adopted in modified form** — declared and explicit; its linear types stay rejected (affine moves + `Drop` are lighter) |
| the 2026-10-13 `depends`-clause + root-joining-tracker design (this file's predecessor) | **superseded** — the clause grammar, its `Fn(...)` subtyping order and its per-value flow tracker (the design's one new analysis) all collapse into parametricity and declared unions (O7, O6); the mapping table shows nothing lost |
| inferring a callee's borrow behaviour from its body | still rejected — the contract would live in the body; an edit inside one function silently changes what callers may do, and a body edit re-checks every caller (the incremental checker) |
| proving element disjointness inside the borrow checker | still rejected — a second, weaker prover beside the verifier; disjointness is a `requires` (R4) |
| Ante's unstable-place invalidation (`!` — mutation kills outstanding borrows) | **rejected** — it contradicts "`&` means unchanged" (§3.10), which the verifier's alias reasoning leans on; Yo freezes the base instead, and last-use liveness already legalizes the stale-view-then-mutate patterns |
| Ante's shared-mutable `ref`/`mut` kinds (exclusivity dropped single-threaded) | **rejected** — Yo keeps exclusivity everywhere; shared mutation stays behind `RefCell` (decision 46), and `Rc` remains read-only like Rust's |
| `Rc(T, p)`: statically checked shared mutation through origin-tracked handles | **rejected** (maintainer, 2026-10-20: Rust's design makes sense — the runtime exclusivity check happens on `RefCell` only, and `Rc` stays read-only) — it would put a second mutation mechanism beside `RefCell` for the narrow statically-provable case `Rc.get_mut`'s count check already covers, while the genuinely shared cases (async channel and mutex states) are not statically provable and use `RefCell` anyway. Honest cost, recorded: mutable cycles keep the runtime check (`Rc(RefCell(Node))`), as in Rust |
| Ante's body-inferred `Mutate` effect | **rejected** — signature-based checking keeps `Dyn` dispatch, effect handlers and the incremental checker sound; Ante's own handler interaction is their experimental part |
| keeping R5's "no origin crosses an `Rc`/`Arc` deref; hold the handle, re-derive" | **rejected** (2026-10-20, review round 2) — its reason was the pre-decision-46 writable `Rc`; with the payload read-only through every handle the handle's place is a sound origin (O9), the A2 predicate already took that step for futures, and Rust's `&*rc` is the model |
| Swift's `~Escapable` split (implicit `Escapable` bound on every generic parameter, suppressed by opt-in) | **rejected** (2026-10-20) — O10 takes the positive bound instead: no negative-bound spelling, fewer annotations over std, `Send`'s and Rust's `'static` shape |
| elision-only surface (no explicit `Origin` kind) | **rejected** (maintainer, 2026-10-19) — LLM authorship wants contracts explicit; the failure mode of explicit systems is a local declaration mismatch, of implicit ones a distant inference surprise |

Adopted from the post beyond the foundation: union places (O1), place
paths (§7, phased). Considered and rejected: the `Rc` place parameter
(§6's row). Already Yo's by other means:
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
| shared mutation | not covered by origins | `Rc` read-only, `RefCell` the one dynamic door (decision 46) — Rust's and, in effect, Mojo's answer too |

Both reject Rust's region machinery — no outlives lattice, no variance, no
higher-ranked bounds — and both make checking parametric. The name is
shared; the shape is not: Mojo's origin is singular provenance the compiler
writes, Yo's is a declared place set the author writes.

### Is this still mutable value semantics? (maintainer's question, 2026-10-20)

Hylo's mutable value semantics has two halves: owned values are
independent (a copy is a new value, mutation is in place, no two names
reach one object), and there are **no first-class references** — the
second half is what keeps the first checkable without a borrow checker
(the JOT paper `docs/en-US/DESIGN.md` cites). Decision 43 as first
confirmed (2026-10-10) already stepped off that line to the point Swift's
`Span` and Mojo's `ref` reached (second-class references); this
amendment gives the second half up entirely, since `&(T, p)` is storable.
So, honestly: **Yo is no longer MVS in Hylo's sense.** It is unique
ownership with first-class, exclusivity-checked borrows — Rust's
discipline — with ground place sets where Rust has regions. What survives
is the half that carries the guarantees the language advertises: owned
values are independent (decision 19's no partial moves, V2b's explicit
copies), mutation is in place through `&mut` (decision 42), and the law of
exclusivity holds (`&` means unchanged, `&mut` exclusive, §3.10), so a
value read through one name is never changed through another — the
observable property MVS was adopted for, kept by the freeze model with
references first-class. The accurate phrase for the plan is "unique
ownership with first-class, exclusivity-checked borrows"; "mutable value
semantics for owned values" stays true as a description of the owned half
and is kept where the plan says it. `plans/ROADMAP.md`'s positioning says
it in those words (2026-10-20).

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
- **Temporary lifetime extension.** `r := &make()` is rejected today
  (a root that is a temporary). Position: adopt Rust's rule at decision
  18's phase — the temporary of a `:=` initializer's borrow is bound to a
  hidden local of the enclosing block, so `r`'s origin is that local;
  nothing in the origin model changes.
- **Associated type constructors over `Origin`.** Rust's GATs
  (`type Item<'a>`) are not needed for lending iterators (elision gives
  the lending reading, O2). Position: an associated type may be a
  comptime fn over `Origin` once a counted need appears; not in N1–N3.
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

### Found by the N0 reference checker (2026-10-21)

Building the model (`tests/origins/model.yo`, §8 N0) forced the points
below. The model implements each position as stated, and each has corpus
rows that pin it.

- **Flow inference at a `&mut` lend.** O2 makes a body-local's origins
  flow-inferred, and O3-3 makes an origin behind a `&mut` invariant. The
  two meet when a local whose set was inferred is lent `&mut`:
  `ra := &x; rb := &y; swap(&mut ra, &mut rb)` fixes `r` to `{x}` through
  one pointee and to `{y}` through the other. Read literally, that is a
  type error Rust does not have, because Rust infers one region for both.
  Position: a flow-inferred position is an inference variable at a `&mut`
  lend in the same body. That covers any origin of an unannotated local
  and an elided union in a body (`ArrayList(&i32).new()`). It widens to
  what the callee's signature needs (`r := (x, y)`), and after the call
  the local's flow set is the solved one. A spelled position stays
  invariant: `(ra : &(i32, x))` makes the same `swap` an error, which is
  §5's row. Rows: `swap-inferred-locals`, `swap-different-origins`,
  `elided-container-lent-mut`, `elided-container-lent-mut-then-write`.
- **A local's flow set after a `&mut` lend.** O6 says what a callee
  assumes when it receives a container through `&mut` (the whole declared
  union). It does not say what the caller knows afterwards. Position: the
  callee may have written anything its parameter type allows. So the
  caller's flow set becomes the declared bound at a spelled position and
  the solved set at a flow-inferred one. Without this rule, a callee that
  pushes `&x` through `&mut out` leaves `out`'s set empty, and a later
  write of `x` passes. The ablation tests show this is the rule
  `store-widen-mut-pointee` rests on once O3-3 is switched off.
- **A `&mut` capture of a flow-inferred container.** A closure literal
  (or an `io.async` body) that captures `out` `&mut` and pushes into it is
  invisible to the caller's flow inference, because the push runs inside
  whatever call runs the literal. Position: the literal is in the same
  body, so at the literal the container's flow set grows by its bound
  restricted to the literal's other captures' origins: everything the
  body can name. The literal's parameter has a per-call origin that cannot
  be stored, and the union rule rejects that store. Rows:
  `closure-push-capture`, `closure-push-capture-then-write`,
  `closure-param-into-capture`.
- **O9's "never a collection candidate" is too strong.** O9 and §5's
  "Shared cells" argue that a frozen handle's count is never decremented,
  so its payload is neither freed nor a collection candidate. But another
  handle to the same cell can still be dropped while `&(X, h)` lives:
  `h2 := h; r := &h.*.x; drop(h2)` is legal, since `h2` holds no loan.
  Decrementing a count to a non-zero value is exactly what makes an
  object a candidate (`docs/en-US/CYCLE_COLLECTION.md`). The conclusion
  holds on a different premise: the frozen `h` is a reference from outside
  any cycle, so trial deletion leaves the payload's count above zero and
  ScanBlack restores it. Position: restate O9's argument on that premise
  when N1 lands the handle-origin rule. The model does not run a
  collector, so this is a correction to the prose, not something the
  model checks. Rows: `rc-guard-and-clone`, `rc-guard-handle-dropped`.
- **`f(&mut xs, &xs)` is accepted today because decision 28's value-root
  rule has not landed, not because decision 28 allows it.** Decision 28's
  "Value roots" makes a `&mut` argument that overlaps any other argument a
  compile error, and O3 step 2 agrees: the live `&mut` loan conflicts with
  taking a new borrow of `xs`. That rule is phased to V2b
  (`plans/VALUES_BY_DEFAULT.md` decision 28 "Phase" and V2b's list) and is
  not built. What is built is the two-phase interim ("a read or a `&`
  relend in a later argument passes"), so `both(&mut xs, &xs)` passes
  today. The two arguments are observably aliased:
  - A value struct is passed to a `&` parameter by copy: a callee that
    writes `m.a` through the `&mut` and then reads `r.a` through the `&`
    sees the old value (measured on v0.2.67 with a four-field `i64`
    struct).
  - A collection is a reference type, so both parameters reach one heap
    object: a callee that pushes 1000 elements through `a` reads
    `b.len() == 1001`.
  - The call was also unsound. Phase 5.2's caller-owned `+1` on the `&`
    argument was cancelled by the dup/drop pair optimizer, so the
    collection leaked, and a callee replacing `a` read freed memory
    through `b`. Fixed on this branch:
    `issues/fixed/2026-10-21-an-argument-lent-both-mut-and-shared-to-one-call-loses-its-caller-owned-share.md`.
    Inside an `io.async` body the `+1` is still never emitted:
    `issues/2026-10-21-an-aliased-argument-in-an-async-body-gets-no-caller-owned-share.md`.

  Position: O3 step 2's overlap check and decision 28's value-root rule
  are one rule reached from two plans, E0910 at the call. Whichever of V2b
  and N1 lands first builds it, and its Generation A counts the tree's
  uses first; the other phase reuses it. The model implements it as O3's
  (`eval_call`), and row `call-arg-overlap` is an N1 row expecting E0910.
  When the rule lands, re-record that row's `today` column: it is the one
  row that today's compiler wrongly accepts.
- **The type-constructor spelling.** O1's example first spelled the
  constructor `(fn(comptime(T : Type, p : Origin) -> …))`, which does not
  parse. A comptime parameter is written `comptime(T) : Type`, as in the
  prelude's `Box`. The example above is corrected, and the corpus spells
  `(fn(comptime(p) : Origin) -> comptime(Type))`.

## 8. Phases

| Phase | Lands | Gate |
| --- | --- | --- |
| N0 | the negative-test corpus (§5's rows) written and failing, AND a **reference checker**: an executable model of O1–O10 over a toy language, a few hundred lines, that the corpus runs through — the cheapest way to find rule interactions a prose argument cannot (2026-10-20). No prerequisite: N0 can start before V2b finishes. **Written 2026-10-21; see "N0 as built" below** | the tests fail for the right reason; the model accepts every positive control and rejects every negative row |
| N1 | the `Origin` kind and `TypeValue.Reference(T, mutable, origin)` (behavioral identity: every test, the fixpoint, an emit-diff with no C change); Generation A: the `&(T, p)` parse, `generic(p : Origin)`, the elision defaults, O3's checking rules (freeze/exclusivity by origin, the covariant/invariant coercion rule, the return rule, place writes), the `Escapable` marker and its bound at the no-origin positions (O10), the handle-origin rule for borrows through an `Rc`/`Arc` deref (O9), `.*`/auto-deref/auto-borrow, `impl(&T, ...)`, `FnMut`. The storage wall stays as it is today — origins are vocabulary and checking, first-class storage waits for N2, so no build accepts an escape it cannot see | the corpus minus its storage rows, the fast suite, fixpoint |
| N2 | first-class storage: O4's table — cells (`Box`, `RefCell`, `Dyn(Trait, p)`) and containers carry origin parameters, E0909 becomes the no-origin-position rule, O6's declared unions with the widening `yo fix` | the storage rows of the corpus |
| N3 | std and `src/` adopt (Generation B, on the next seed): `iter`, `slice`, `entry`, the borrowed `for` by `impl(&C, IntoIterator)`, the `FnMut` slots, the `Future(T, p)` spelling replacing A2's registry | the catalog's rewritten sections; CP0's rows for `slice` and `sort` |

After decision 42's Generation B and V2b, as before (N0 excepted); each
phase is one PR or one stack with one battery, per AGENTS.md.

**N0 as built (2026-10-21, branch `test/decision43-n0-corpus`).**

- **The corpus** is 71 programs in `tests/origins/corpus/<id>.yo`: 44
  negative rows and 27 positive controls. They cover the items §5's list
  names, the eight routes, the five expected holes below, one row per
  lowering of §4 (below), and the points §7's "Found by the N0 reference
  checker" records. The superseded design's rows are restated or mapped in
  the table below. Each program is spelled in the syntax N1–N3 will land.
  They are plain `.yo` files, so `yo test ./tests` never runs them. The
  manifest `tests/origins/corpus.tsv` gives each row its plan anchor, its
  kind, the phase whose gate it joins (28 rows N1, 37 N2, 6 N3), the
  verdict expected once the rules land, and what today's `yo check` does
  with it. `scripts/origins-corpus.sh` is the gate. `today` mode is the N0
  gate: every row must still fail with the recorded code and the recorded
  text in its first error (or pass, if recorded so). `target` mode, with
  `PHASES=N1` and so on, is the later phases' gate. Both modes first
  cross-check the manifest against the fixtures and the model test.
- **One row per lowering (§4).** Macro expansions: `macro-ret-local`.
  Closure capture structs: the `closure-*` rows. Async state machines:
  the `async-*` rows. Effect handlers: `effect-resume-local`,
  `effect-resume-capture`, `effect-resume-param`. `match` and `cond` arms:
  `match-arm-binding-origin`, and `loop-join-push` for a `while` body.
  The specializer: `generic-unbounded-rc` (`E0909@spec`). The model has no
  macro or handler node: it checks a handler as the function literal or
  closure it is and a macro row as its expansion, so these rows test the
  rule. That the compiler applies the rule inside each lowering is N1's to
  show, with the fixture.
- **The reference checker** is `tests/origins/model.yo`. It models
  origin sets as bitmasks over places, unification at application, subset
  coercion with O3-3's invariance, loans against accesses with last-use
  liveness (loop fixpoint included; a loop that has not converged in 16
  rounds fails `MODEL_LIMIT` rather than pass), the return rule, declared
  unions, `may_dangle` drops, the handle-origin rule and `Escapable`. It is
  about 1160 lines of code after `yo fmt`'s one-argument-per-line layout,
  more than the few hundred planned, because every rule above had a row
  that needed it. `tests/origins/model_corpus.test.yo` encodes every row
  and is in the fast suite. It also runs five ablations: switching off
  invariance, the loop fixpoint, the user-`Drop` liveness, the capture
  widening or the handle origin flips the rows that rule is meant to
  reject to `ACCEPT`. So each of those rows tests its rule and is not
  rejected for an unrelated reason.
- **Gate result.** The model returns the manifest's verdict on all 71
  rows: it rejects each of the 44 negative rows with the rule the row
  names and accepts the 27 positive controls. The 9 ablation checks flip
  as expected, for 76 passing tests. Today's compiler behaves as recorded
  on all 71 rows:
  - 63 cannot be expressed yet. Mostly `Variable "Origin" not found`,
    "a borrow mode, not a type", "Expected a type for function return
    type", or a type argument `&(T, x)` read as a runtime tuple.
  - 6 are already rejected by today's second-class rule for the same
    hazard: `get2-mut-twice`, `drop-root-while-borrowed` and
    `dyn-call-elided-result` (E0911), `rc-mut-through-deref` (E0919),
    `ret-local` (decision 24's projection rule) and `async-forward-local`
    (A2's E0909).
  - 1 positive control is already accepted: `await-local-borrow`.
  - 1 negative row is wrongly accepted: `call-arg-overlap` (§7: decision
    28's value-root rule, V2b).
- **Two bugs found and fixed on the way.** Any `&mut(A, B)` crashed `yo
  check` with a stack overflow. That is the very spelling N1 adds, so it
  is now a diagnostic
  (`issues/fixed/2026-10-21-an-origin-qualified-mut-reference-overflows-the-checker-stack.md`).
  And `call-arg-overlap`'s program leaked, while a callee replacing its
  `&mut` argument read freed memory through the `&` one
  (`issues/fixed/2026-10-21-an-argument-lent-both-mut-and-shared-to-one-call-loses-its-caller-owned-share.md`).

**The superseded design's rows, restated.** §5's list begins with "the
superseded design's rows restated in origin terms" (its §5 corpus, `git
show 6ccddf25d^:plans/backlog/NON_ESCAPABLE_TYPES.md`). Each row is a
restated corpus row, folded into a row that tests the same mechanism, or
dropped with the reason. `View(T)` is `&(T, p)` or a struct holding one,
and a `depends` clause is the origin spelling of O7's table.

| Superseded row | Here |
| --- | --- |
| return a view of a local; return `.Some(&local)`; return a container with a non-parameter root | `ret-local`: the return rule reads the result's origins whatever wraps them |
| return a view of the wrong parameter under `depends` | `impl-wider-than-trait`: a body whose result exceeds its declared origin |
| store a view in a cell (`Rc(View(T))`, `Box(View(T))`); a `Dyn` over a tuple with a reference | `rc-of-ref-holder`, `spawn-box-origin`, `extern-box-origin`: `Dyn(Trait)` is `Dyn(Trait, ∅)`, the same no-origin position (O4, O10); N2 adds a `Dyn(Trait, p)` row when it gives `Dyn` its parameter |
| capture a view in an escaping closure; spawn one | `closure-caps-exceed-slot`, `spawn-box-origin`, `thread-send-origin` |
| re-point a component to a temporary; `set(&mut r, &y)` with `r := &x`, then `y` dropped | `store-widen-mut-pointee` (O3-3) |
| a `&mut` view and a `push` on its root in one expression | `call-arg-overlap` |
| a view whose place crosses an `Rc` deref; `out.push(&h.*.x)` | `rc-handle-dropped`, `rc-handle-reassigned`, `rc-push-handle-borrow` |
| store a `StrArg` whose live value is `.Owned` in a cell; move a `.Borrowed` payload out of a consumed scrutinee | `match-arm-binding-origin`: an enum payload carries its origins through a consuming `match`; `.Owned` carries none |
| `derive(Copy)` on an enum with a `&mut` payload | `copy-mut-holder`: route 3 makes a `&mut` holder move-only, and `derive(Copy)` already rejects a field that is not `Copy` |
| `ArrayList(&mut T)` with two pushes of one root; a read of `x` while it holds `&mut x` | `list-mut-two-pushes` (the read is the same access against the loan) |
| an `Rc`-rooted element in a container | `rc-push-handle-borrow` |
| a `&mut T` written through a `&` path; a bare `cur = v` with `v : T` | dropped: plain type errors (decision 42), no origin involved |
| `push_all(&mut out, &vals)` then `vals` dropped; `r := &mut out; r.push(&x)` then a write to `x`; `write(ser, &x)` with `ser` carrying the `&mut` list; `ser.out.push(&x)` then `ser` dies | `elided-container-lent-mut-then-write`, `push-spelled-shared`: a container's origins live in its type, so who pushed and through what does not matter |
| `r := cell.get_mut()` (error naming `with_mut`) | inverted: `get_mut(self : &mut Self) -> &mut(T, self)` is O2's default and sound, as Rust's `RefCell::get_mut`; its mechanism, a `&mut` result rooted at a `&mut` parameter, is `get2-mut-twice` and `cursor-two-items`. A row with the API waits for N3's std |
| a `depends(dst : ())` callee pushing its `&` argument; a callee pushing `&local` into a `&mut` parameter's container | `push-elided-unrelated`, `push-outside-union` |
| `out.push(local.view(r))` then a write to `local`; `s.emit()` pushing `self.prefix` into `self.out`, then `prefix` dropped | `words-then-write` (field paths are not modeled, §7) |
| `out(i) = &x` then a write to `x` | `place-write-join` |
| `v.xs = &y` with `y` scoped inside `v`'s life | `place-write-join` and `drop-root-while-borrowed` |
| `xs.for_each(_ => out.push(&ys))` then a write to `ys`; the closure moving `b`'s element into `a` and pushing `&z` into `b` | `closure-push-capture-then-write` |
| a closure pushing `&` of its own parameter into a captured container; `xs.for_each(x => out.push(x))` | `closure-param-into-capture` |
| a reference-holding module-level binding; an `extern` signature with a `&` parameter | `global-refcell-origin`, `extern-box-origin` |
| `View(i32)(xs : &COUNTS, …)` live across a call | not restated: §7's "Module-level origins" keeps decision 18 rule 3 (no call or `await` while a module-level place is lent) as the checking rule, and that rule is built and tested today (`tests/global_lend.test.yo`) |
| a handler resuming with a view of its own local | `effect-resume-local` (and `effect-resume-capture` for O7's capture rule) |
| `ArrayList(&T)` before N2 (error naming N2) | dropped: a phase-gate diagnostic, not a soundness row; the N2 rows fail before N2 by construction |
| `dst.push(f())` with `f : &Impl(Fn() -> &T)` and no clause | `closure-returns-capture` |
| a result with a `self.*` source projecting into `self`; `IterMut`'s `next` with a `self.*` source; `peek(h : &Holder) -> &i64` returning the `&mut` component | `ret-param-place`, `cursor-two-items`, `copy-mut-holder` (field paths are not modeled) |
| `next` with no clause and two items live (E0911) | `get2-mut-twice`: the elided result is the receiver's place |
| `&mut xs(i)` beside `&mut xs(j)` | `index-mut-twice` |
| `xs.get2_mut(i, i)` under `Pragma.Verify`, without it, and under `Pragma.NoContracts` | dropped: the verifier's and the runtime contract's, not an origin rule (§5: disjointness is a contract) |
| a use of `xs` while `a` or `b` of `get2_mut` lives | `get2-mut-twice` |
| **Positive controls:** a local `Array(&T, 3)` from three lends; `out.push(&x)` then `out.push(&y)` | `push-inside-union` |
| `(a, n) := t` re-borrowing | folded into `match-arm-binding-origin`: a destructuring binding carries the value's origins as an arm binding does; no separate positive |
| `-> Result((View(u8), T), E)` | `ret-param-place` |
| `f(v)` copying an all-`&` view | `copy-shared-holder` |
| `words` | `words` |
| `map.remove(&k)` then a use of `k`; `m.get(&k)` then a write to `k` | `dyn-call-spelled-result`: an argument outside the result's origin is not frozen |
| `out.retain(x => x.len() > n)` then a write to `n` | `closure-caps-within-slot` |
| `next` with a `self.*` source and two items live | `cursor-two-items` |
| `x := stack.pop(); stack.push(y)`; `dst.push(dst.pop())`; `a.append(&mut b)` then a use of `b` | `push-spelled-shared`, `elided-container-lent-mut` |
| `parse_int(input)` returning the remainder of a by-value view | `ret-byvalue-carried` |
| `entry(k).or_insert(v)` | N3 (`entry` is in N3's list) |
| `for(&xs, x => out.push(x.*))` | dropped: the pushed value is a copy and carries no origin |
| `(a, b) := xs.get2_mut(i, j)` both written; `swap(a, b)` on its halves | `get2-mut-pair`, `swap-declared-union` |
| `out := …; x := …; out.push(&x)` with `out`'s last use before `x`'s drop | `drop-order-may-dangle` |

**Where holes are expected first** (recorded 2026-10-20 so N0 writes rows
for them before N1 lands): flow-inferred origin sets at control-flow
joins (loops that push on one path only); the elision defaults meeting
closures (a literal's fresh parameter origins against captured ones);
drop order with O3's `may_dangle` obligation (a container declared before
its roots); the handle-origin rule beside a `RefCell` guard and a
collection in the same frame (O9); origin-carrying captures in an async
state machine across a cold start. Rust's own checker had its holes found
in exactly these kinds of interaction, years after shipping. The ctl-handler open point
and the `.*` / `str` decisions recorded under "Decision 43" in
`plans/VALUES_BY_DEFAULT.md` §6 carry over unchanged.
