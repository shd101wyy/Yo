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

| Pattern                                           | Result |
| ------------------------------------------------- | ------ |
| `cond(cond1 => val1, true => val2)`               | Works  |
| `return(...)` from `cond` branch                  | Works  |
| `==` comparison (`next.kind == TokenKind.RParen`) | Works  |
| `!=` / assignment (`:=`, `=`)                     | Works  |
| `self.skip_ws_fwd(idx)`                           | Works  |

## Fix direction

Investigate the TS codegen for:

1. `src/codegen/exprs/other-fn-call.ts` — how `if` is compiled vs `cond`
2. `src/codegen/exprs/generation.ts` — how while loops in `ref(self)` methods
   interact with effect escape checks
3. Possible issue: `ref(self)` methods use function pointers or `self` is
   passed as a pointer, and the codegen for control flow in this context
   generates incorrect C.

## Workaround (applied)

Trailing commas are handled by proactively detecting `)` after whitespace
skipping and using `cond` + `return` — avoiding the `if` codegen bug and
the `exn.throw` propagation issue entirely.
