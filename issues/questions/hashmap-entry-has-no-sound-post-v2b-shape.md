# `HashMapEntry` stores a loan of its map and has no sound post-V2b shape (OPEN-DESIGN)

**Kind:** design question — an open decision, not a defect. Filed 2026-10-10
from the `plans/backlog/RUST_REFERENCE_PATTERNS.md` audit (§4.5), verdict
supplied by the session carrying the V3b stack (`feat/vbd-v3b-markers-a`).

## The hole

Rust's `HashMap::entry(k)` returns `Entry<'a, K, V>`, a value that holds
`&'a mut HashMap` and resolves the slot once. std's port
(`std/collections/hash_map.yo`, `HashMapEntry`) is

```yo ignore
HashMapEntry :: (fn(comptime(K) : Type, comptime(V) : Type) -> comptime(Type))(
  struct(_map : HashMap(K, V), _key : K, _hash : u64, _slot : BucketProbe)
);
```

`_map` is a stored loan of the map. It is sound today only because `HashMap`
is still a counted handle. Under VALUES_BY_DEFAULT:

- decision 38 A forbids a borrow in a field, so `imm(_map)` / `mut(_map)`
  cannot be spelled there;
- decision 24's projections (`-> mut(T)`) may not be bound, stored or
  returned, so `entry()` cannot hand back a place either;
- once the collections are values (V2b) the field is a **copy or a move of
  the map**, not a loan: `counts.entry(w).or_insert(0)` would mutate a copy.

The only second-class values are closures and futures; there is no
"second-class record" mechanism. `issues/collection-iterators-have-no-sound-post-v2b-shape.md`
has the same root (a stored borrow of a container in a returned value).

## Options

1. **Closure-taking methods only.** `get_or_insert(k, v) -> V`,
   `get_or_insert_with(k, f) -> V` and `update_with(k, f) -> bool` already
   exist on `HashMap`; `entry()` and `HashMapEntry` are deleted. `or_insert`'s
   `&mut V` result becomes the value out (a copy or a clone) or a `with`-shaped
   body.
2. **(1) plus a `mut` projection form of `or_insert`.**
   `get_or_insert_with(k, f) -> mut(V)` (decision 24): usable as a receiver,
   an argument or the left of `=`, never bound — Rust's
   `*map.entry(k).or_insert(0) += 1` becomes
   `map.get_or_insert_with(k, () => 0) = (map.get_or_insert_with(k, () => 0) + 1)`
   or, cleaner, `map.update_or_insert(k, 0, n => n + 1)`.
3. **A second-class record decision**: let a struct declare borrow-mode
   fields (`struct(mut(_map) : HashMap(K, V), …)`) that make the value
   second-class under 38 A's structural rule, with A2's return exception
   generalized to values rooted at the callee's own parameters. Decision 39
   recorded this as "for later, not adopted", triggered together with
   decision 37's parked stateful call.

## Recommendation

Option 2. It is what the rules already permit, it keeps the single-probe
cost at the sites that matter (`or_insert_with` resolves the slot once,
inside the projection), and it adds no mechanism. The `Occupied`/`Vacant`
split goes away: a caller who needs to branch on presence uses
`contains_key` or `update_with`'s `bool`. Option 3 is the right answer only
if adapter chains and entry-like loans both prove common enough to justify
the escape machinery, and that is decision 39's trigger, not this
question's. Lands with V2b's collections PR, which is where `_map` stops
being a handle.
