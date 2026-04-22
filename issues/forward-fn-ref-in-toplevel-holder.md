# Forward function references in module-level holder initialization

## Summary

When a module-level mutable holder is initialized at the bottom of a file with
a reference to a method defined earlier in the file via `impl(...)`, the C
codegen does not emit a forward declaration of the method, producing
`use of undeclared identifier 'fn_...'` errors.

## Reproducer (excerpt from `yo-self/parser/parser.yo`)

```rust
// Top of file
(_parse_primary_end_holder : Option(
  (fn(self: *(Parser),
      primary_expr: AstExpr,
      index: usize,
      using(exn: Exception)) -> ParseResult)
)) = .None;

// ...

impl(Parser,
  parse_primary_end : (fn(self: *(Self),
                          primary_expr: AstExpr,
                          index: usize,
                          using(exn: Exception)) -> ParseResult)(
    // ...
  )
);

// Bottom of file
_parse_primary_end_holder = .Some(Parser.parse_primary_end);
```

The generated C contains:

```c
_parse_primary_end_holder = (__yo_enum_..._SOME)(
  ... .value = fn_yode3c21e6_id_400_parse_primary_end ...
);
//             ^^^ undeclared
```

The forward decls that **do** exist all carry per-call-site specialization
suffixes:

```c
fn_yode3c21e6_id_400_parse_primary_end_Exception_u40_throw...rtparam0__u42__u40_Parser..._rtparam1_AstExpr...
```

The holder assignment instead emits the bare unspecialized `funcId` —
which has no corresponding C symbol because the method is specialized per
call site.

## Why this is hard to reproduce in isolation

A minimal program with the same shape (module-level `Option(fn(...))`
holder + impl method that takes `using(exn : Exception)` + an explicit
`f(self, using(exn))` call site through the holder) compiles and runs.
The reason: that explicit call site forces emission of one specialization
that happens to match the unspecialized name, or codegen falls back to
emitting an unspecialized definition.

The parser triggers the failure because:

1. The mutually recursive cluster (`parse_expression`, `parse_primary_end`,
   `parse`) is invoked **only through holders** from many sibling methods.
2. Each call site uses a different effect-row context (different surrounding
   `using(...)` args, different `Self` types), producing distinct
   specializations like `..._throw_ctl_ArrayList_u40_Token_u41_`,
   `..._throw_ctl_AstExpr_`, etc.
3. No call site references the bare unspecialized funcId, so codegen never
   emits it as a definition.
4. The holder assignment at the bottom of the file still uses the bare
   unspecialized funcId.

Building a minimal repro requires multiple call-site contexts that each
force a distinct specialization while leaving the holder as the sole
"raw" reference. Easier to fix the underlying language limitation
(forward refs inside `impl` blocks) so the parser doesn't need holders.

## Deeper root cause

This is **not** a simple "missing forward declaration" bug. The targeted
function (`parse_primary_end` etc.) has effect parameters
(`using(exn: Exception)`) and is _specialized at every call site_ — debug
output shows `specCaches=36` for `parse`. There is **no single concrete C
function** corresponding to the unspecialized `Parser.parse_primary_end`
funcId; the C codegen only emits the specialized variants.

So storing `Parser.parse_primary_end` in an `Option(fn(...))` holder is
semantically broken under the current effect-passing model: which
specialization should the holder carry? The user's code expects a single
runtime function pointer; codegen has multiple specialized symbols, none of
which matches the unspecialized funcId emitted at the holder assignment site.

## Workaround for parser bootstrap

Restructure the parser to avoid module-level function-pointer holders. Three
viable options:

1. Pass mutually recursive entry-points explicitly as arguments
   (`parse_expression(self, parse_primary_end, ...)`).
2. Keep all mutually recursive functions inside one `impl(Parser, ...)` block
   and use direct method calls / `recur` — `impl` blocks do allow forward
   references between fields.
3. Use a module value (compile-time) holding the function references rather
   than a runtime mutable variable.

## Possible long-term fix

Two complementary changes would make module-level function-pointer holders
work:

1. When a function-value reference appears at the top level (or anywhere it
   is captured as a non-called value), the evaluator must specialize it so
   one concrete `funcId` exists. This requires the holder's value type to
   already pin all effect/implicit params (i.e., `Option(fn(... using(...)) -> T)`
   would need a concrete `Exception` handler binding at the reference site).
2. Codegen `findFunctionCallsInExpr` (collection.ts) must register that
   specialized funcId so a forward declaration is emitted before the
   module-level initializer.

## Severity

Blocks the current parser port pattern in `yo-self/parser/`. Not blocking for
day-to-day Yo use because the holder pattern is unusual.
