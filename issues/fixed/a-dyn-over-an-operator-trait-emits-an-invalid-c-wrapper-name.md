# A `Dyn` over an operator trait emits an invalid C wrapper name

**Severity:** S1 — a valid program (`!d` on a `Dyn(LogicalNot)`) fails in the C compiler: the emitted C does not parse

**Status: FIXED (2026-10-05).** Found while writing the `Dyn(LogicalNot)` test that `plans/VALUES_BY_DEFAULT.md` decision 34 asks for. The v0.2.52 seed has it.

## Symptom

```rust
_PmFlag :: struct(on : bool);
impl(_PmFlag, LogicalNot((!) : (fn(self : Self) -> bool)(!self.on)));
main :: (fn() -> unit)({
  (d : Dyn(LogicalNot)) = dyn(_PmFlag(on : true));
  println(!d);
});
```

```
tmp/t8.c:1072:78: error: expected ';' after top level declarator
 1072 | static bool __yo_wrap___yo_t_5048240402658506401___yo_t_11211938917208025763_!(void* self_ptr) {
```

## Root cause

`generate_dyn_wrapper_functions` (`src/codegen/functions/dyn.yo`) named each impl's vtable wrapper `__yo_wrap_<impl>_<label>` with the trait member's label spelled raw, and the vtable initializer referenced the same raw name. The slot's FIELD name was already sanitized (`._u33_`), so only an operator member, whose label is not an identifier, broke. `LogicalNot`'s `(!)` is the one operator member that has a slot today (it takes `self` and returns `bool`).

## Fix

Both sites sanitize the label with `sanitize_for_c_identifier`, as the field name already did. Regression test: `tests/parameter_modes.test.yo` "Dyn(LogicalNot) over a by-value operator impl", which fails on the seed with the C error above.
