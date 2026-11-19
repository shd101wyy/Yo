# A blanket `Hash` impl over `&T` rebinds a generic impl's key `K` to `&K`

**Severity:** S2 — a valid impl makes the compiler reject correct generic code, or recurse until it crashes: with
`impl(generic(T), where(T <: Hash), &T, Hash(...))` in scope, importing `std/collections/hash_map` segfaults the
compiler (rc=139, unbounded recursion), so G2 piece 3's blanket `Hash(&T)` cannot be added to std

Found 2026-11-13 by the `g2` lane rehearsing G2 piece 3 (VERDICTS-49, VERDICTS-58 decision 17) on the v0.2.77 seed.
The seed's evaluator is develop's (`6c90536aa` adds only codegen), so the tree compiler has the same defect.

## Reproducer

Develop's std, nothing else; the blanket is written above the generic impl (written below it, the impl is not forced in
time and the file checks, which is itself order-dependent):

```yo
pragma(Pragma.AllowUnsafe);
{ DefaultHasher } :: import("std/hash");
{ MapEntry } :: import("std/collections/entry");
impl(
  generic(T : Type),
  where(T <: Hash),
  &T,
  Hash(
    hash : (fn(generic(H : Type), self : &Self, hasher : &mut H, where(H <: Hasher)) -> unit)(())
  )
);
_M :: (fn(comptime(K) : Type, comptime(V) : Type, where(K <: (Eq(K), Hash))) -> comptime(Type))(struct(data : ?*MapEntry(K, V), k0 : u64));
impl(
  generic(K : Type, V : Type),
  where(K <: (Eq(K), Hash)),
  _M(K, V),
  _h : (fn(self : &Self, key : &K) -> u64)({
    mut(h) := DefaultHasher.new_with_keys(self.k0, self.k0);
    key.hash(&mut h);
    h.finish()
  }),
  get : (fn(self : &Self, key : &K) -> Option(u64))({
    hash := self._h(key);
    .Some(hash)
  }),
  get_ptr : (fn(self : &mut Self, key : &K) -> Option(*MapEntry(K, V)))({
    hash := self._h(key);
    .None
  })
);
export(_M);
```

```
error: A value of `Option(*(MapEntry(&K : ((== : fn(lhs : &Self, rhs : &K) -> bool, != : ...) + Hash), V)))` carries an
origin inside a container or a cell, which the remaining pieces of first-class storage open ...
  --> m8.yo:24:51
```

`MapEntry(&K, V)`: the impl's own binder `K` came back as `&K`. All three members are needed (`_h` with the `key.hash`
call, and two callers of `_h`), and so is the type constructor's `where(K <: (Eq(K), Hash))`; a trivial `_h` body, or
the same file without the blanket, checks. With the blanket in the prelude (G2 piece 3's placement), `import("std/
collections/hash_map")` alone recurses until the stack is exhausted (`YO_MAIN_STACK_MB=8192` only delays it); a 10-frame
cycle repeats in the backtrace. `Eq(&T)`, `Ord(&T)` and `ToString(&T)` in the same place do not trigger it.

## Root cause (not yet located)

R-PROBE probes `&K` for `key.hash(…)` because a bare-binder blanket registers `hash` (`reference_blanket_method_noted`).
The blanket's pattern `&T` matches `&K` with `T := K`; somewhere in that match, or in the specialization of `_h` that
the second caller reuses, the binding is written on the caller's binder `K` instead (`K := &K`), and the next
instantiation of `_M(K, V)` reads it. Candidates to check first: the generic-impl matcher's unification of a pattern
`&T` against a receiver whose pointee is a rigid `SomeT`, and the env a specialization of a member is cached under.

## What it blocks

G2 piece 3's `Hash(&T)` (VERDICTS-49): the v0.2.77 seed cannot stage-1-compile a std carrying it, so per the schedule's
rule `Hash` over `&T` moves to v0.2.79, behind a fix here and a seed carrying the fix. `Eq`, `Ord` and `ToString` over
`&T` are unaffected (rehearsed on the v0.2.77 seed).

## Test that will pin it

`tests/impl_ref.test.yo`: the reproducer above as a passing check, and a `HashMap(&String, i32)` insert and get once
`Hash(&T)` is in std.
