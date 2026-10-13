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
Amended 2026-10-13 after the audit in issue #1330 (R7's join domain, the
callee-side `depends` check, joins inside closures, joins on the root
place, place writes as joins, the N1/N2 boundary) and a second pass the
same day: R3 separates a parameter's place from the roots it carries
(sources `p` / `p.*`) and admits by-value reference-holding
parameters as roots, without which the entry API, parser remainders and
non-lending iterators failed R3; joins target every `&mut`
reference-holding argument, never the argument itself; the root place is
followed through reference components; component writes are place
writes, not decision 25 re-points.

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
| local borrows and their live ranges; re-pointing | decisions 18, 25 | binding and re-pointing local borrows (`cur = &place`); component writes are R7's place writes |
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
| `ArrayList(T)`, `HashMap(K, V)`, every buffer-owning container | a buffer | yes, as a **root-joining** container (R7), from N2 | second-class, borrow set grows |
| `Box(T)`, `Rc(T)`, `Arc(T)`, `RefCell(T)`, `Dyn(Trait)` (so a borrowing closure in a `Dyn(Fn(...))`) | a cell | **no** — E0909 | — |

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

- **Closures may capture `&` and `&mut`.** A capture list that borrows
  (`{ y : &y, z : &mut z }() => …`, decision 35) makes the closure
  second-class, not illegal: it may be bound to a local, lent and called —
  a literal argument to `for_each`, `with_lock` or a lent
  `Impl(Fn(...))` parameter is the common case
  (`tests/closure_capture_list.test.yo`). What is E0909 is letting it
  escape: a `Dyn(Fn(...))` or any other cell, a return, a by-value
  (escaping) `Impl(Fn(...))` slot, a spawn, an escaping closure's capture
  (decision 38 A). `Impl(Fn)` itself is not storage; only its by-value,
  escaping use is.
- **The type decides, not the live variant.** A `StrArg` built as `.Owned`
  still cannot be stored in a cell: decision 38 A's rule is structural
  over types. A program that wants a storable owned form declares a second
  enum, or stores the payload.
- **Reading a `&` component** through a value lent as `&` yields `&T`
  whatever the field's mode (a `&mut T` reached through a `&` path is
  read-only, decision 43); through `&mut` or an owned value it yields the
  field's mode. A `&` read out of a place (`v.xs`, `r.*` with
  `r : &&U`) is a copy carrying the roots it carries; it does not borrow
  the place it was read from. **Writing** one: `v.xs = &other` re-points
  it — a place write, so `other` joins `v`'s borrow set (R7) and dropping
  `other` while `v` lives is E0911 (a scope-end drop is an access,
  decision 38 A); decision 25's reached-from-self rule is for local
  borrows (`cur = &place`), not components. `v.xs.* = ys` writes through
  it (an error unless the field is `&mut`), and `v.xs = ys` with
  `ys : ArrayList(T)` is a type error — a reference is a value, and only
  `.field`/`.method()` auto-deref (decision 43).
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
  spawned value, an escaping closure's capture, a `Send` value, a
  module-level binding (no frame owns its roots), or a parameter or result
  of an `extern` signature (C may store the pointer; FFI takes raw
  pointers, the existing unsafe boundary).
- **Passing.** A reference-holding value is passed by value when the
  slot's type is or contains a reference (`f(v)` into `v : View(T)` copies an all-`&` value
  and moves a `&mut`-holding one; decision 38 A as amended by 43) or by
  lend (`f(&v)` into `v : &View(T)`); the callee is checked per
  instantiation and its result inherits the roots (R3).

### R2. Construction lends; the borrow set is the components' union

```yo
v := View(T)(xs : &xs, lo : lo, hi : hi); // lends xs for v's life
e := map.entry(k); // lends map (&mut) for e's life
```

A `&` component is initialized with a sigiled argument (decision 33) or
with a reference already in hand. The value's borrow set is the union of
its components' sets, transitively (decision 38 A), and every source stays
frozen until the value's last use (decision 18). A `&mut` component
conflicts with every other access to its root while the value is live
(E0911). Re-assigning the whole value replaces its set (decision 38 A's
reaching definitions); writing a component unions into it (R7's place
write); a local borrow `cur = &place` re-points under decision 25.

### R3. A function returns a reference-holding value only with roots among its parameters

§3.13 A2, generalized to every type. A2 only had to map a future's borrow
of a parameter's *place*; a reference-holding value can also carry roots
*through* a parameter, so R3 tells the two apart.

- A function may return a reference-holding value iff every root in its
  borrow set is reached through the function's own reference-holding
  parameters: `&`/`&mut` parameters (and `self` in those modes), by-value
  parameters whose type is or contains a reference (`v : View(T)`,
  `self : Entry(K, V)`), and, for a closure, its captures, which are the
  roots of its implicit `self`. A borrow of a local, a temporary, a
  module-level root or an owned by-value parameter (one whose type
  contains no reference) in the result is a compile error at the
  `return`, naming the place.
- **Two kinds of source: a parameter's whole borrow set, or what its
  referent carries.** A source `p` says the result may carry `p`'s whole
  borrow set: for `p : &X` or `&mut X`, the lent place itself (and,
  transitively, everything it carries) — a projection into `p`'s storage
  (`xs(i)` with `xs : &ArrayList(T)`, `&self.field`) needs this; for a
  by-value `v : View(T)` or `self : Entry(K, V)`, the roots `v` carries.
  A source `p.*`, for a reference-typed `p` only, says the result carries
  only what the referent carries, never the referent itself — a `&` read
  out of a reference component, an element moved out of a buffer of
  references, a sub-view of a view `p` points at. A `&mut` is never
  carried out of a place that keeps it: a `&mut` component cannot be
  copied, so a `&mut` reached through `p`'s referent is a reborrow of
  that referent, and a `p.*` source rejects it. `IterMut`'s `next` is
  therefore a lending iterator (source `self`), which keeps two live
  items from aliasing; the borrowed `for(&mut xs, …)` stays the spelling
  for mutation. Only `&` roots read out of components and values moved
  out (an element `pop`ped from a buffer) are carried.

```yo
slice :: (fn(generic(T : Type), xs : &ArrayList(T), lo : usize, hi : usize) -> View(T))(...); // source xs, the default
longest :: (fn(a : &ArrayList(u8), b : &ArrayList(u8)) -> View(u8))(...); // sources a AND b, the default
pick :: (fn(a : &ArrayList(u8), b : &ArrayList(u8), depends(view : a)) -> (view : View(u8)))(...); // narrowed: a view of b is an error
// The item borrows the list the cursor carries, not the cursor: two items may be live
// across two `next` calls, and `out.push(x)` from `it.next()` leaves `it` usable.
next :: (fn(generic(T : Type), self : &mut Cursor(T), depends(item : self.*)) -> (item : Option(&T)))(...);
// With T = &U, the popped reference keeps U's roots, not a borrow of the list:
// `x := stack.pop(); stack.push(y)` is accepted.
pop :: (fn(generic(T : Type), self : &mut ArrayList(T), depends(item : self.*)) -> (item : Option(T)))(...);
// By-value reference-holding parameters carry their roots out: the parser remainder.
parse_int :: (fn(input : View(u8)) -> Result((View(u8), i64), ParseError))(...);
```

- **Defaults.** With no entry for the result, it has every
  reference-holding parameter `p` as a source `p`; a lent
  `Impl(Fn(...))` parameter counts by its captures. This is the
  conservative reading: without `depends(item : self.*)`, `next` is a
  *lending* iterator (the item freezes the cursor). The dependency is defaulted
  from the signature, never a lifetime name, and the clause only narrows.
- **At the call site** the result carries, for each source `p`, the
  argument's whole borrow set (for a lend `&x`, the place `x` in its
  mode), and for each source `p.*`, the argument's borrow set without
  the lent place — each frozen until the result's last use (A2's
  caller-side mapping, extended). Result types
  may be composites over references (`-> Option(&T)`, `-> (View(T),
  usize)`, `-> Result((View(u8), T), E)`).
- **The callee is checked against its clause (or the default), in both
  positions; a clause is never trusted** — except in raw-pointer code
  (std's buffer internals, `RawSlice`), where the tracker sees no roots
  and the clause is the trusted statement, the same boundary as FFI; std
  tests each such clause (below and R7). The tracker (R7) records, for
  every root, whether it is a parameter's place or a root that parameter
  carries. At each `return`, every root of the result must be covered by
  the declared sources: a projection into `self`'s storage under a
  `self.*` source is an error. At every join inside the body (R7), each
  root joined into a target reached through a `&mut` parameter `dst`, or
  through a `&mut` component of a by-value parameter (`ser.out` with
  `ser : Serializer`), must be one of that target's own carried roots (`dst.push(dst.pop())` is fine) or
  come from a declared source. So `dst.push(&local)` is an error with or
  without a clause, naming the place, and `dst.push(f())` with
  `f : &Impl(Fn() -> &T)` needs `depends(dst : f.*)`, which then makes
  the caller join `f`'s captures.
- **Signatures, never bodies.** A call is checked from the callee's
  signature alone — its parameter types, its `depends` clause or the
  default — and the callee's body is checked against that signature, never
  the other way round. Inferring a callee's borrow behaviour from its body
  would make the contract invisible, let an edit inside one body break
  its callers silently, force the incremental checker to re-check every
  caller on every body edit, and still need declarations for the callees
  with no body to read (`Dyn`, `Impl(Fn)` slots, `extern`).
- **Std's obligations.** An iterator's `next`, `pop`, `take` and every
  copy or move of an element out of a buffer name `self.*` as the
  result's source; every lookup returning a projection names `self`
  (`get(self : &Self, k : &K, depends(v : self)) -> (v : Option(&V))`), so
  `m.get(&k)` does not keep `k` frozen while the result lives; the
  container-position obligations are in R7.
- **Why the two defaults treat a lent closure differently.** A result
  may be computed by calling a lent `Impl(Fn)` parameter, so the result
  default includes its captures; storing into a target is rarer and
  conservative-by-default would freeze every closure's captures for the
  target's life, so the target default excludes it and the callee check
  turns the rare storing body into an error that names `f.*`.
- **Effect handlers and `Dyn` dispatch.** A handler's `return(expr)`
  resumes the operation's call site with `expr`, so a handler is checked
  by R3 against the operation's signature like any function: a
  reference-holding resume value must be rooted at the operation's own
  reference-holding parameters, never at the handler's captures (the
  computation does not know them). `unwind(expr)` exits the enclosing
  function with `expr` as its result, so R3 applies at that function's
  return. `Dyn(Trait)` dispatch needs nothing new: the callee is
  unknown, but every impl was checked against the trait method's
  signature, `depends` included, and the caller maps from the signature
  alone.

#### The `depends` clause

One clause, one grammar, fitted to the contract clauses' rules
(`.github/instructions/yo-syntax.instructions.md`, "Design-by-contract
clauses"; `_clause_zone` in `src/evaluator/types/function.yo`):

```yo ignore
// every entry is `target : sources`
depends(target : source)
depends(target : (source, source, ...))
depends(target : ()) // nothing flows into target
depends(t1 : sources, t2 : sources, ...) // several targets, ONE clause
```

- **A target** is the **return label** — the result is named the way
  `ensures` names it, `-> (view : View(u8))`, with no magic `result`
  identifier — or a parameter R7 can grow: one of type `&mut` over a
  reference-holding type, or a by-value parameter with a `&mut`
  component. Each target appears at most once, and a return label that
  shadows a parameter name is an error (`depends(self : …)` must mean
  the parameter).
- **A source** is a reference-holding parameter `p`, or `p.*` when `p`'s
  type is a reference (R3 above). A target never lists itself: its own
  carried roots may always rejoin it.
- **`()` says nothing flows in**: `depends(self : ())` on a lookup
  (`remove(&k)`, `binary_search(&probe)`, `contains(&x)`). A single source
  needs no parentheses; several form a tuple.
- **A target the clause does not name keeps its default** — for the
  result, every reference-holding parameter; for a `&mut` target, every
  other reference-holding parameter, a lent `Impl(Fn(...))` excepted.
  An entry replaces its target's default; the one source it can add is a
  lent `Impl(Fn(...))` for a `&mut` target (`depends(dst : f.*)`, R3's
  callee check).
- **Clause-call rules, as for `requires`/`ensures`:** at most one
  `depends(...)` per signature, several targets inside it; `depends()`
  is a syntax error (omit the clause).
- **Its zone is right after `where`:** `generic(...)`, parameters,
  `where(...)`, `depends(...)`, `requires(...)`, `ensures(...)`,
  `decreases(...)`, `assumed()`. It belongs to the function's type, like
  `where`, and is not a contract — so the contracts that follow may
  describe the result it scopes.
- **It is part of the function type.** It may be written in `Fn(...)`
  types and trait method signatures: an `Impl(Fn(a : &T) -> &U)` slot
  with no clause means the default, a value with a narrower clause
  coerces into it, a value with a wider one does not — so two closures
  differing only in `depends` have distinct types, ordered by subtyping
  (`p.*` is narrower than `p`, `()` narrowest). A trait method's clause
  binds every impl: the `Iterator` trait's `next` declares
  `depends(item : self.*)`, so generic code sees an item's roots, not
  the iterator's place.

```yo
pick :: (fn(a : &ArrayList(u8), b : &ArrayList(u8), depends(view : a)) -> (view : View(u8)))(...);
longest3 :: (fn(a : &String, b : &String, c : &String, depends(view : (a, b))) -> (view : View(u8)))(...);
// std's ArrayList methods, written as free functions
push :: (fn(generic(T : Type), self : &mut ArrayList(T), value : T, depends(self : value)) -> unit)(...);
// nothing flows into self; the removed element keeps its roots, not the key's
remove :: (fn(generic(T : Type), self : &mut ArrayList(T), key : &T, depends(self : (), item : self.*)) -> (item : Option(T)))(...);
append :: (fn(generic(T : Type), self : &mut ArrayList(T), other : &mut ArrayList(T), depends(self : other.*, other : ())) -> unit)(...);
// a result and a target in one clause
pop_into :: (fn(generic(T : Type), self : &mut ArrayList(T), out : &mut ArrayList(T), depends(out : self.*, item : self.*)) -> (item : Option(T)))(...);
swap :: (fn(generic(T : Type), a : &mut T, b : &mut T, depends(a : b.*, b : a.*)) -> unit)(...);
```

### R4. Methods and iterators

A reference-holding type has ordinary `&Self`, `&mut Self` and `Self`
methods, `Dispose` (the scope-end drop is an access, decision 38 A, so a
guard's `dispose` runs while its borrow is live), and trait impls. A
borrowing iterator is `iter(self : &Self) -> Cursor(T)` (R3, root `self`)
with `next(self : &mut Self, depends(item : self.*)) -> (item : Option(&T))` (the item
carries the cursor's roots, not the cursor); the borrowed `for(&xs, …)`
dispatches through `impl(&C, IntoIterator(…))`, Rust's shape
(`issues/questions/borrowed-for-over-user-defined-collections.md`). A
closure that writes a `&mut` capture is a `FnMut` (decision 37).

**Disjoint element borrows are a contract, not a borrow-checker proof.**
Two live `&mut` projections into one container (`&mut xs(i)` beside
`&mut xs(j)`) are rejected: a `&mut` projection borrows its base
exclusively (decision 24), and the checker reasons about places, never
index arithmetic. The disjoint case is one call returning both, with the
disjointness stated as a precondition:

```yo
get2_mut :: (fn(generic(T : Type), self : &mut ArrayList(T), i : usize, j : usize, requires(i != j, i < self.len(), j < self.len())) -> (&mut T, &mut T))(...);
```

- Without a verify pragma the `requires` lowers to a runtime assert (two
  comparisons, no loop); under `Pragma.Verify` Z3 discharges it at each
  call site, so a proved caller pays nothing, and a caller passing `i`
  and `i` fails to verify.
- The result is one value carrying `&mut self`; its two components are
  disjoint by the callee's contract, so the tracker treats them as one
  loan split in two, like sibling fields (decision 18, "siblings stay
  free"): `(a, b) := xs.get2_mut(i, j)` lets `a` and `b` live and be
  written together, and `xs` stays frozen until the last use of either.
- The body is raw-pointer code (R3's trusted boundary), tested like every
  such std clause. `get_disjoint_mut(self, idx : Array(usize, N))` is the
  same shape for `N` indices, with a pairwise-distinct precondition.

### R5. Roots through `Rc`/`Arc`

A `&` component whose place crosses an `Rc`/`Arc` deref is allowed only
through the pin the borrowed `for` uses (§3.10: the cell's guard held for
the value's life), never `&mut` across a suspension; an `Arc` root follows
§3.8's `Sync` rules. The default root is a value place. A `RefCell(T)` root
is a `with`/`with_mut` body or an expression-scoped `get`/`get_mut`
projection, never a component and never a bound projection (the dynamic
borrow is call- or expression-scoped, decision 41; binding `cell.get_mut()`
is an error naming `with_mut`).

### R6. Async and threads

A reference-holding value is not `Send` (decision 38 E) and cannot be
spawned or captured by an `io.async` body except under A2's own rules. It
may be held across an `await` only when its roots may be (A2's
`Rc`-crossing errors apply).

### R7. Growing borrow sets: root-joining containers and every `&mut` target

A buffer container instantiated over a type containing a `&` is legal
(from N2, §8) and second-class, and unlike a value built once (R2) its
borrow set **grows**: every element pushed in brings its roots. The join
rules below are stated for every **reference-holding target** — any
place whose type contains a reference, reached by the caller through a
`&mut` lend, through a `&mut` root that an argument carries, or written
in place. A root-joining container is the case
where the growth is unbounded, but a struct, an `Option(&T)` or a
`&mut &T` lent `&mut` grows the same way:
`set(dst : &mut Option(&T), v : &T)` writing `.Some(v)` leaves the
caller's `o` holding `v`'s referent. Two events join roots into a target,
each for the rest of the target's life:

1. **A call.** The rule is stated over **every call**, a method call being
   receiver sugar: at any call, each argument joins its whole borrow set
   — a reference or a reference-holding value, in either mode, lent or by
   value (`&x`, `&mut x`, a `View(T)` passed by value, a consumed
   `ArrayList(&mut T)`) — into every **other** argument that is a target:
   one `&mut`-lent whose type contains a reference, or one that carries a
   `&mut` root to such a place (a `Serializer` passed by value whose
   `out : &mut ArrayList(&T)` points at the caller's list — decision 38
   B already counts a value carrying a `&mut` borrow as a `&mut`
   argument; this is that rule applied to joins). The join lands on the
   carried root, as narrowed by the callee's `depends` clause (R3). An argument never joins itself: in `out.push(&x)` only
   `&x` joins `out`, and the receiver `&mut out` joins nothing. A closure passed to a
   lent `Impl(Fn(...))` slot joins nothing by default, because a lent
   closure cannot be stored (decision 38 A) and R3's callee check rejects
   a body that stores something rooted in it (`dst.push(f())`) unless the
   clause names `f.*`. So `out.push(&x)` grows `out`'s roots by `x`, and
   so does `push_all(&mut out, &vals)` at the caller — a unit-returning
   helper that grows a `&mut` argument cannot escape the tracker, because
   the join is recorded at the call, not inside the callee (R3 checks the
   callee against the same clause). A `&self` method, or a call with no
   `&mut` reference-holding argument, joins nothing.
2. **A place write.** Writing a reference-holding value through a `&mut`
   (`dst.* = .Some(v)`, `e.slot.* = &z`) or into a component of a
   reference-holding value — an element (`out(i) = &x`), a field
   (`v.xs = &y`, `out(i).xs = &y`), a payload — unions the right-hand
   side's borrow set into the root place the write reaches. Only a
   whole-value assignment to a local binding replaces its set (decision
   38 A's reaching definitions); a write through a reference never does,
   since the referent may hold roots the writer cannot see. A projection
   write is not a call that receives the value, so it is its own trigger.

A join lands on the **root place**, never on the binding that performed
it, and the path to it is followed through references: `r := &mut out;
r.push(&x)` grows `out`'s set (the local borrow's root, decision 18);
`s.buf.push(&x)` with `s` owning `buf` grows `s`'s; `ser.out.push(&x)`
with `ser.out : &mut ArrayList(&T)` grows the list `ser.out` points at —
every `&mut` root in `ser`'s borrow set that can hold that type,
conservatively — not `ser`, which may die while the list lives. When the
root place is outside the frame (a `&mut` parameter, a `&mut` capture),
R3's callee check applies. A joined value contributes its whole borrow
set, transitively, as construction does (R2): pushing a `v : View(T)`
joins every root of `v`, and pushing `&v` joins `v` and every root of `v`.

The default is conservative on purpose and would freeze a transient key
for the container's life (`map.remove(&k)`, `list.binary_search(&probe)`)
and a drained container's place for the receiver's (`a.append(&mut b)`),
so std narrows:

- every non-storing method with a reference-holding parameter beside a
  `&mut` target declares `depends(self : ())` — tested by "the probe key is
  usable after the call";
- a storing one names what it stores:
  `push(self : &mut Self, value : T, depends(self : value))`;
- a draining or exchanging one names what the other side carries, not
  its place: `append(self : &mut Self, other : &mut Self, depends(self :
  other.*, other : ()))`, `swap(a : &mut T, b : &mut T, depends(a : b.*,
  b : a.*))` — tested by "`b` is usable after the call".

The declaration is the contract: a caller is never checked against a
callee's body (R3, "Signatures, never bodies"). The mutation summaries
(§3.10's machinery) may at most let `yo fix` propose a missing clause.
Joined roots keep their mode: a `&mut x` pushed in freezes `x`
exclusively for the container's live range, so a second `&mut x` or a read
of `x` while it lives is E0911; a `&x` freezes `x` against writes only.
Returning the container is R3 over the joined set:

```yo
// View(u8) is the L1 view into the String's bytes. `str` itself is the first-class
// Copy view of STATIC bytes and never takes `&`: `(x : str) = "Hi";` and
// `ArrayList(str)` are ordinary first-class values.
words :: (fn(self : &Doc) -> ArrayList(View(u8)))({
  out := ArrayList(View(u8)).new();
  ranges := self.word_ranges(); // a named binding: a borrow never crosses a temporary (decision 35)
  for(&ranges, r => {
    out.push(self.text.view(r)); // a View passed by value joins its roots (self)
  }); // every root of `out` is self
  out // R3: depends on self
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
  **root place** — the single local-borrow root
  `VariableRare.inout_borrow_root_id` keeps today, extended to a set of
  `(root, mode)` pairs, where a parameter's root is either its place or
  the roots it carries (R3's `p` and `p.*`) — joined at each call and
  place write above, unioned over reaching definitions at control-flow
  joins, read by the freeze and exclusivity checks and by R3's return and
  callee checks. Flow-sensitive and intraprocedural. It also tracks joins
  into targets rooted *outside* the frame (a `&mut` parameter, a `&mut`
  capture), which R3's callee check reads.
- **Joins inside a closure body.** The borrowed `for` splices its body
  into the enclosing function (the `for` macro's `is_ref_form` branch in
  `std/prelude.yo`), so `words`' joins are ordinary. A real closure that
  holds a target by a `&mut` capture and joins into it
  (`xs.for_each(_ => out.push(&ys))`) treats the capture as a parameter:
  R3's callee check runs in its body, with only captured places as
  sources, and the literal's join summary (which captures join into
  which) is recorded per literal, keyed like `g_capture_borrows` by the
  capture struct's type id: one type per literal, so a per-literal
  summary fits where a per-value set does not. The enclosing function
  applies the summary where the literal takes its `&mut` capture, the
  conservative point since the closure may run any time while it lives.
  An `io.async` body is the same, through A2's registered capture-borrow
  set.
- **A closure's own parameter never joins a captured target**, even when
  its type is a reference: `xs.for_each(x => out.push(x))` is rejected,
  because `x`'s roots are bound inside `for_each` and cannot be mapped at
  the literal. The borrowed `for` is the spelling for collecting
  (`for(&xs, x => out.push(x.*))`); §7 records the refinement.
- Codegen: a buffer of `const T*` / `T*`, no count traffic, no element
  drops.

## 3. What it unlocks, mapped to the catalog

| Catalog gap | Now | Rust / Swift equivalent |
| --- | --- | --- |
| §2.4 sub-range arguments, `RUST_ADOPTION_CANDIDATES.md` L1 | `View(T)` (or a builtin `[T]` over it): `&xs` + range, zero-copy, `len` + `Index` projections, a `for` source | `&[T]`, Swift `Span` |
| §2.2 `fn words(&self) -> Vec<&str>` | `words(self : &Doc) -> ArrayList(View(u8))` (R7, root `self`), pass-local | `Vec<&'a str>` |
| §5.1 borrowing iterators, adapter chains over a borrowed container | `iter(self : &Self) -> Cursor(T)`, `next(self : &mut Self, depends(item : self.*)) -> (item : Option(&T))`, adapters as inline structs holding the cursor; `impl(&C, IntoIterator)` for the `for` | `impl Iterator<Item = &T> + 'a` |
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
  borrow-set tracker (R7) with its place/carried roots and per-literal
  closure summaries; the R3 return check, the callee check and the `depends` clause (parsed with
  the contract clauses); the inline rule's declared-storage check;
  `FnMut` (decision 37).
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
- **Diagnostics name the borrowed place and the value holding it.** An
  E0911 or R3/R7 error says which root place is frozen, which value keeps
  it frozen, where that value got the borrow, and where its last use is:
  "`x` is frozen: `out` holds `&x` (joined by `out.push(&x)` at line 12)
  until `out`'s last use at line 30", or "the result borrows `self.buf`
  but `depends(item : self.*)` allows only what `self` carries". The
  tracker already records each root's place path and the join or
  projection that added it, so the message costs no new analysis.
- **Tooling.** The parser and `_clause_zone` learn the `depends` zone
  (after `where`), and `Fn(...)` types accept the clause — the first
  clause that is part of a function type; `yo fmt` lays it out like the
  contract clauses; LSP signature help and hover show it; `yo doc` prints the
  inferred default (§7). New error codes in the diagnostics registry, each
  with a `yo explain` entry: the R3 return of a non-parameter root, a
  return outside the declared sources (including a place under `p.*`),
  the callee check (a join outside the declared or default set), a
  `depends` naming a non-reference parameter, a closure parameter joined
  into a captured target, a buffer container over a reference before N2,
  and a reference in an `extern` signature.

## 5. Soundness argument

Every reference-holding value is a closure capture record with a name. The
borrow set, the freeze until last use, the no-escape positions, the overlap
rules and A2's caller-side mapping are the rules closures and futures
already obey. The places a reference could escape, and what stops it:

1. **Through a return** — R3 refuses any root not reached through a
   reference-holding parameter; the caller freezes what the clause maps
   to (the argument's whole borrow set, or what its referent carries).
2. **Through a component write** — a place write unions the new
   referent's roots into the value's set (R7), and the referent's
   scope-end drop while the value lives is an access (decision 38 A), so
   pointing a component at a shorter-lived place is E0911 at that drop.
3. **Through storage** — the inline rule keeps cells and `Dyn` payloads
   reference-free; a target's roots grow with what flows in at every
   call that lends it `&mut` — a container, a struct, an `Option(&T)`,
   a `&mut &T` alike — and at every place write into it (R7), so a
   helper function cannot grow it unseen; the helper itself is checked
   against its `depends` clause or the default (R3), so the declaration
   the caller trusts is never a lie (raw-pointer code excepted, where it
   is the tested trusted statement).
4. **Through a carried result** — a `p.*` source maps to the argument's
   roots, not its place, and is checked in the callee: a projection into
   `p`'s storage, or a reborrow of a `&mut` reached through `p`, under
   `p.*` is an error, so a carried result never points into the argument
   place the caller is free to use again.
5. **Through a copy** — an all-`&` value's copies carry the same roots; a
   `&mut`-holding value is move-only.
6. **Through a closure body** — a `&mut` capture is a parameter to the
   callee check, the literal's join summary is applied where the capture
   is taken, and a closure parameter never joins a captured target (R7).
7. **Through an unknown callee** — `Dyn` dispatch and effect handlers are
   checked against the signature the caller maps from (R3).
8. **Through C or a module-level binding** — neither may hold a
   reference-holding value (R1).

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
container; a `&mut T` through a `&` path written (error);
`push_all(&mut out, &vals)` then `vals` dropped while `out` lives (E0911
at the drop); `r := cell.get_mut()` (error naming `with_mut`); a bare
`cur = v` with `v : T` (type error); a `depends(dst : ())` callee that
pushes its `&` argument into `dst` (container check); a callee pushing
`&local` into a `&mut` parameter's container, with and without a clause;
`out.push(local.view(r))` then a write to `local` while `out` lives (a
by-value view joins, E0911); `out(i) = &x` then a write to `x` (a place
write joins, E0911); `r := &mut out; r.push(&x)` then a write to `x`
after `r` dies (the join is on `out`); `xs.for_each(_ => out.push(&ys))`
then a write to `ys` while `out` lives (the closure summary); a closure
pushing `&` of its own parameter into a captured container; a
reference-holding module-level binding; an `extern` signature with a
`&` parameter; a handler resuming with a view of its own local; an
`ArrayList(&T)` before N2 (error naming N2); `set(&mut o, &x)` with
`set(dst : &mut Option(&T), v : &T)` then a write to `x` while `o` lives
(a non-container target joins); `v.xs = &y` with `y` scoped inside `v`'s
life (E0911 at `y`'s drop); `write(ser, &x)` with `ser : Serializer`
passed by value and `ser.out` the caller's list, then a write to `x`
while the list lives (a carried `&mut` root is a target); `ser.out.push(&x)` with `ser.out` a `&mut`
list, then `ser` dies and `x` is written while the list lives (the join
follows the reference); `dst.push(f())` with `f : &Impl(Fn() -> &T)` and
no `depends(dst : f.*)`; a result with a `self.*` source that projects
into `self`; `IterMut`'s `next` with a `self.*` source (a `&mut`
reborrow is never carried); `next` with no clause and two items live
(the lending default, E0911); `xs.for_each(x => out.push(x))`. Positive
controls: a local
`Array(&T, 3)` from three lends; `(a, n) := t` re-borrowing;
`-> Result((View(u8), T), E)`; `f(v)` copying an all-`&` view; `words`;
`map.remove(&k)` followed by a use of `k` (the `depends(self : ())`
obligation); `out.retain(x => x.len() > n)` followed by a write to `n`
(a lent closure joins nothing); `out.push(&x)` then `out.push(&y)` (the
receiver never joins itself); `next` with a `self.*` source and two
items live and `out.push(x)` from it followed by another `it.next()`;
`x := stack.pop(); stack.push(y)` on `ArrayList(&T)` (on
`ArrayList(&mut T)` a set never shrinks, so pushing a popped `&mut`
back while it lives overlaps the receiver under decision 38 B — a stated
limitation, not a hole); `a.append(&mut b)`
then a use of `b`; `dst.push(dst.pop())` under `depends(dst : ())`;
`parse_int(input)` returning the remainder of a by-value `View(u8)`;
`entry(k).or_insert(v)` with the `Entry` consumed; `m.get(&k)` then a
write to `k` while the result lives; `for(&xs, x => out.push(x.*))`; `(a, b) := xs.get2_mut(i, j)` with
both written while live. Negative: `&mut xs(i)` beside `&mut xs(j)`
(E0911, even with `i != j` known); `xs.get2_mut(i, i)` under
`Pragma.Verify` (fails to verify) and without it (the runtime assert
fires); a use of `xs` while `a` or `b` lives.

## 6. Alternatives considered

| Alternative | Why not |
| --- | --- |
| Rust's lifetimes (`'a` in types and signatures) | the annotation burden and the error-at-a-distance this project rejected (ROADMAP non-goals); every shape in §3 is covered without a name because the root is a parameter |
| Mojo's origins (`ref [origin]`, parametric) | named lifetimes with inference; the inferred half is R3, the named half is what §3's "not unlocked" refuses |
| Austral's regions and linear types | regions are lexical names; linear "use exactly once" is heavier than Yo's affine moves plus `Dispose`, and ATS A2's must-use covers the useful part |
| references as modes only (the pre-decision-43 design) | correct but confusing (a mode written in a type slot that is not a type) and it blocks `impl(&T, …)` and `FnMut`; the maintainer chose types |
| keep only `Rc`/indices/closures | the measured copies and the catalogued gaps |
| inferring a callee's borrow behaviour from its body (interprocedural summaries) | the contract would live in the body: an edit inside one function silently changes what its callers may do, every body edit re-checks every caller, and callees with no body (`Dyn`, `Impl(Fn)`, `extern`) need declarations anyway. A call is checked from the signature alone (R3) |
| proving element disjointness inside the borrow checker (index arithmetic, loop bounds, guards) | a second, weaker prover beside the verifier; disjointness is a `requires` the verifier already discharges (R4's `get2_mut`) |
| a shared-mutable reference kind (several live writers, no runtime flag) | sound only with a rule for every stored alias when its target's owner is dropped or reallocated, and for interior borrows taken through one alias while another writes; `Rc`/`RefCell` (decision 41), indices and arenas cover graphs and back-pointers |
| lifetime names in types (`View<'a>`, lifetime-polymorphic types) | `depends(view : a)` does select among a signature's roots, but only as a narrowing of the inferred "depends on all of them" in one signature; a type never carries a root name, so no constraint crosses a frame |

## 7. Open questions, with positions

- **`[T]` as a builtin or `View(T)` in std.** Position: std first, the
  builtin spelling only if the verifier or codegen needs a primitive.
  Decided in L1's PR. Related: whether `str` becomes the view of an owned
  `String`'s bytes in borrow position (L1).
- **The `depends` spelling — decided 2026-10-13 by the maintainer.** One
  clause whose every entry is `target : sources`, the result named by the
  return label as in `ensures`, zone right after `where` (R3, "The
  `depends` clause"). Chosen over a positional result entry
  (`depends(a, self : b)`: mixes positional and named entries, and
  `depends(self)` reads like `depends(self : x)`) and over a second
  clause word for targets (`stores(self : value)`: two words, two zones).
  The carried source `p.*` reuses decision 43's deref: `p` is the
  reference (the lent place included), `p.*` the value behind it, whose
  roots are what the result keeps.
- **Field-path sources.** `depends(item : self._buf)` lets a result
  borrow one field instead of the whole value. Position (maintainer,
  2026-10-13):
  - **Who may write one.** A field-path source is legal exactly where the
    path itself is: a private (`_`-prefixed) field only inside its type's
    private scope — the declaring module and its same-directory siblings,
    E0405's scope (`plans/reference/MEMBER_VISIBILITY.md`,
    `private_member_blocked`), the scope in-file `test(...)` declarations
    and sibling `*.test.yo` files already use. Code outside that scope
    can never write a clause that depends on another type's
    representation. A trait method cannot name fields of `Self`, so
    field-path sources appear only on a concrete type's own methods and
    free functions over it.
  - **What callers outside see.** A public method may carry the clause;
    to a caller that cannot name `_buf` the path is an opaque part of the
    argument, which the checker tracks without the caller's source
    mentioning it. Renaming the field breaks no caller; changing which
    fields a method borrows withdraws a promise, like widening any
    `depends` entry.
  - **The companion, without which outside callers gain nothing.**
    `e := xs.get_mut(0)` borrowing only `xs._buf` still conflicts with
    `xs.len()`, because `len(self : &Self)` reads all of `xs`. The payoff
    needs a second, declared clause stating which fields a method
    accesses (`len` reads only `self._len`) — a statement about access,
    not flow, so a separate clause from `depends`, and declared, never
    inferred ("Signatures, never bodies", R3). Inside the private scope
    the code reads `xs._len` directly and needs no companion.
  - **Phasing.** The scoping rule alone is cheap and serves module-
    internal code; it may land after N2. The access clause is designed
    and built together with any outside-facing use, once a counted need
    appears (decision 43's "bites" triggers).
- **`depends` in `yo doc`.** Whether `yo doc` prints the default clause
  on every reference-returning signature. Position: yes, so a reader sees
  the roots without reading the body.
- **Collecting through a lent closure's parameter.**
  `xs.for_each(x => out.push(x))` is rejected (R7). A refinement could
  let the callee's signature say where its slot's argument comes from
  (here `self.*`), so the literal's summary maps through it; it would
  need a source-side entry the clause grammar does not have yet. Position: not now; the borrowed `for` covers
  collecting, and the refinement waits for a counted need (decision 43's
  "bites" triggers).
- **Whether a `&`-holding value may be a `match` scrutinee by value.**
  Position: yes, decision 26's by-value match consumes it; bindings borrow
  through it.

## 8. Phases

| Phase | Lands | Gate |
| --- | --- | --- |
| N0 | the negative-test corpus written and failing | the tests fail for the right reason |
| N1 | the `TypeValue` reference variant, R1–R3 (both `depends` forms and their callee checks), `.*`/auto-deref/auto-borrow, `impl(&T, …)`, `FnMut`; `View(T)` in std as the first consumer (Generation A: user code only). A buffer container instantiated over a type containing a reference (`ArrayList(&T)`, `ArrayList(View(u8))`) is an error naming N2: R1 legalizes it only with the tracker. N1's tracker already implements R7 for non-container targets (calls, place writes, root places through references, closure summaries: a `&mut Option(&T)` grows from N1), so no N1 build accepts a join it cannot see | the corpus minus its container cases, the fast suite, fixpoint |
| N2 | root-joining containers: R7's tracker over buffers (unbounded growth, element place writes), the root-joining row of R1's table, std's container clauses (`push`, `pop`, `append`, the lookups); `iter()` on std's containers; adapter chains; `impl(&C, IntoIterator)` | the container cases of the corpus; decision 39's test requirement (growth mid-walk is a compile error for value roots, the pin panic for `Rc` roots) |
| N3 | the entry API, guards, parser remainders, the `FnMut` slots in std (Generation B, on the next seed) | the catalog's rewritten sections; CP0's rows for `slice` and `sort` |

After decision 42's Generation B and V2b; each phase is one PR or one
stack with one battery, per AGENTS.md.
