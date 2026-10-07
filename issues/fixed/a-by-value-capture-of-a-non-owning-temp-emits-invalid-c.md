# A by-value capture-list entry of a non-owning temp emits invalid C

**Severity:** S2 — a valid program is rejected at the C compiler with "use of
undeclared identifier" (three errors on one eval-time temp), `compile: C
compiler failed`; no wrong code ever runs.

Status: FIXED 2026-10-07 — the round-2 review of `feat/vbd-capture-lists`
(blocker 1). `_evaluate_capture_list`
(`src/evaluator/values/anonymous_function.yo`) no longer lifts the
initializer's recorded `___dup` expression out as the field initializer; the
capture field's codegen (`expr_info_capture_field_inits` in
`src/codegen/exprs/closures.yo`) now routes a by-value entry through
`emit_deferred_dup_or_code`, the shared dup-on-store choke point, which
materializes the initializer call first (declare-first) and then emits the
dup. Tests: tests/closure_capture_list.test.yo ("a by-value capture of a
NON-OWNING temp of an RC value").

Found 2026-10-07 by the adversarial review of the round-1 fix commit
(`fix: a by-value capture-list entry of an RC value retains it`): the new
defect was introduced by that commit itself.

## Reproducer

```rust
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");

main :: (fn() -> unit)({
  src := ArrayList(String).new();
  src.push(String.from("a"));
  src.push(String.from("b"));
  {
    (f : Impl(Fn() -> usize)) = ({ first : src(usize(0)) }() => first.len());
    f();
  };
});
export(main);
```

`yo compile` emits, inside the block:

```c
if ((_file___C__Us_temp_1009…782600) != NULL) { __yo_incr_rc((void*)(_file___C__Us_temp_1009…782600)); }
__yo_t_… _file___C__Us_temp_893…34680 = (__yo_t_…){ .__yo_v_first = _file___C__Us_temp_1009…782600 };
```

and the C compiler answers:

```text
tmp/fixme.c:3360:6: error: use of undeclared identifier '_file___C__Us_temp_1009…782600'   (×3)
yo: error: compile: C compiler failed (exit 1) on tmp/fixme.c
```

## Root cause

`src(usize(0))` — an index-trait element read — evaluates to a NON-OWNING
temp of an RC value (`String` inside the list's cell), so
`set_expr_as_needs_to_call_dup` records the balancing `___dup(<temp>)` on the
INITIALIZER's own `ExprInfo.deferred_dup_expressions`. The round-1 fix reused
that recorded dup expression AS the field initializer (`field_init = fd`),
which dropped the initializer expression itself on the floor: nothing ever
generated the index call, so the temp the dup both increments and yields was
never declared in the C, and the call vanished with it.

The boundary, measured on the round-1 code: atom initializers of RC values
(`{ t }`, `{ n : s }` — the dup targets a declared LOCAL), owning temps
(`{ n : make_t(5) }` — consumed, the store moves), non-RC initializers
(`{ n : s.len() }` — no reference to balance) and move-only atoms all
compiled; only the non-owning-temp RC shape emitted invalid C.

## Fix

Keep the initializer expression as the field initializer — the recorded dup
stays attached to ITS `ExprInfo`, where the codegen dup-on-store sites expect
it — and make `generate_closure_construction` emit a by-value field through
`emit_deferred_dup_or_code` (src/codegen/exprs/drop_dup.yo), the same helper
the init-assignment and ref-struct-ctor paths use. Its declare-first rule
materializes the initializer (`T <temp> = <call>;`) so the deferred dup's
undeclared-temp gate passes, the dup takes the +1, and the field stores the
dup result. The evaluator keeps round-1's manual `___dup(<name>)` build for
the ATOM shape only (`set_expr_as_needs_to_call_dup` no-ops on an atom read:
it has no temp `variable_name`), which renders inline against a declared
local.
