# A compile-time `TypeInfo` local's scope-end drop lowers an enum with no C type, and codegen panics

**Severity:** S1 — a compiler ICE on valid input: any runtime function body that binds `info :: Type.get_info(T)` fails to compile (`get_enum_variant_c_name: enum type not registered`), which turned develop's battery red on `tests/type_reflection.test.yo` (0 of 35 tests ran).

Found 2026-11-04 by develop's battery (run 41668995729 at `a80b5cb35`). The last green battery was 41539921198 at `ce827ae52`.

## Reproducer

```yo
main :: (fn() -> unit)({
  k :: Type.get_info(i32);
  comptime_assert(k.is_primitive(), "i32 is primitive");
});
export(main);
```

```
get_enum_variant_c_name: no C type name found for enum TypeInfo
get_enum_variant_c_name: enum type not registered (see stderr) (at .../src/codegen/utils/index.yo:1996:7)
```

The v0.2.73 seed and a tree binary of `dc24349c5` (the commit before B8) compile it. A tree binary of B8 (#1736, `42f414755`) or of any later develop commit panics. B8's compiler change is the cause, not its std: the pre-B8 binary with B8's std passes, and B8's binary with the pre-B8 std fails.

## Root cause

Two rules meet here. B8 introduced one of them, and the other is older.

1. **The evaluator schedules a scope-end `___drop(k)` for the compile-time binding.** `k :: Type.get_info(i32)` is an owning local: `type_contains_rc_type(TypeInfo)` holds, because `TypeInfo` is a nominal enum that is not `Copy` (decision 36's flip). So `_scope_end_drop_eligible` (`src/evaluator/exprs/begin.yo`) attaches the drop. This predates B8 and was harmless. Codegen's `generate_drop_of_operand` (`src/codegen/exprs/rc_fns.yo`) lowered the operand `k`, which is the comptime value `TypeInfo.I32` rendered as a compound literal of the registered `TypeInfo` C struct. Then `generate_drop_code_for_value` found nothing to release (`type_contains_rc_cell_or_move_only` is false) and the whole drop emitted nothing.
2. **B8 stopped giving `TypeInfo` a C type.** Its fix for the stage-2 hollow gate (`issues/fixed/2026-11-03-a-runtime-position-type-get-info-emits-the-comptime-typeinfo-struct.md`) made `collect_type` skip a record with a comptime-only runtime field (`_has_comptime_only_runtime_field`). Its reasoning was that such a type "reaches collection only through a compile-time-folded expression, which emits no code." A compile-time binding's scope-end drop is a second way in. The drop still lowers its operand before it decides there is nothing to release, and lowering an enum value needs the enum's C name (`get_enum_variant_c_name`), which no longer exists.

B8's Tier 1 did not run `tests/type_reflection.test.yo`. The evaluator-only `check --test-bodies` sweep cannot see a codegen panic.

## Fix

`generate_drop_of_operand` reads the operand's type first. When that type has no C form (`_has_comptime_only_runtime_field`, the same predicate `collect_type` skips on), the drop returns empty without lowering the operand. Such a value holds nothing to release, and it cannot be rendered in C. Every drop path goes through this function: `___drop` and `consume` of an owned value, and with them the scope-end, early-exit and unwind drops.

## Test

`tests/type_reflection.test.yo`:

- The whole file fails to compile before the fix (0 of 35 ran) and passes after it. Its "TypeInfo for struct and enum", "TypeInfo match dispatch" and ten other cases bind `info :: Type.get_info(T)` in a test body.
- The new "TypeInfo local in a runtime function compiles and runs" case binds the `TypeInfo` in a plain runtime function, which a runtime test then calls.
