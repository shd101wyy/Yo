# How the checker knows that a type is interior-mutable

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN — raised 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §4 D6). Nothing is unsound today: every cell over an
origin-carrying payload is rejected (E0909, "carries an origin inside a container or a cell") until N2d lands. The
decision is needed before N2d lifts that wall.

## What the rule needs

`plans/backlog/REFERENCES_AND_ORIGINS.md` O3 step 3 makes an origin invariant when it is "reached through a `&mut`
pointee, a `RefCell` payload or a `&mut` capture". The `RefCell` clause exists because a `&RefCell(&(T, p))` can be
written through: were `p` allowed to widen along the `&`, a callee could store a shorter-lived reference into the
caller's cell. The same holds for every type whose `&self` methods write the payload: `Mutex`, `RwLock`, `OnceCell`,
the atomics, a `Channel`'s buffer, and whatever std adds later. The rule as first written named one of them.

Safe code cannot define such a type: a write through `&self` needs `Pragma.AllowUnsafe`. So the set is std's (and
that of any package that opts into unsafe code), and the question is how a member of the set is made known to the
checker:

```yo ignore
store :: (fn(generic(T : Type, r : Origin), dst : &Mutex(Option(&(T, r))), v : &(T, r)) -> unit)(…);
x := i32(1);
slot := Mutex(Option(&(i32, x))).new(.Some(&x));
{
  y := i32(2);
  store(&slot, &y);   // must be E0923: `r` is fixed to `x` by `dst`. Covariant, it widens to `(x, y)`.
}
```

## Options

1. **A name list in the checker.** `RefCell`, `Mutex`, `RwLock`, `OnceCell`, `Atomic*`, … are recognized by
   constructor identity. Cheap, and wrong the first time a cell is added without the list being edited: the
   failure is silent (the new cell is covariant) and is an accepted use-after-free.
2. **One primitive cell every interior-mutable type is built from** (Rust's `UnsafeCell`). A type is
   interior-mutable iff it structurally contains the primitive; an origin under the primitive's payload is
   invariant. The predicate is derived like `Send`/`Escapable`, so a new cell cannot forget to opt in. The cost is
   one std refactor (each cell's payload field becomes `UnsafeCell(T)`), and a rule for unsafe code: writing through
   a `&` path that does not pass through the primitive is undefined, which is what the D3 mutation walk already
   assumes of `Arc` payloads.
3. **A declaration-site marker** (a pragma or a marker trait on the type) plus a lint over pragma'd bodies: a
   `&self` method whose mutation summary writes `self` on a type without the marker is an error. Explicit, but the
   lint is the mutation summary again, and the audit showed (A6) how far a body-derived summary can be trusted.

## Recommendation

Option 2, landed with N2d. Until then, option 1 with the full std list written into N2d's Generation A, and a test
that enumerates std types having a `&self` method whose body writes `self` (the mutation summary can list them) and
fails when one is missing from the list. Option 3 is rejected: it makes soundness depend on the same body-derived
summary the audit found unfit to weaken a `&mut` argument.

The same predicate answers two neighbouring questions and should be the single source for them: whether a type is
`Sync` (an interior-mutable type is not, unless it declares its own synchronization), and whether a module-level
binding of the type may be read through a `&` across a call (decision 18 rule 3).
