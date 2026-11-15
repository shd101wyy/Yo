# The `dyn(v)` alias boxes through a spec codegen never collects (no C function name)

**Severity:** S1 (blocks the d49 flip: ~1463 `dyn(v)` alias sites in src and most error-throwing tests; the flip's stage 2 cannot compile the tree until it is fixed)

**Date:** 2026-11-14

## Verbatim error

```text
p5b8.c:2508:783: error: expected expression
  ... (((__yo_t_4163876515418914838 (*)(__yo_t_7225151960912239025, __yo_t_4636743730022276490))/* Error: no C function name for func value yo_id_1352334768521580635000000_rtparam0_struct_decl_p__p5_E1_r0c6_i32_... */)((__yo_t_7225151960912239025)(...), (__yo_t_4636743730022276490){ .tag = ..._NONE }));
```

## Reproducer (`tmp/fixme.yo`; probe `tmp/p/p5.yo` on `vbd/d49-flip`)

```yo
{ Error, AnyError } :: import("std/error");
E1 :: struct(code : i32);
derive(E1, Clone, ToString);
impl(E1, Error());
f :: (fn(err : AnyError) -> i32)(
  match(downcast(&err.*, E1), .Some(e) => e.code, .None => i32(-1))
);
main :: (fn() -> unit)({
  println(&f(dyn(E1(code : i32(3)))).to_string()); // the alias: invalid C
});
export(main);
```

`dyn(Box.new(E1(code : i32(3))))` — the explicit spelling — compiles and runs
(`3`), so only the ALIAS path is broken.

## Root cause (isolated to this precision on 2026-11-14; superseded hypothesis below)

The collector's dyn arm (`find_function_calls_in_expr`'s `FnCall` callee
walk, collection.yo ~1030) guarded its registrations on
`is_dyn_type(&ei.ty())` — the CALL's recorded type. For the `dyn(v)` alias
the call node's recorded type is the flip's HANDLE type (`Box(Dyn(...))`,
a `&Dyn` reference, or the interim counted cell), not the bare `DynT`, so
the arm never ran for the alias's synthesized `Box.new` spec and the spec
was never registered: `fn_value_c_name(spec_fid)` found nothing and
`generate_comptime_value`'s FuncVal arm emitted the error comment inside a
function-pointer cast. The explicit `dyn(Box.new(v))` worked because its
source call is collected through the dot-registry arm before any of this
matters. The `[collect-skip]` debug print (YO_DEBUG_SWALLOW, commit
2950eaf03) never firing on the alias proved the collector never reached the
skip — the guard itself was the gate.

## Fix

`dyn_arm_ty` (commits 7c3cb07e8 + c63b02702): the dyn arm unwraps the
recorded type — `is_dyn_type` directly, else one `Reference` level, else
`unique_box_payload_type`, else `cell_handle_view` — and the registrations
below key on `type_key(&arm_dyn_ty)` / `dyn_type : Rc.clone(&arm_dyn_ty)`.

## Test

`tmp/p/p5.yo` (both forms); once fixed, `tests/error.test.yo`'s
`dyn(...)`-throwing rows and `tests/dyn.test.yo`'s alias rows are the
regression suite.
