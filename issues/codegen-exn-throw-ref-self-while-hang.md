# Codegen: `exn.throw` doesn't propagate in `ref(self)` methods with `while(runtime(true))`

**Status:** Open

## Symptom

Any syntax error in a parsed file causes the self-hosted parser to hang
instead of reporting the error. The parser enters `while(runtime(true))`
loops that never exit, even though `exn.throw(dyn(err))` is called and
the generated C code checks `__yo_effect_escaped` after the call.

## Reproducer

```rust
// f(;);  — semicolon as first argument causes parse_expression to fail
// The parser hangs at "check: parsing" and never returns
```

## Root cause

In `ref(self)` parser methods with `while(runtime(true))` loops,
the following C-level codegen patterns produce incorrect runtime behavior:

| Pattern                                           | Result                           |
| ------------------------------------------------- | -------------------------------- |
| `if(condition, {...}, {...})`                     | hangs (doesn't execute branches) |
| `return(FnArgsResult(...))` from `if` branch      | doesn't return                   |
| `exn.throw` propagation via `__yo_effect_escaped` | flag not seen by callers         |

These are in `parse_fn_args`, `parse_fn_call`, `parse_primary_end`, etc. —
all `ref(self)` methods on the `Parser` object.

## Confirmed working patterns

| Pattern                                  | Result                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `cond`                                   | Works (generateCondExpression has proper C codegen)                             |
| `if`                                     | **Works** (verified in C output — generates correct if/else C code with return) |
| `return(...)` from `cond` or `if` branch | Works                                                                           |
| `==` comparison                          | Works                                                                           |
| `self.skip_ws_fwd(idx)`                  | Works                                                                           |

## Updated root cause

Initial diagnosis pointed to `if` codegen, but C-level verification shows
`if` IS correctly generated. The trailing comma hang was actually caused by
not skipping whitespace between comma and RParen — not an `if` codegen bug.
The fix uses `self.skip_ws_fwd` + `cond` which works correctly.

The REAL remaining issue is: `exn.throw(dyn(make_parse_error(...)))` inside
`cond` branches of `while(runtime(true))` loops in `ref(self)` methods.
The `__yo_effect_escaped` flag IS set by the handler, and IS checked by
the callers, but the propagation chain may have a gap at some level,
or `__yo_effect_escaped` may carry a stale value from a previous operation.

## Next steps

1. Check if `__yo_effect_escaped` is reset to 0 before parser method calls
2. Add verbose tracing of `__yo_effect_escaped` at each call level
3. Investigate `cond` -> C codegen for `__yo_effect_escaped` checks after
   each expression within a cond branch

## Workaround (applied)

Trailing commas are handled by proactively detecting `)` after whitespace
skipping and using `cond` + `return` — avoiding the `if` codegen bug and
the `exn.throw` propagation issue entirely.
