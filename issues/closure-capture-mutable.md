# Closures cannot capture mutable locals or globals

## Symptom

Code like:

```rust
caught := box(false);
given(exn) := Exception(throw: ((err) -> {
  caught.* = true;   // ❌ "use of undeclared identifier 'caught'" in C output
  escape ();
}));
```

fails C compilation with `use of undeclared identifier 'caught'`. This also
affects any mutable variable in `given()` effect handlers — even simple `bool`
flags:

```rust
(did_throw : bool) = false;
given(exn) := Exception(throw: ((err) -> {
  did_throw = true;   // ❌ "use of undeclared identifier 'did_throw'"
  return ()
}));
```

## Root Cause

The codegen for effect handler closures (from `given()` statements) generates
them as separate top-level C functions but references outer local variables
directly by name, which is invalid in C11. The handler function:

```c
static inline void fn_xxx_throw(dyn_error err) {
  did_throw = true;  // ERROR: 'did_throw' is not in scope here
}
```

is a separate C function; `did_throw` is a local variable of the enclosing
function. C11 does not support nested functions or non-global variable capture.

This affects ALL `given()` handlers that reference outer mutable state, including
`yo-self/evaluator/types/function.yo`'s `lhs_eval_failed` pattern.

## Impact

1. Test code cannot communicate "did an exception get thrown" signal back via mutable locals.
2. Production code using `given()` handlers with captured state silently generates
   invalid C (compilation fails with "undeclared identifier" errors).
3. `anonymous_module.yo`'s `allow_partial_module=true` path cannot be implemented.

## Workaround

- For tests of error-throwing functions, install an `exn` whose `throw` does
  `assert(false, "unexpected error")` — the test fails noisily if the throw
  is taken.
- For tests of "did this throw?", currently no clean Yo-only solution.
- For production code like `allow_partial_module`: only implement the `false` path
  (propagate exceptions to outer `exn` directly without inner handler).

## Affected

- `yo-self/tests/typeof.test.yo` had to drop its arity-error test.
- `yo-self/evaluator/values/anonymous_module.yo`: `allow_partial_module=true` not implemented.
- `yo-self/evaluator/types/function.yo`: `evaluate_where_clause` generates invalid C
  (untested path — current yo-self tests don't exercise it).

## Fix direction

The codegen for effect handler closures needs proper closure capture support.
Effect handler function signatures need a `void* ctx` capture parameter:

```c
// Current (broken):
static inline void handler_throw(dyn_error err) { captured_var = true; }

// Fixed:
typedef struct { bool* captured_var; } _CaptureState_xxx;
static inline void handler_throw(dyn_error err, void* capture) {
  _CaptureState_xxx* state = (_CaptureState_xxx*)capture;
  *state->captured_var = true;
}
```

This requires:

1. The evaluator to detect that a given() handler closure captures outer variables
2. The codegen to generate a capture struct for the handler
3. The effect system to pass the capture pointer alongside the function pointer

Alternatively, fix requires changes to how evidence parameters are passed in C — adding
a `void* closure_ctx` alongside every `void* fn_ptr` evidence parameter.
