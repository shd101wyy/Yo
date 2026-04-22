# Forward function references in module-level holder initialization

## Summary

When a module-level mutable holder is initialized at the bottom of a file with
a reference to a method defined earlier in the file via `impl(...)`, the C
codegen does not emit a forward declaration of the method, producing
`use of undeclared identifier 'fn_...'` errors.

## Reproducer (excerpt from `yo-self/parser/parser.yo`)

```rust
// Top of file
(_parse_primary_end_holder : Option((fn(self: *(Parser), ...) -> ParseResult))) = .None;

// ...

impl(Parser,
  parse_primary_end : (fn(self: *(Parser), ...) -> ParseResult)(
    // ...
  )
);

// Bottom of file
_parse_primary_end_holder = .Some(Parser.parse_primary_end);
```

The generated C contains:

```c
_parse_primary_end_holder = (__yo_enum_..._SOME)(... .value = fn_yode3c21e6_id_400_parse_primary_end ...);
//                                                              ^^^ undeclared
```

The function `fn_yode3c21e6_id_400_parse_primary_end` is defined later in the
same translation unit but no forward declaration is emitted for it where the
holder initialization runs.

## Workaround for parser bootstrap

Restructure the parser to avoid module-level function-pointer holders. Instead,
pass the recursive entry-points explicitly as parameters, OR move all mutually
recursive functions into a single `impl(Parser, ...)` block and rely on
`recur` / direct method calls.

## Fix needed

The codegen `collection.ts` / `declarations.ts` should ensure that any
function referenced as a value (not called) in a top-level initializer has a
C forward declaration emitted before the initializer.

## Severity

Blocks the current parser port pattern in `yo-self/parser/`. Not blocking for
day-to-day Yo use because the holder pattern is unusual.
