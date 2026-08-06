# Stage-2: `String != str` / `String == str` → "call to undeclared function fn_yo_id_2230" (5 errors)

> **FIXED — verified 2026-08-06.** The "uncommitted" fix4 described below WAS
> committed as `d72e5080d` (2026-07-06: gate broadened via
> `_func_type_has_runtime_some_param`, abstract func type fed to
> `create_specialized_function_inline`, `ctx.self_type` threaded on the infix
> path — all three live in `yo-self/evaluator/calls/helper.yo` /
> `function.yo` today). The residual (~1 err, dot-call overload pick inside
> the specialized body) closed with the stage-2 error burn-down that followed:
> `65ebcdbb2` (2026-08-03) records stage-2 clang 0 errors / FIXPOINT
> RESTORED, and the standing stage-2 invariant since `ff1bffa58`
> (2026-08-06) is 0 markers and **0 undeclared ids**. Re-verified today on
> the post-fix-batch stage-1 binary (`/tmp/yo-stage1`, Aug 6): the minimal
> repro below compiles clean (rc=0, 0 FTT markers, 0 undeclared) and runs
> correctly (`check(s)` → `true`). Historical metrics below are frozen at
> their writing dates (60-error baseline, corpus 103).

## Symptom

Stage-2 self-compile emits `fn_yo_id_2230((__yo_t2)(lhs), (__yo_str){...})` (a
`(String, str) -> bool` call) at ~8 sites (`caller_c_type != "void"` in
await.yo:487, `optimize == ""`, `label == "..."`, …) but **never defines**
`fn_yo_id_2230` → clang `call to undeclared function`. This is the
**String==str family** (5 of the 60 stage-2 errors as of commit 9f95c203a).

## Minimal repro

```rust
open(import("std/string"));
check :: (fn(s : String) -> bool)(s != "void");
main :: (fn() -> unit)({ x := String.from("hello"); if(check(x), {}, {}); });
export(main);
```

`/tmp/yo-self-bin compile repro.yo --emit-c` → `fn_yo_id_2230(...)` called, undefined.
**TS compiles the SAME file clean** (`./yo-cli compile` → 0 errors).

## Root cause (fully traced)

`fn_yo_id_2230` is the **`Eq` trait's `!=` DEFAULT lambda**
(`(lhs, rhs) -> not(Self.(==)(lhs, rhs))`, prelude.yo:637). It is created ONCE
at trait-definition time (hence the low, deterministic id 2230) with its
**abstract** type `fn(lhs : Self, rhs : Rhs) -> bool` and is SHARED across every
`Eq` instantiation.

For `String != str`:

- The infix-operator path (function.yo:1315+) resolves the method. The
  `MethodEntry.ty` gets `Self`-substituted (impl.yo:2361
  `_substitute_self_in_method_ty`) → the type PASSED to
  `try_to_call_function_with_arguments` (`first_m.ty`) is **concrete**
  `fn(lhs : String, rhs : str)`. (Verified via probe: `func_type` at the gate =
  concrete, `has_some=false`.)
- BUT the callee VALUE stays the shared abstract lambda `fn_yo_id_2230`, whose
  OWN registered type (`get_func_type("fn_yo_id_2230")`) is still the abstract
  `fn(lhs : Self, rhs : str)` (`Self` unsubstituted; `Rhs`→`str` got applied but
  `Self` did not). (Verified via probe at codegen.)
- **Codegen emission** `should_skip_function_codegen` (declarations.yo:456) reads
  the FuncVal's OWN registered type via `get_func_type` → abstract →
  `is_function_type_hard_generic` = TRUE (SomeT `Self` param w/o resolved
  concrete) → `skip_unemittable` = TRUE → the body is **skipped**.
- **Collection** `find_function_calls_in_expr` (collection.yo:553) registers it:
  its skip predicate `_is_generic_unspecialized_func` only checks
  `forall_labels || expr_param` (both 0 for this lambda) → NOT skipped → the
  call is emitted with the registry c_name `fn_yo_id_2230`.
- Net: **collection registers the call, emission skips the body → undeclared.**

### Why TS works

TS **specializes** the `!=` default lambda per-instantiation into a FRESH
function `fn_..._id_47035__u33__u61_` with a **concrete** `(lhs : String, rhs :
str)` type, whose body calls the concrete `==(String, str)` (`id_282`). TS's
specialization GATE is `isFunctionTypeGeneric(functionValue.type)` (helper.ts:1917),
and `isFunctionTypeGeneric` returns true for **any non-Future SomeType param**
(guards.ts:471, `hasSomeTypeParams`). TS keys on the FuncVal's OWN (abstract)
type → sees `Self` → specializes.

### Why yo-self diverges

Two coupled gaps:

1. yo-self's specialization gate (helper.yo:3048) keys on
   `fl.len()>0 || il.len()>0 || fv_has_forall` — **misses the SomeType-param
   case** that TS's `isFunctionTypeGeneric` catches.
2. Even keying on the FuncVal's own abstract type (attempted — makes `is_gen=true`),
   `create_specialized_function_inline` is passed the _already-concrete_
   `first_m.ty` (not the abstract type), so it has no SomeT params to bind and
   returns the original shared lambda (id 2230) unchanged — no fresh concrete
   function is minted.

## Fix direction (focused session)

Make the `!=`/`==` default lambda specialize into a fresh concrete function
(mirroring TS id_47035). The specialization must receive the **abstract** func
type (`get_func_type(callee_func_id)`, `fn(lhs : Self, rhs : Rhs)`) + the concrete
args, so `create_specialized_function_inline` binds `Self`→String, `Rhs`→str,
mints a fresh func_id, registers its concrete type, and specializes the body's
`Self.(==)` to the concrete `==`. The infix path already stamps
`call_result_op.specialized_function_value` as the callee (function.yo:1606), so
once a real specialization is produced the callee auto-updates.

Delicate (regression-prone — see plans/archive/YO_SELF_STAGE2_FIXPOINT_ROADMAP.md's
specialization history): broadening the gate to all SomeType-param functions +
feeding the abstract type to create_specialized affects every generic call, and
`Self`-body-resolution during specialization (ctx.self_type ← receiver) must be
threaded on the infix-operator path. Validate corpus + std + stage-2 hard.

### LANDED (fix4 — validated, uncommitted): stage-2 60 → 56, corpus 103/103 (DIFF 0), std 152/152

Three coupled changes make the `!=` default lambda per-instantiation specialize:

1. **helper.yo gate** (`try_to_call`, step 12b): `is_func_generic` now also ORs
   `callee_own_generic` = `_func_type_has_runtime_some_param(get_func_type(callee_func_id))`
   — the FuncVal's OWN registered (abstract) type, mirroring TS
   `isFunctionTypeGeneric(functionValue.type)`. New helper
   `_func_type_has_runtime_some_param` = any non-Future SomeType param.
2. **helper.yo spec_template**: when the FuncVal's own type is generic but the
   passed `func_type` was pre-substituted concrete, feed the ABSTRACT own type to
   `create_specialized_function_inline` so it has SomeT params to bind. (Its
   existing `register_func_type` path at helper.yo:~1584 already builds concrete
   `spec_param_types` from `runtime_param_tys` = arg types → fresh id
   `fn_yo_id_2230_rtparam0_<String>_rtparam1_str_ret_bool`, concrete type registered.)
3. **function.yo infix path**: thread `ctx.self_type = receiver_ty` around the
   operator's `try_to_call`, so the specialized body's `Self.(==)` resolves `Self`
   to the receiver (create_specialized only reconstructs self_type from a param
   named `self`; the lambda's first param is `lhs`).

Result: the fresh concrete `!=` fn is emitted; all 5 `fn_yo_id_2230`
undeclared-function errors clear. RESIDUAL (~1 err): the specialized body's
`Self.(==)(lhs, rhs)` (a dot-call) picks the `Eq(String).==` (String,String)
overload instead of the `(String, str)` one — see below.

### RESIDUAL — inner `Self.(==)` picks wrong overload

`String == str` at an INFIX site resolves correctly to the `(String, str)` `==`
(`eq_str`'s memcmp body). But `Self.(==)(lhs, rhs)` inside the specialized `!=`
body is a DOT-method-call, and its overload selection picks `Eq(String).==`
(String,String) → passing `rhs:str` to a `String` param = incompatible. The
`(String,str)` `==` (eq_str) is not a registered `==` overload on String — the
infix `==` path maps to it specially (Pattern / `is_infix_operator_call=true` at
function.yo:1328). The dot-call `Self.(==)` doesn't replicate that mapping. Next:
make the body's `Self.(==)(lhs,rhs)` resolve like the infix `==` (or ensure
get_receiver_methods for String "==" surfaces the str overload for dot-calls).

### DEEPER GAP found (why the 2-line attempt is insufficient)

`create_specialized_function_inline` binds **forall_names** from the args (the
generic-impl-method path relies on the FuncVal's `forall_names`, stamped by
`_stamp_impl_forall_on_method`). The `Eq.!=` default lambda has **EMPTY
forall_names** — its `Self`/`Rhs` are bare **SomeType PARAMS** (from the trait
signature), NOT forall labels. So even after (a) making the gate fire
(`callee_own_generic` on the FuncVal's own abstract type — verified `is_gen=true`)
and (b) passing the abstract template, `create_specialized` finds no forall to
bind and returns the original lambda (id 2230) unchanged. The real fix must make
`create_specialized` **bind SomeType params from the concrete arg types** (Self←
lhs arg type, Rhs←rhs arg type), mint a fresh func_id, register the concrete type,
and re-eval the body with those bindings — mirroring TS's generic specialization
which binds all generic positions, not just forall labels. This is the focused
work; the gate change alone is a no-op.

## Verified facts (probes, all reverted)

- Collection reaches `true =>` (registers) with func_id `fn_yo_id_2230`; no skip fires.
- `should_skip_function_codegen` skips via `is_function_type_hard_generic=TRUE`
  (called twice — declarations + generation loops).
- `get_func_type("fn_yo_id_2230")` = `fn(lhs : Self, rhs : str) -> bool` (abstract).
- `first_m.ty` passed to the call = `fn(lhs : String, rhs : str) -> bool` (concrete).
- `str` DOES implement `ToString` (to_string.yo) — a red herring ruled out.
