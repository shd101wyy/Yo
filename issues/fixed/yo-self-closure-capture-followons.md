# Closure-valued capture: 2 codegen follow-ons (stage-2)

After the is_ct fix (a FuncVal-valued arg no longer binds its param
compile-time-only, so a nested closure CAPTURES it — matching TS), two
downstream emission bugs surface. 22-line repro (was src/tests/fixme.yo):

```rust
open(import("std/fmt"));
open(import("std/string"));
{ HashMap } :: import("std/collections/hash_map");
Detector :: struct(detect : Dyn(Fn(x : i32) -> unit));
run_detector :: (fn(d : Detector, x : i32) -> unit)({ (d.detect)(x); });
analyze :: (fn(get_info : Impl(Fn(e : i32) -> i32)) -> unit)({
  extras := HashMap(String, i32).new();
  d := Detector(detect : dyn((x) => { _s := extras.set(`k${x}`, get_info(x)); () }));
  run_detector(d, i32(7));
  match(extras.get(String.from("k7")),.Some(v) => println(`${v}`),.None => println(`missing`));
});
main :: (fn() -> unit)({ analyze((e) => (e * i32(3))); });
export(main);
```

TS prints 21. yo-self emit now has capture{get_info, extras} (correct) but:

1. **Capture-in-capture emission order** — `struct capture_6264 { __yo_t26 get_info; ... }`
   emitted BEFORE `__yo_t26` (= get_info's own capture struct, capture_6306) is
   defined → "field has incomplete type". The struct dependency ordering misses
   the capture-struct→capture-struct BY-VALUE field edge. Stage-2:
   `field has incomplete type '__yo_t820'`.
2. **Dyn-box fn name for closure-valued capture** —
   `((cast)/* Error: no C function name for func value yo_id_3511_Fn... */)(...)`
   — the box() specialization for the capture struct type isn't registered under
   a C name at emission. Stage-2: `expected expression` at the same shape.

TS reference C (same repro): capture struct `{ .extras = extras, .get_info = get_info }`
by value; the closure call passes `&(ctx->get_info)`; box fn emitted as
`fn_..._box_Impl_u40_Fn..._idstruct_...` keyed on the capture struct.

## RESOLVED (2026-07-09)

1. **Emission order** — `_walk_by_value_dep`'s SomeT arm now falls back to the
   GLOBAL `lookup_some_resolved_concrete` registry when the per-object
   `resolved_concrete` is None (mirroring get_type_string's SomeT arm), plus a
   `is_function_type` arm routing through `_walk_add_dep` (no-op for plain
   fn-pointer fields). The capture-in-capture field now orders after its
   definition.
2. **Box-fn collection** — `_func_has_some_param` used a raw
   `get_all_some_types` scan; a SomeT param carrying `resolved_concrete`
   (the box-of-closure's Impl(Fn) param resolved to its capture struct) IS
   concrete at codegen — switched to `type_contains_some_type` (which has the
   carve-out). The box specialization now collects and emits.

Validated: repro prints 21 (TS parity), corpus 106/106 DIFF 0 (incl. new
tests/codegen-bootstrap/closure_param_capture.yo), std check 152/152.
