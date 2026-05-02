# Method Call Parsed as Enum Variant in Bootstrap Evaluator

**File**: `yo-self/evaluator/eval.yo`  
**Discovered**: Phase 3ah  
**Status**: Fixed in Phase 3ah

## Description

When the self-hosted parser parses `p.get_x()` (a method call with no explicit args), it produces:

```
FnCall(
  FnCall(Atom(Dot), [Atom("p"), Atom("get_x")], true),  // property access
  [],   // outer args (empty)
  false
)
```

The bootstrap evaluator's dispatch for `FnCall(FnCall(...), outer_args, false)` had code that handled **TS-format enum variants with args**: `.Some(42)` → `FnCall(FnCall(Dot, [Atom("Some")], true), [42], false)`. This code checked `inner_args[0]` for the variant name atom.

For `p.get_x()`, `inner_args[0] = Atom("p")`, so the evaluator incorrectly treated it as an enum variant `.p` with no fields, producing `EnumVal(".p", [])` instead of dispatching to the `get_x` method.

## Root Cause

The evaluator did not distinguish between:

1. **TS-format enum variant**: `inner_args.len() == 1` (just variant name)
2. **Self-hosted method call**: `inner_args.len() == 2` (receiver + method name)

Both produce `FnCall(FnCall(Dot, inner_args, true), outer_args, false)`, but with different `inner_args` lengths.

## Fix

Added a check in the `(dt.kind == TokenKind.Dot)` branch:

```rust
(inner_args.len() == usize(2)) => {
  // Method call: evaluate receiver, dispatch to handle_method_dispatch
  recv_expr   := inner_args[0];
  method_expr := inner_args[1];
  recv_res    := recur(recv_expr, env);
  handle_method_dispatch(recv_res.value, box(method_expr), args, env)
},
true => {
  // TS-format enum variant with args (inner_args.len() == 1)
  // Original logic: look up variant name, evaluate fields
  ...
}
```

## Impact

- Fixes `p.method()` and `p.method(args...)` for all struct method calls in the proto-evaluator
- Fixes chained method calls: `a.b.method()` where `inner_args[0]` is itself a FnCall
- Does NOT affect the self-hosted-parser dot form (`.Some(x)` → `FnCall(Dot, [FnCall("Some", [x])], false)`) which goes through a different path

## Test Coverage

Added `evaluate_module_body: impl method call` test in Phase 3ah:

```rust
impl(Point, get_x : (fn(self_v : Point) -> i32)(self_v.x));
p := Point(x: i32(7), y: i32(4));
rx := p.get_x();  // → should return 7
```
