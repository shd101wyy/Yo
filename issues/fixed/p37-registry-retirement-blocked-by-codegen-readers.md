# Retiring `g_some_resolved_concrete` broke five things that resolutions-on-the-value had to learn

**Status:** FIXED 2026-09-28 on `tss/p37-registry-v2` (Phase 3 step 7 part 2).
**Found:** 2026-09-27, the first build of the branch (it had been written without being built).

The branch removes the id-keyed registry `g_some_resolved_concrete`. A SomeT's resolution travels
on the value (`SomeT.resolution`, read through `some_resolution`), and a per-specialization
resolution travels on the rebuilt SomeT that the specialization binds. `check ./src` and
`check ./std` stayed green; compiled programs broke. Each item below was measured with a
tree-built compiler: the probes, the variant matrix, and a `git bisect run` over the branch's
commits.

## 1. `Park` got two C structs (`incompatible pointer types` between two `Park`s)

Repro: `ch.collect(io)` on a `Channel(i32)`.

`_resolve_some_types_deep` (`evaluator/types/function.yo`) collected the SomeTs of a
parameter type and substituted what it learned by `(name, level)`. `IoFuture ::
Impl(Concrete(__yo_io_future_t), Future(i32))` carries its concrete type as its own
resolution (`impl_constraint.yo` builds it that way). The branch made the reader adopt that
resolution, which the registry never held, so `Park(_future : IoFuture)` was rebuilt with
the extern type in its field. The substitution was keyed `("Impl", 2)`, so every `Impl`
wrapper at that level was rewritten too.

**Fix:** a SomeT's own resolution is adopted there only when the env bound the slot to a
*different* SomeT (`_env_rebound_to_another_some`). That is where per-spec resolutions live now.
A slot the env leaves as itself keeps its declared form.

## 2. `ch.map(f).filter(g)` failed E0905 (`StreamFilter.next`'s body: bool vs i32)

`map`'s and `filter`'s closure binders are both `F` at frame level 4. The trace showed a
substitution whose only entry was `F@4 = <map's capture>` rewriting the
`StreamFilter(StreamMap(...), F)` return type. The builder was `_resolve_type_arg_somes`,
which had read the capture off the nested `map` `F` (inside `Self`'s type arguments). So the
filter called the map closure.

**Fix** (`types/substitution.yo`):

- A resolution read off a SomeT's own value is adopted by identity:
  `subst_adopt_own_resolution`. Each occurrence that carries a resolution is replaced by its
  own chain end. There is no id-to-type map, because two calls of one generic share binder ids.
- A SomeT that already carries a resolution is never rewritten by a `(name, level)` entry.
  Such an entry names another binder with the same spelling (the fix for the reverse
  direction: `filter`'s own `F := <g's capture>` rewrote the nested `map` `F`).

## 3. Two different `map` closures in one function: `unknown type name 'async_capture_…'`

Repro: `tests/async/combinators.test.yo`, "a consumer generic over Stream".
`stable_type_identity` rendered a SomeT field with `type_to_string`, which spells only the
binder (`F : (Fn(A) -> B)`). The capture struct of `StreamMap.next`'s `io.async` closure
therefore rendered the same for both closures. `collect_type` aliased the second
specialization's capture struct onto the first, and the async emitter's lookup by
`type_key` missed.

**Fix** (`types/type_key.yo`): the stable render of a SomeT is what it lowers to, meaning its
resolution chain's concrete end, or else its id.

## 4. `Map.map_values` failed `Expected: "Type" Given: "i32"` (`tests/imm_map.test.yo`)

Found by `git bisect run` over the branch (first bad commit `e969b2884`). The per-spec
Fn-result pre-binding (the replacement for the registry write under the closure result's
id) declared the binder variable with the closure's result type instead of `Type`. So `U` in
`_map_values_node(K, V, U, root, f)` read as a runtime `i32`.

**Fix** (`calls/helper.yo`): the variable is declared `t_type()`, like every other
pre-binding, and an anonymous `Impl(...)` result is not bound, because the name `Impl`
would shadow the builtin.

## 5. A closure stored in an `Impl(Fn)`-typed field: `initializing 'void *' with … __yo_tN`

Repro: `tests/impl_fn_field_rejection.test.yo`, "workaround B":
`GenericCb(Impl(Fn(x : i32) -> i32))(value : 7, cb : x => (x * 3))`. The branch deleted the
struct-constructor write that registered the field SomeT's id → the closure's capture struct
(`calls/type.yo`). That write was the only thing that gave the field a C type. It was also
last-write-wins across constructions: one annotation id, many closures.

**Fix:** the constructed value's type is the struct *instantiated over the closure identity* the
field received, in its field types and type arguments (`_instantiate_struct_over_closure_args`,
`calls/function.yo`). `TypeCallResult` now carries each field's argument type. Codegen builds
the call's own struct type rather than the callee's (`_constructed_struct_type`,
`codegen/exprs/other_fn_call.yo`). Two constructions with different closures are two
instantiations (new test: "each construction keeps its own closure").

## Superseded analysis

The earlier write-up said "`some_resolution`'s registry fallback is load-bearing for
codegen's SomeT lowering". It described the symptom, not the mechanism: none of the five
causes above is a codegen reader that needed the registry. The `Array.fill` FATAL it cited was a probe
artifact (corrected the same day).

## Tests

`tests/async/channel.test.yo`: "map then filter keeps each closure" (new) and the existing
"Stream combinators". `tests/impl_fn_field_rejection.test.yo`: "each construction keeps its own
closure" (new). `tests/async/combinators.test.yo`, `tests/imm_map.test.yo` and
`tests/impl_fn_field_rejection.test.yo` failed on the branch before these fixes and pass after.

Still open, and on develop too: a combinator used twice in one chain
(`issues/fixed/a-stream-combinator-used-twice-in-one-chain-emits-two-c-types.md`).
