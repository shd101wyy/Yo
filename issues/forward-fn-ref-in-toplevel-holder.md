# Forward function references in module-level holder initialization

## Summary

When a module-level mutable holder is initialized at the bottom of a file with
a reference to a method defined earlier in the file via `impl(...)`, the C
codegen does not emit a forward declaration of the method, producing
`use of undeclared identifier 'fn_...'` errors.

## Reproducer (excerpt from `yo-self/parser/parser.yo`)

The `...` in the signatures below are **textual ellipsis** marking omitted
parameters — Yo has no variadic parameters. Reproduced shape:

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

## Important: bug is specific to effect-parameterized methods

The same holder pattern works correctly when the method has **no** effect
parameters (no `using(...)` and no `forall(...)`). Verified with this minimal
program — it compiles and runs (`42`):

```rust
open import "std/fmt";
P :: struct(x : i32);

(_method_holder : Option((fn(self: *(P)) -> i32))) = .None;

impl(P,
  method : (fn(self : *(Self)) -> i32)(self.x)
);

_method_holder = .Some(P.method);

main :: (fn() -> unit)({
  p := P(x: i32(42));
  match(_method_holder,
    .Some(f) => println(`${f(&(p))}`),
    .None    => println(`none`)
  );
  ();
});
export main;
```

So the failure mode is **not** "module-level holders never work". It is
specifically: holders that capture a method whose type carries `using(...)`
effect parameters (or `forall(...)` implicit parameters) emit the
unspecialized `funcId` at the assignment site, and that funcId has no
corresponding C symbol because the function is specialized per call site.

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
