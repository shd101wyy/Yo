# yo-self: derived-Eq `==`/`!=` on enums (and structs) returns unit under def-eval

## Status: OPEN — the dominant `check ./yo-self` propagation blocker

Under the def-eval propagation experiment, `check ./yo-self` is ~31/228.
The single most common failure (≈190 files) is:

```
Error: Expected bool type for "or" argument, got TYPE=unit for:
k == (ZK.A)
```

i.e. a derived-`Eq` `==`/`!=` comparison used as an operand of `||`/`&&`
(or assigned to a `bool`) resolves to **unit** instead of **bool**.

## Faithful minimal repro

```rust
ZK :: enum(A, B, C);
derive(ZK, Eq(ZK));
ztest :: (fn(k : ZK) -> bool)(
  (k == ZK.A) || (k == ZK.B)   // → "Expected bool type for or argument, got unit"
);
```

TS (`./yo-cli check`) accepts this — evaluator OK. yo-self
(`/tmp/yo-self-dbg` under the experiment) reports unit. A bare
`enum` WITHOUT `derive(..., Eq(...))` is correctly rejected by BOTH
(TS: "No matching call found") — so the bug is specifically in the
DERIVED `==` path, not in a missing structural fallback.

Also fails (same root, isolates it from `||`):

```rust
(x : bool) = (k == ZK.A);   // Incompatible types: Expected bool, Given unit
```

## What is NOT the cause (ruled out)

- Not `expected_type` leakage: clearing `ctx.expected_type` before the
  arg eval in `and_or.yo` did not change the unit result.
- Not the `and_or` evaluator's non-raw `evaluate_expression` (though that
  IS a separate faithfulness bug — see below): switching it to
  `evaluate_expression_raw` surfaced the same unit type with no thrown
  error, so the `==` genuinely evaluates to unit.
- Not a missing operator-dispatch route per se: `==` IS dispatched
  through the operator path in `calls/function.yo` (the `is_infix_call &&
op_is_operator` block ~line 626). Instrumentation there showed
  `get_receiver_methods_by_name_from_env(env, "==", ZK, true)` returns
  **0 methods** for the derived-Eq enum — i.e. the derived `==` was never
  registered, so the operator block is skipped and `==` falls through to
  callee evaluation → unit.

## ROOT CAUSE FOUND (2026-06-08) — derives never run during `check`

The derived `==` is never registered because **`ctx.is_executing` is
never set true in yo-self**. `evaluate_derive` (derive.yo) early-returns
when `ctx.is_validating_function_definition || !ctx.is_executing` — the
SAME guard as TS `evaluateDerive` (derive.ts:72). TS sets
`isExecuting: true` at the module-program eval entry (index.ts:194,
`evaluateAnonymousModuleBeginExprs`); yo-self's `eval_context_new`
defaults `is_executing: false` and **no site ever flips it true**
(verified: grep finds only the `: false` default + the test asserting
that default). So in yo-self, module-level `derive(...)` has ALWAYS been
a silent no-op — every derived method (`==`, `!=`, `<`, `Clone`, …) is
unregistered. This was invisible to plain `check` (fn bodies not
evaluated) but breaks under def-eval propagation where a body uses
`enum == enum`.

## Why the one-line fix does NOT work alone — the real blocker

Setting `ctx.is_executing = true` at the 4 module-program eval sites in
`main.yo` (lines ~109, 397, 590, 634 — each right after
`eval_context_new`) DOES make derives run, but immediately regresses
**all of std** with a cascade:

```
Error: Expected bool value for "comptime_assert", got: (info.is_struct)()
       Value: <unknown: bool>
Error: __yo_type_join_fields: expected a struct type
```

i.e. once derives actually execute, the comptime **reflection** they
depend on — `Type.get_info(T)` → `TypeInfo` → `info.is_struct()` /
`Type.get_struct_fields` / `Type.join_fields` (type_fns.yo
`evaluate_yo_type_get_info` etc.) — does NOT produce concrete values
under yo-self CTFE; `Type.get_info(ZK)` yields an **unknown** TypeInfo
even for a concrete struct, so the derive machinery's
`comptime_assert(info.is_struct(), …)` and `__yo_type_join_fields` fail.
Confirmed reflection-only repro (no derive, fails identically under
`is_executing=true`, even WITHOUT the propagation experiment):

```rust
ZK :: struct(a : i32, b : i32);
ztest :: (fn() -> i32)({
  info :: Type.get_info(ZK);
  comptime_assert(info.is_struct(), "should be struct");  // unknown bool
  i32(0)
});
```

A bare `match(info, .Struct(_,_) => true, _ => false)` (no method call)
is ALSO unknown — so it's `Type.get_info`/the constructed `TypeInfo`
value that's non-concrete, not the method dispatch.

`comptime_assert` only tolerates the unknown because it takes its
LENIENT non-executing path (`!ctx.is_executing`); flipping is_executing
makes it strict and exposes the unknown. So `is_executing=false` was
masking the reflection gap twice over (derives don't run AND assert is
lenient).

## Deeper findings (2026-06-08, second pass) — narrows the plan

With `ctx.is_executing = true` set at the 4 main.yo sites (and a
breadcrumb in `evaluate_yo_type_get_info`), `Type.get_info(T)` **DOES
run and DOES produce a concrete value** — e.g. for `Pragma` it returns a
fully-populated `.Enum(comptime_list(VariantInfo(name: "AllowUnsafe",
…), …))`. So `get_info` itself is NOT the blocker.

The blocker is the reflection HELPERS that consume the info, invoked by
the derive macros once `is_executing=true`. The FIRST prelude failure:

```
./std/prelude.yo:6410:34:  return(__yo_type_join_fields(self, mapper, combiner));
Error: __yo_type_join_fields: expected a struct type   (and a comptime_assert unknown)
```

`evaluate_type_join_fields` (type_fns.yo ~line 1324) throws "expected a
struct type" when `target_type` is neither a SomeType nor a struct — the
`self`/`T` reaching it isn't a concrete struct at that point. So the
remaining gaps are in the reflection-helper builtins
(`__yo_type_join_fields`, `__yo_type_map_variants`, `get_struct_fields`,
and the `is_struct`/`is_enum` method dispatch on a concrete `TypeInfo`)
when driven by the derive machinery — not in `get_info`.

### Pinpointed: comptime method dispatch loses the receiver value

Instrumenting the failing `comptime_assert` throw shows, during genuine
module-level execution (is_executing=true) of a derive:

```
CASSERT-FAIL mod=./std/prelude.yo arg=(info.is_struct)() val=<unknown: bool>
```

`info :: __yo_type_get_info(self)` IS the concrete `.Enum(...)` value
get*info returned, and `is_struct` is just `match(self, .Struct(*,_) =>
true, _ => false)`. So `info.is_struct()`on a CONCRETE TypeInfo enum
value yields UNKNOWN bool: comptime method dispatch does not thread the
concrete receiver value into the method body's`self`(self becomes
UnknownVal(TypeInfo), so`match(self)` is unknown). Same "dispatch loses
the value" class as the original derived-`==`bug, one layer deeper (it
breaks the derive's OWN reflection before any derived method is built).
The`JOINFIELDS target=self/T`breadcrumbs were the harmless
def-time-body-eval pass (is_executing=false, lenient assert);`target=Pragma` + CASSERT-FAIL are the real execution pass.

So step 2's real target is comptime method-call receiver-value threading
under CTFE (method-call arg binding in function.yo/helper.yo), surfacing
through every reflection method (is_struct, is_enum, ...) the derive
machinery calls.

### DEFINITIVE root + exact fix location (2026-06-08, third pass)

`try_to_call_function_with_arguments` (helper.yo) NEVER executes CTFE —
its `return_value` is always `None` (documented at helper.yo:1400,
"CTFE is not executed"). The `.method()` dispatch branch in
`evaluate_function_call` (function.yo, the `.Some(method_info)` arm
~line 2188-2202) calls it and then sets
`out_m.value = _call_result_unknown(return_type)` — fabricating a fresh
unknown and DISCARDING any computed value. So a `.method()` call on a
comptime fn never runs the body: `info.is_struct()` on a concrete
TypeInfo returns unknown-bool.

The inline FuncVal arm and the operator-dispatch block in the same file
DO route comptime-returning calls through `evaluate_comptime_fn_call`
(the `is_type_hierarchy_type(ret_type) || callee_result_is_comptime ||
fv_is_macro` gate). The `.method()` arm is the one that doesn't.

TWO sub-cases to keep straight:

- `enum == enum` with RUNTIME operands (the original repro, `k : ZK`
  param): only needs the return TYPE to be bool, which is_executing=true
  already delivers by registering the derived `==`. An unknown-BOOL
  result value is correct there.
- `info.is_struct()` with a CONCRETE comptime receiver (the prelude's
  derive machinery): needs the actual CTFE VALUE, which requires the
  `.method()` arm to execute comptime methods.

EXACT FIX: in the `.Some(method_info)` arm of `evaluate_function_call`
(function.yo ~2188), when `method_info.method_ty` is a comptime-returning
Func (mirror the inline-arm gate: `is_type_hierarchy_type(ret) ||
result_is_comptime_only`), route through `evaluate_comptime_fn_call`
(build `ArgValues` from the evaluated `all_args`, set `ctx.self_type`
from `_static_dot_receiver_self_type` / the receiver) and use its result
value, instead of `try_to_call_function_with_arguments` +
`_call_result_unknown`. Land together with `ctx.is_executing = true` at
the 4 main.yo module-program sites. Validate against the prelude (it
exercises the derive machinery heavily), then the std/yo-self/tests
gates. HIGH regression surface — every `.method()` call routes here.

NOTE: with `is_executing=false` (current committed state), NONE of this
comptime machinery executes — `Type.get_info(ZK)` returns unknown
WITHOUT running its body (no breadcrumb fires). Module-level comptime
execution is entirely dormant in yo-self today; that's the umbrella
root, with the reflection helpers as the next layer once it's on.

## Fix plan (multi-stage — NOT a single bug)

1. Set `ctx.is_executing = true` at the 4 main.yo module-program eval
   sites (faithful to TS index.ts:194) so module-level comptime
   execution (derives + reflection) runs. Keep `eval_context_new`
   defaulting false — a context.test.yo test asserts that; don't change
   the constructor.
2. Fix the reflection-helper builtins to operate concretely under CTFE
   so the derive macros succeed — start at the first prelude failure
   `__yo_type_join_fields` (type_fns.yo `evaluate_type_join_fields`):
   trace why `target_type` isn't the concrete struct `derive` passed,
   then the `is_struct`/`is_enum`/`get_struct_fields` chain. `get_info`
   already works, so this is about the helpers' handling of the type arg
   - the mapper/combiner comptime args.
3. Re-gate: std 151/151, yo-self 228/228, tests known-11. Derived `==`
   on Eq-enums then registers and the propagation repro passes.

Steps 1 and 2 must land TOGETHER — step 1 alone regresses all of std.

## (background) The derived-Eq machinery itself

`__derive_eq` (std/prelude.yo:6712, registered via
`derive_rule(Eq, __derive_eq)`) builds the enum `==` impl by:

1. folding a `match(lhs, .A => match(rhs, .A => true, _ => false), …)`
   body as a **comptime_string** (`__yo_comptime_fold_range` + `__sN`
   concat helpers),
2. `match_body.to_expr()` to parse the string back to an AST,
3. `ctx.make_impl(quote(Eq(...)( (==) : ((lhs, rhs) -> #(match_body…)) )))`.

The derived `==` body is therefore produced by comptime-string →
`to_expr` → macro `make_impl`. The unit result most likely comes from
one of: `to_expr` / `comptime_string_to_expr`, the `make_impl` macro
expansion, or the derived method's body (`match(...)` returning
true/false) evaluating to unit under def-eval when `lhs`/`rhs` are
unknown. Bisect by:

- checking whether the derived `==` METHOD is registered against `ZK`
  at all (dump the trait-method registry for the enum id), and what its
  return TYPE is recorded as;
- if registered with a bool return, the call path drops it → look at the
  operator-dispatch return-type resolution in `calls/function.yo`;
- if registered with a unit return (or not at all), the derive
  machinery (`to_expr`/`make_impl`/comptime-string fold) is the culprit.

## Companion faithfulness fix (do alongside, not alone)

`evaluator/builtins/and_or.yo` uses the SWALLOWING `evaluate_expression`
for its operands; TS `and-or.ts` uses the propagating `evaluateExpression`
(`context: {...context}`). Switch to `evaluate_expression_raw(arg,
cur_env, ctx, exn)`. This is faithful and is what makes the enum-`==`
error visible rather than silently unit — but committing it ALONE
(without the enum-`==` fix) changes `&&`/`||` error propagation broadly,
so land them together.

## Impact

Fixing this should unblock the bulk of `check ./yo-self` under
propagation in one shot (≈190 files share this single root).

## PARTIAL FIX implemented + saved (2026-06-08, fourth pass)

Implemented the `.method()`-arm CTFE routing (saved as
`plans/derived-eq-method-ctfe-partial-fix.patch.txt`, builds clean): in
`evaluate_function_call`'s `.Some(method_info)` arm, when the method's
return is comptime (`is_type_hierarchy_type(ret) || result_is_comptime_only`),
route through `evaluate_comptime_fn_call` using `call_result_m.callee_env`
(which `try_to_call` already populated with the params bound to their
arg values — Step 9, helper.yo:537) + `call_result_m.arg_values`, and
use its result value instead of `_call_result_unknown`. Paired with
`ctx.is_executing = true` at the 4 main.yo module-program sites.

This is CORRECT and NECESSARY — it makes `info.is_struct()` /
`info.is_enum()` on a concrete `TypeInfo` execute and return concrete
bools (verified: the prelude's `is_struct`/`is_enum` match-scrutinee
errors are gone, and some calls now return concrete `false`).

But it is INSUFFICIENT alone. Instrumenting the routed calls shows the
derive machinery makes MANY comptime calls and only some get concrete
args:

```
10  MARM-CTFE ret=bool   resultval=<unknown: bool>
 9  MARM-CTFE ret=Expr   resultval=<unknown: Expr>
 8  MARM-CTFE ret=usize  resultval=<unknown: usize>
 2  MARM-CTFE ret=bool   resultval=false              <- concrete (works)
 ...
```

The `<unknown>` results are `evaluate_comptime_fn_call` hitting its
`any_arg_unknown` gate (returns unknown without executing) because the
ARGS arrive unknown. So the broader comptime-execution path still drops
concrete values: the derive body runs via `evaluate_begin_expression`
(call_registered_derive_rule) and its intermediate comptime bindings
(`info :: …`, `variants :: …`, `eq_branches :: __yo_comptime_fold_range(…)`,
`match_body.to_expr()`) don't thread concrete values to the next call.
`__derive_eq` ends up returning `<unknown: unit>` → "derive rule must
return comptime(Expr)".

### Remaining scope (the real size of this)

Making derived `==` work end-to-end requires the WHOLE comptime-execution
path to run concretely under `check` once `is_executing=true`:

- `.method()`-arm CTFE routing — DONE (patch above).
- comptime begin-block bindings (`x :: <comptime call>`) must thread the
  concrete value to subsequent expressions (this is where most of the
  `<unknown>` args originate).
- recursive comptime fns (`__yo_comptime_fold_range`, `__sN`) must
  execute and terminate on concrete args.
- `to_expr` / `comptime_string_to_expr`, `get_enum_variants`,
  `map_variants`, `make_impl` must each return concrete results.

This is the comptime-execution subsystem, not a single bug. Land the
saved patch as the first piece, then drive the prelude green by fixing
each `<unknown>`-producing comptime step in turn (prelude is the test;
gate std/yo-self/tests after). is_executing=true + the patch must land
together with the rest — partial application regresses std.
