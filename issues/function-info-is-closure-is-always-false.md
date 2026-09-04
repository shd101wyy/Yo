# `FunctionInfo.is_closure` is hardcoded `false`, so reflection reports every `Fn` trait as a non-closure

**Found**: 2026-09-04, by the std-API-audit coverage read — `FunctionInfo` is
reachable from `tests/type_reflection.test.yo`, but its `is_closure` field is
never asserted anywhere, and the compiler's only construction site writes a
literal `false`. **Class**: api-lie (a documented public reflection field that
cannot report the thing it names). **Status**: OPEN.

## Symptom

`std/prelude.yo:6120-6131` declares

```rust
FunctionInfo :: struct(
  params : ComptimeList(ParamInfo),
  return_type : Type,
  forall_params : ComptimeList(ForallParamInfo),
  implicit_params : ComptimeList(ImplicitParamInfo),
  /// `true` if this is a closure type.
  is_closure : bool
);
```

It is always `false`.

```rust
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  PlainFn :: (fn(x : i32) -> i32);
  plain_info :: Type.get_info(PlainFn);
  plain_closure :: match(plain_info, .Function(fi) => fi.is_closure, _ => false);

  FnTrait :: (Fn(x : i32) -> i32);
  trait_info :: Type.get_info(FnTrait);
  trait_is_trait :: match(trait_info, .Trait(_, _) => true, _ => false);
  trait_closure :: match(trait_info, .Trait(_, k) => match(k, .Fn(fi) => fi.is_closure, _ => false), _ => false);

  println(`plain fn type   .Function(fi).is_closure = ${plain_closure}`);
  println(`Fn trait        reflects as .Trait       = ${trait_is_trait}`);
  println(`Fn trait  .Trait(_, .Fn(fi)).is_closure  = ${trait_closure}`);
});
export(main);
```

Observed (`yo compile … --optimize 2`, yo 0.2.24):

```
plain fn type   .Function(fi).is_closure = false
Fn trait        reflects as .Trait       = true
Fn trait  .Trait(_, .Fn(fi)).is_closure  = false
```

Expected: the first `false` is right (a bare `fn(...)` type is not a closure);
the third must be **`true`** — the call type behind an `Fn(...)` trait is
exactly the closure case the field exists to name.

## Root cause

`_ti_bind_function_info` (`src/evaluator/builtins/type_fns.yo:913-1031`) is the
**only** place a `FunctionInfo` is ever built — `grep -rn 'FunctionInfo' src
--include='*.yo'` finds three hits in that file and nothing else that
constructs one (every other hit in `src/` is the unrelated
`SpecializingFunctionInfo`). It assembles the constructor call as source text
and ends it with a literal:

```rust
fni_code.push_str(", false)");            // src/evaluator/builtins/type_fns.yo:1011
```

Both callers go through it — the `.Func` arm at `type_fns.yo:1323` (which
becomes `TypeInfo.Function(fi)`) and the `.FnTraitT` arm at `type_fns.yo:1281`
(which becomes `TypeInfo.Trait(_, TraitKind.Fn(fi))`) — so no reflected
`FunctionInfo` can ever carry `true`.

This is an unwired port, not a missing capability. The retired TypeScript
compiler read the flag off the type:

```ts
const isClosureStr = fnType.isClosure ? "true" : "false";   // src-attic-final:src/evaluator/builtins/type-fns.ts:1100
```

and set it in exactly one place — the `Fn` trait's call type:

```ts
const fnType = createFunctionType({ …, isClosure: true });  // src-attic-final:src/evaluator/types/fn-trait.ts:121
```

The Yo port has no carrier for it: `FuncMeta` (`src/types/definitions.yo:33-101`)
mirrors `result_is_comptime_only`, `param_is_ref`, `param_is_owning`,
`is_control`, `has_variadic`, `is_extern` … but has no `is_closure`, so
`type_fns.yo` had nothing to read and the `false` was written in its place. The
evaluator does track closure-ness elsewhere — `is_closure_fn`
(`src/function_value.yo:67`), a `func_id`-keyed side table read at
`src/evaluator/calls/helper.yo:2715` — but that is keyed by function id, not
reachable from a bare `TypeValue`.

That explains the `.Func` arm. It does **not** explain the `.FnTraitT` arm: that
arm is entered only for an `Fn(...)` trait type, so it needs no carrier at all —
`true` is the structurally correct answer there, and it still writes `false`
only because both arms share the one hardcoding helper.

## Fix

Two layers, and the first one alone already makes the field truthful for the
case it names.

**1. The `.FnTraitT` arm — structural, no plumbing needed.** That arm
(`type_fns.yo:1281`) is reached only for an `Fn(...) -> T` trait type, which is
*by construction* a closure call signature — `src/types/guards.yo`'s TS
counterpart says so outright: "This replaces the old isClosureType — closures
are now TraitTypes with isFn set" (`src-attic-final:src/types/guards.ts:229`).
Give `_ti_bind_function_info` an `is_closure : bool` parameter, replace
`type_fns.yo:1011`'s literal `", false)"` with it, pass `true` from the
`.FnTraitT` arm and `false` from the `.Func` arm at `type_fns.yo:1323`. That is
a handful of lines in one file and no type-system change.

**2. Full parity for the `.Func` arm — needs a carrier.** In the TS compiler the
flag also reached ordinary `FunctionType`s: an anonymous function checked against
an expected `Fn` trait inherited it, because
`anonymous-function.ts:597-638` SPREADS the expected type into the new function
type (`anonymous-function.ts:886` then reads `newFunctionType.isClosure`). Yo's
`FuncMeta` (`src/types/definitions.yo:33-101`) has no `is_closure` field, so
nothing survives that path. To match, add

```rust
(is_closure : bool) ?= false
```

to `FuncMeta` — defaulted, so the 20+ existing construction sites are
unaffected; the same treatment `origin_id` already got there — set it when an
anonymous function is typed against an `FnTraitT` (`src/evaluator/calls/closure_type.yo`,
the Yo counterpart of the TS spread), let it ride the existing `meta.clone()`
paths, and read it in the `.Func` arm instead of hardcoding `false`.

Do layer 1 first and land it with its test; layer 2 is a separate,
larger change and should not hold layer 1 up.

**The alternative — delete the field** — should be rejected. It is documented
public reflection surface, the information exists in the evaluator, and freezing
a field that is provably always `false` is the same shape as the `HttpError`
variants that were declared and never constructed (C33) and the
`JsonError.InvalidNumber` that led to C34.

Gating: this touches the evaluator, so `yo check ./src`, then
`yo compile src/main.yo --skip-c-compiler` (the async/state-machine rules that
`check` cannot see), then `scripts/bootstrap/gates_fast.sh` and
`fixpoint_only.sh`.

## Regression test

`tests/type_reflection.test.yo`, next to the existing
`"TypeInfo compound: Function info"` test, red before the fix:

- `TypeInfo: an Fn trait's call info is a closure` —
  `comptime_assert` that `Type.get_info((Fn(x : i32) -> i32))` matches
  `.Trait(_, .Fn(fi))` with `fi.is_closure == true`.
- `TypeInfo: a plain fn type is not a closure` — the baseline against
  over-correction: `Type.get_info((fn(x : i32) -> i32))` matches
  `.Function(fi)` with `fi.is_closure == false`. This one passes today, which is
  precisely why it is needed.

## Breaking change

Yes, for anyone who has coded around the constant. Any user reflection or
derive macro that today branches on `fi.is_closure` is dead code taking the
`false` path; after the fix the `Fn`-trait path starts taking the `true` branch.
That is the field working as documented, but it changes behaviour and belongs in
the release notes.
