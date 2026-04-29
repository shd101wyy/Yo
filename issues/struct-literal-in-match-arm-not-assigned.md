# Bug: Struct literal in match arm not assigned to return temporary

## Status: Open

## Discovered: Phase 2k (expr_info.yo port)

## Description

When a `match` expression has an arm whose value is a **freshly constructed struct literal**
(`StructName(field: value, ...)`), the codegen emits the compound literal as a **statement**
rather than assigning it to the function's return temporary variable.

The function then returns an uninitialized (or garbage) value.

## Minimal reproduction

```rust
ControlFlowFlags :: struct(
  return_flag   : bool,
  escape_flag   : bool,
  break_flag    : bool,
  continue_flag : bool
);

ControlFlowKind :: enum(Return, Escape, Break, Continue);

control_flow_of :: (fn(kind : ControlFlowKind) -> ControlFlowFlags)(
  match(kind,
    .Return => ControlFlowFlags(return_flag: true, escape_flag: false, break_flag: false, continue_flag: false),
    .Escape => ControlFlowFlags(return_flag: false, escape_flag: true, break_flag: false, continue_flag: false),
    .Break  => ControlFlowFlags(return_flag: false, escape_flag: false, break_flag: true, continue_flag: false),
    .Continue => ControlFlowFlags(return_flag: false, escape_flag: false, break_flag: false, continue_flag: true)
  )
);

// Expected: cf.return_flag == true
// Actual: cf.return_flag == false  (all fields false / uninitialized)
cf := control_flow_of(ControlFlowKind.Return);
```

## Generated C (incorrect)

```c
static inline __yo_struct_... fn_..._control_flow_of(__yo_enum_... kind) {
  __yo_struct_... _temp;        // uninitialized
  switch (kind) {
  case RETURN: {
    // Struct literal is a standalone statement — NOT assigned to _temp
    (__yo_struct_...){ .return_flag = true, .escape_flag = false, ... };
    break;
  }
  ...
  }
  return _temp;                 // returns uninitialized!
}
```

## Expected C

```c
case RETURN: {
  _temp = (__yo_struct_...){ .return_flag = true, ... };   // must assign
  break;
}
```

## Root cause

The codegen for `match` (switch) arms does not assign the arm's value expression to the
function's return temporary when that value is a struct-construction expression.
This likely affects any match arm that produces a struct VALUE (not just `ControlFlowFlags`).
It may also affect `cond` arms for the same reason.

## Affected files

- `src/codegen/exprs/` — match/cond generation
- `src/codegen/functions/` — function body return handling

## Workaround (used in Phase 2k)

Assign the match result to an intermediate variable and return it explicitly:

```rust
control_flow_of :: (fn(kind : ControlFlowKind) -> ControlFlowFlags)({
  f := match(kind,
    .Return   => ControlFlowFlags(return_flag: true,  ...),
    ...
  );
  f
});
```

Or use individual mutable flag variables:

```rust
control_flow_of :: (fn(kind : ControlFlowKind) -> ControlFlowFlags)({
  r := false; e := false; b := false; c := false;
  match(kind,
    .Return   => { r = true; },
    .Escape   => { e = true; },
    .Break    => { b = true; },
    .Continue => { c = true; }
  );
  ControlFlowFlags(return_flag: r, escape_flag: e, break_flag: b, continue_flag: c)
});
```

## Related

- Phase 2k: `yo-self/expr/expr_info.yo` — `control_flow_of`, `has_control_flow`, `has_any_control_flow`
