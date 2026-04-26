# Inline enum construction in match subject generates phantom drop

## Status: OPEN

## Summary

When an enum value with object-payload variants is constructed inline as the subject of a `match` expression (rather than first bound to a named variable), the codegen drops temp variables that were never declared, causing a C compilation error.

## Reproduction

```rust
{ CallResultKind } :: import ".../context.yo"; // enum with object-payload variants

main :: (fn() -> unit)({
  // FAILS: inline construction — temp var tracked but never declared
  match(CallResultKind.FunctionTypeResult, .FunctionTypeResult => (), _ => ());
  match(CallResultKind.ArrayTypeResult, .ArrayTypeResult => (), _ => ());
  match(CallResultKind.ClosureTypeResult, .ClosureTypeResult => (), _ => ());
});
export main;
```

Generated C error (3 lines like):

```
error: use of undeclared identifier '_yo4878a469_temp_72700'
fn_yoa57b8096_id_547___drop((__yo_enum_...)(temp_72700));
```

## Workaround

Bind the enum value to a named local variable first:

```rust
main :: (fn() -> unit)({
  k1 := CallResultKind.FunctionTypeResult;
  k2 := CallResultKind.ArrayTypeResult;
  k3 := CallResultKind.ClosureTypeResult;
  match(k1, .FunctionTypeResult => (), _ => ());
  match(k2, .ArrayTypeResult => (), _ => ());
  match(k3, .ClosureTypeResult => (), _ => ());
});
```

## Root Cause

The evaluator tracks a temp variable (e.g. `_module_temp_N`) for the enum construction in
the match subject. But the codegen inlines the construction directly into the `switch (...)`
expression rather than emitting a `type varname = construction;` declaration. At end-of-scope,
the drop logic references `varname`, which was never declared.

Only triggers when the enum type has a non-trivial drop function (i.e. it has at least one
variant with an `object` payload). Unit-only enums are fine because they don't generate a drop.

## Notes

- Occurs in `CallResultKind` (has `FunctionResult(FuncCallResult)` etc.)
- Similar to `match-inside-function-arg-phantom-drop.md` (phantom drop in function args) but
  different trigger: here the enum literal is the match subject, not a function argument.
- The workaround (bind to named variable) always works.
