# A blanket `Hash` impl over `&T` rebinds a generic impl's key `K` to `&K`

**Severity:** S2 — a valid impl makes the compiler reject correct generic code, or recurse until it crashes: with
`impl(generic(T), where(T <: Hash), &T, Hash(...))` in scope, importing `std/collections/hash_map` segfaults the
compiler (rc=139, unbounded recursion), so G2 piece 3's blanket `Hash(&T)` cannot be added to std

**Status:** FIXED 2026-11-19 on branch `v0279/blanket-hash` (Hash lane): the occurs check looks inside a reference, and a
generic slot whose type is the argument's referent takes the referent. Not `Hash`-specific: the prelude's own `Ord(&T)`
triggered it on develop with no user code beyond a `a.cmp(b)` call (below).

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

## Root cause

Two defects in the synthesizer's handling of a reference, found by tracing every binding of `K` (`YO_DEBUG_BIND=K` plus
temporary prints in `_bind_some_type` and `check_if_function_parameter_matches_argument`).

1. **The occurs check did not look inside a reference.** `_occurs_check` (`src/evaluator/types/synthesizer.yo`) walks
   structs, enums, tuples, arrays, functions and trait types, but had no arm for decision 43's `Reference` node (nor
   `ValueSlot`), so `&K` fell to `_ => false` and `K := &K` passed as a finite binding.

2. **Where `K := &K` came from.** `_h`'s body calls `key.tr(…)` (`key.hash(…)` in `hash_map`) on `key : &K`. R-PROBE adds
   the reference lookups because a bare-binder blanket registers the method (`reference_blanket_method_noted`), and the
   lookup on `&K` matches the blanket at `T := K`, so `_select_matching_overload` trial-calls a candidate whose receiver
   slot is `self : &Self` at `Self := &K`. The receiver place `key` has type `K`. Parameter synthesis unifies the slot
   type `&K` with the argument type `K`; inside the impl's definition-time trial `K` is self-bound, so the GIVEN-side
   branch binds the caller's own `K := &K` — legal once the occurs check missed it — and the trial then passed
   (`[param-check] label=self declared=&K final=&K arg=K compat=true`). The binding is written into the argument's
   environment. In `get`'s trial it shadowed in a scratch frame; when `get_ptr`'s call re-entered `_h`'s block body, the
   top frame of that environment was the frame holding `K`'s binder (frame level 3, the impl's), and `_bind_some_type`
   updated it in place (`[bind-T] val=&K slot_lvl=3 top=3 inplace=true`). `get_ptr`'s signature then read `K` as `&K`:
   `Option(*MapEntry(&K, V))`, a reference in a container. With the blanket in the prelude, `HashMap`'s `K <: Hash` made
   `&K <: Hash` re-match the blanket at `T := &K`, and so on — the unbounded recursion.

The first defect is the cause: `K := &K` is an infinite type and must never bind. With it fixed the trial fails cleanly
(the blanket candidate does not take a receiver place of type `K`) and no binding is written. The fix then exposed a
second reliance on the same infinite binding, in the prelude's blanket `Eq(&T)`: `T.(==)(lhs.*, rhs.*)` passes `lhs.*`
(a `&T` value, `lhs : &&T`) to `T.(==)`'s `lhs : &Self` at `Self := T`. `reference_argument_as_referent` (VERDICTS-49 gap
4) binds such an argument as its referent, but kept it whenever the slot type mentioned a type variable, so the
definition-time check bound `T := &T` to make it fit. A slot whose type IS the referent (identical `type_key`, type
variables included) now takes the referent too: there is nothing to infer, and the only other reading is the infinite
binding. A specialization (`T := i32`) already took that path.

### Why `Eq(&T)` and `Ord(&T)` did not show it in `hash_map`

Nothing specific to `Hash`: any method a blanket over `&T` provides, called by name on a `&K` receiver inside a generic
body, triggers the trial. `hash_map` calls `key.hash(…)` but compares keys with the `==` operator, which selects through
`_operator_reference_operand` (no trial call of each candidate), and calls no `Ord`/`ToString` method on a key. Calling
the prelude's `Ord(&T)` method by name reproduces it on develop with std alone:

```yo
{ ArrayList } :: import("std/collections/array_list");
_OEntry :: (fn(comptime(K) : Type) -> comptime(Type))(struct(k : K));
_OMap :: (fn(comptime(K) : Type, where(K <: Ord(K))) -> comptime(Type))(struct(data : ArrayList(_OEntry(K))));
impl(
  generic(K : Type),
  where(K <: Ord(K)),
  _OMap(K),
  _c : (fn(self : &Self, a : &K, b : &K) -> bool)({
    o := a.cmp(b);
    match(o, .Less => true, _ => false)
  }),
  lt : (fn(self : &Self, a : &K, b : &K) -> bool)(self._c(a, b)),
  entries : (fn(self : &Self, a : &K, b : &K) -> Option(ArrayList(_OEntry(K))))({
    l := self._c(a, b);
    cond(l => .None, true => .Some(ArrayList(_OEntry(K)).new()))
  })
);
```

`error: A value of Option(ArrayList(_OEntry(&K : …)))` carries an origin inside a container. The members need block
bodies: with expression bodies the in-place write lands in a frame `entries` does not read.

### Not changed

A failed overload trial's given-side bindings still go to the argument's environment rather than a scratch frame
(`try_match_generic_impl` isolates its given side; parameter synthesis does not). With the occurs check whole, the trials
seen here bind nothing. No other leak was observed, so that isolation is left as it is and filed as the latent
`issues/2026-11-19-a-failed-overload-trials-given-side-bindings-land-in-the-arguments-environment.md`.

## What it blocked

G2 piece 3's `Hash(&T)` (VERDICTS-49): the v0.2.77 seed cannot stage-1-compile a std carrying it, so per the schedule's
rule `Hash` over `&T` moved behind this fix and a seed carrying it. The rehearsal note "`Eq`, `Ord` and `ToString` over
`&T` are unaffected" held only for what `hash_map` calls: `Ord(&T)` reaches the same trial through `a.cmp(b)` (above).

## Tests

`tests/impl_ref.test.yo`: "a blanket impl over &T leaves a generic impl's key binder K, not &K" (a user blanket over
`&T` with `Hash`'s method shape beside a generic container keyed on `K <: (Eq(K), …)`) and "the prelude's Ord(&T) leaves
a generic impl's binder K when `a.cmp(b)` runs on `a : &K`" (std alone). Both fail on develop `939fe7160` with the
container error above and pass with the fix. A `HashMap(&String, i32)` test lands with `Hash(&T)` in std.
