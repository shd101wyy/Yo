# Codegen attempts to emit comptime-only function call after `exn.throw`

## Symptom

Yo source like:

```rust
enclosing_ret := match(ctx.enclosing_function_return_type,
  .Some(t) => t,
  .None    => {
    exn.throw(dyn format_error_message(...));
    t_i32() // unreachable, just here to satisfy types
  }
);
```

C-compiles fine but at test time fails with:

```
Yo compilation error: Unhandled function call: t_i32()
```

## Cause

`exn.throw(...)` returns `Never` and never returns control to the surrounding
expression. The trailing `t_i32()` expression is dead code — but the
codegen still emits it as the value of the begin block, and `t_i32` is a
comptime-only constructor (returning `TypeValue`, an enum stuffed with
heap-allocated variants), so the C emitter has no fallback path and panics.

## Workaround

Split the throw into a separate validation step:

```rust
match(ctx.enclosing_function_return_type,
  .None    => { exn.throw(...); },
  .Some(_) => ()
);
enclosing_ret := match(ctx.enclosing_function_return_type,
  .Some(t) => t,
  .None    => t_i32() // Now in a never-reached arm reachable only by codegen,
                      // but the value is unused because the previous match exits.
);
```

In this form the `.None` arm returning `t_i32()` is still emitted, but the
real-world value flow goes through `.Some(t) => t`. This compiles and runs.

## Fix direction

Either:

1. The C emitter should treat begin blocks that end in `Never` as dead-code
   with no value, so the trailing expression need not be evaluated.
2. The Yo evaluator should refuse `t_i32()` (or any comptime-only call) in
   a position that codegen cannot actually emit, surfacing the bug at type
   check time rather than C compile time.

## Affected

- `yo-self/evaluator/exprs/escape.yo` had to refactor a 1-shot match into
  a validate-then-extract pair (~10 extra lines).
