# A nested index call on generic impls calls an unspecialized method

**Severity:** S2 — valid programs are rejected by the C compiler: some nested element accesses through generic `Index`/`IndexMut` impls (`mm(i)(k) = v` with a move-only inner key, `o(i)(j)` on a user impl whose `Output` is a generic struct) pass `yo check` and call a C function that is never declared.

**Status:** FIXED 2026-10-20 (write reproducer fixed earlier; read reproducer fixed — see "Read half: root cause and fix"). Found 2026-10-17 while landing #1420 (a canary for the
review's write through a move-only key). Both reproducers fail the same way
with the develop-built `yo-dev-5425cd7bf`. Neither involves moving a named
local, so this is not
`issues/fixed/2026-10-17-an-index-call-that-moves-a-named-local-calls-an-unemitted-method.md`.
The cause is not yet known.

## Symptom

```text
error: call to undeclared function 'yo_id_11682532930570127216000000'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]
```

In the write case, the undeclared function is the outer access's
`index_mut`, the inner `HashMap(Dk, i32)`'s. The receiver's own access
(`mm(i32(1))`) is specialized and declared.

## Reproducers

A nested write whose inner key is move-only. Every key here is a
temporary, so nothing named is moved (this needs #1420's std, which
lets a move-only key into a `HashMap`):

```yo
{ HashMap } :: import("std/collections/hash_map");
Dk :: struct(n : i32);
derive(Dk, Eq(Dk), Hash);
main :: (fn() -> unit)({
  mm := HashMap(i32, HashMap(Dk, i32)).new();
  mm(i32(1))(Dk(n : i32(2))) = i32(7);
});
export(main);
```

A nested read through a user generic impl, with `i32` subscripts:

```yo
{ assert } :: import("std/assert");
Bag :: (fn(comptime(K) : Type) -> comptime(Type))(struct(v : i32));
impl(generic(K : Type), Bag(K), Index(K)(Output : i32, index : (fn(self : &Self, idx : K) -> &Self.Output)(&self.v)));
Outer :: (fn(comptime(K) : Type) -> comptime(Type))(struct(inner : Bag(K)));
impl(generic(K : Type), Outer(K), Index(K)(Output : Bag(K), index : (fn(self : &Self, idx : K) -> &Self.Output)(&self.inner)));
main :: (fn() -> unit)({
  o := Outer(i32)(inner : Bag(i32)(v : i32(9)));
  assert(o(i32(1))(i32(2)) == i32(9), "nested");
});
export(main);
```

## What passes and what fails

All of these were compiled with #1420's compiler and std. The two
reproducers above fail the same way with the develop binary.

| Access | Outer key | Inner key | Result |
| --- | --- | --- | --- |
| `HashMap` of `HashMap`, read | move-only, named | move-only, named | compiles and runs |
| `HashMap` of `HashMap`, write | `i32` | `i32` | compiles and runs |
| `HashMap` of `HashMap`, write | a `Copy` struct | a `Copy` struct | compiles and runs |
| `HashMap` of `HashMap`, write | move-only, named | `i32` | compiles |
| `HashMap` of `HashMap`, write | `i32` or move-only, named or temporary | move-only, named or temporary | undeclared `index_mut` |
| user `Outer(K)` of `Bag(K)`, read | `i32` | `i32` | undeclared method |

So the write fails whenever the inner `index_mut`'s key is move-only and its
receiver is itself an index call. The single-level write with a move-only key
compiles (`tests/index.test.yo`, "IndexMut: a write through a generic impl
with a move-only named key").

## Where to look

`_specialize_index_method` (`src/evaluator/calls/index_trait.yo`) runs a
trial call whose exception is swallowed. When the trial throws, the access
keeps the generic method value, which codegen never emits. For a nested
access, the trial re-evaluates the receiver, which is itself an index call,
and `_promote_index_call` then runs it again for the write. Printing the
swallowed error in the trial's handler would show which rule fails.

## Root cause (measured 2026-10-18, probe build with dispatch prints)

Two independent mechanisms, one per reproducer.

**The write** (`mm(i)(k) = v`, move-only inner key): the trial's synthetic
call `index_mut(mm(i), k)` replays the desugared access through the whole
user-call machinery, and `require_valid_ref_argument_places`
(`src/types/flowability.yo`) judges it by the USER-call contract: the
receiver `mm(i)` is an index place borrowing into `mm` while the key `k`
sits beside it as an Rc value — exactly the shape
`_reject_if_container_reachable` part (b) conservatively rejects. The throw
is swallowed, the access falls back to the unspecialized generic method,
and codegen calls a C function it never declares. The rule never fires on
the REAL index path — the single-level `mm(k) = v` receiver is a bare atom,
not an index-place call — so only the replayed trial ever saw it.

**The read** (`o(i)(j)` through user generic impls): the generic-impl method
substitution (`find_methods_from_generic_impls`,
`src/evaluator/values/impl.yo`) re-keys the impl's binders by (name, level)
entries, but `substitute` (`src/types/substitution.yo`) deliberately never
consults those entries for a SomeT that carries its own resolution cell. The
constructor-parameter binder stored inside `Bag(K)` — the `Output : Bag(K)`
application over the impl's generic — is exactly such a cell (it resolves to
the impl's `K`), so the substituted method type kept a raw `Bag(K)`: the
params were concrete, the RESULT was not. The element type the
outer access published (and the nested access used as its receiver) stayed
generic, the inner specialization minted with a `Bag(K)`-typed self, and the
outer access's own specialization was dropped by
`should_skip_function_codegen` skip2 (`has_generic_return`) while its call
site stood: `yo_id_7183..._rtparam0_gs_..._ret_gs_yo_id_3219...` is
registered, called, and never declared.

## Fix

- **The WRITE reproducer is fixed**: the trial sets
  `ctx.index_specialization_trial_recv_id` around
  `_specialize_index_method_trial`, and `_reject_if_container_reachable`
  skips the rule for THAT receiver only (other calls the trial re-evaluates
  keep it). The desugared index access is the sanctioned spelling; the real
  path never ran the rule.
- **The READ reproducer is still open** (narrowed 2026-10-19 with a
  `YO_DEBUG_SUBST` probe build): of 43 K-binder substitution hits in the
  reproducer, 31 rewrite fine through `(K,3) -> i32`; the two that answer
  `found=no` carry `map=Self@3` — they belong to the SELF-baking pass
  (`subst_set_self`), which correctly ignores `K`. The generic-impl
  substitution pass whose map carries `(K,3)` therefore never VISITS the
  `Bag(K)` type-argument at all — the type_arguments level re-key
  (`get_all_some_types_with_type_args`) and `substitute`'s chain-following
  fallback were both tried and are harmless but UNREACHED. The remaining
  question is why the walk from the substituted method type's result stops
  before the instantiation's type arguments (candidate: a nominal-boundary
  or memo arm between the result node and the argument). Probe logs:
  `YO_DEBUG_SUBST=1 YO_DEBUG_DISPATCH=1`, `/tmp/probe6-run4.log`.

## Read half: root cause and fix (2026-10-20)

Measured with probe builds on the read reproducer and four narrowed
variants:

- **Neither nested nor `Index`-specific.** The single-level read
  `o(i32(1)).v` fails the same way, and so does a user parameterized
  trait `Getter(Idx)` whose `Output : Bag(K)` is returned by reference or
  by value. A non-parameterized trait, a plain method `-> &Bag(K)`, and a
  by-value `Index` read all compile.
- **Phantom-only.** With `Bag :: struct(v : i32, _k : Option(K))` (a field
  mentions `K`) every variant compiles. `K` lives only in `Bag(K)`'s type
  arguments, and `get_all_some_types` does not walk type arguments
  (`issues/generic-inference-ignores-phantom-type-arguments-of-structs.md`
  is the same blind spot on the inference side).
- **The generic-impl substitution is correct.** The method value's result
  key rewrites from the raw `Bag(K)` to `Bag(i32)`, so the
  resolution-cell diagnosis in "Root cause" above does not hold for this
  reproducer.

Two places in `create_specialized_function_inline`
(`src/evaluator/calls/helper.yo`) decided "concrete" with
`get_all_some_types` alone:

1. The **return probe** that keys the specialization re-evaluated the
   declared return only when `get_all_some_types` found a SomeT. For
   `&Bag(K)` it found none, so the key kept the impl's binder:
   `..._ret_gs_<Bag>_4231`. That is also wrong for a second instantiation
   (`Outer(u8)` would share the `Outer(i32)` key).
2. The **return-expression re-evaluation** (the `rte_era_suspect` path)
   re-evaluated `&Self.Output` against the receiver, got the impl-era
   `&Bag(K)`, and adopted it as the specialization's return because no
   SomeT was visible. The specialization was then registered with a generic
   result, and `should_skip_function_codegen` dropped it (skip2,
   `has_generic_return`) while the call site still named it. With probe 1
   fixed alone, the call named `..._ret_gs_<Bag>_i32` and nothing was
   emitted under that name (`[skipfn] ... gr=true ret=gs_<Bag>_4231`).

**Fix:** both places also collect the type-argument SomeTs
(`_collect_type_arg_somes`). The probe re-evaluates when either list is
non-empty, and the re-evaluated return is adopted only when neither is,
except for the existing closure carve-out: a type argument that is this
call's own closure-typed forall argument (`arc(f) -> Arc(V)`) still adopts.
Regression tests: `tests/index.test.yo` ("Index: a nested read through
generic impls whose Output has a phantom parameter", at `i32` and `u8`) and
`tests/impl.test.yo` ("a trait method returning a phantom-parameter Output
resolves per instantiation").
