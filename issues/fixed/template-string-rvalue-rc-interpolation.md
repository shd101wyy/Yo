# Template-string interpolation of an RC-typed function call result emits invalid C

## Summary

When the expression inside a template-string interpolation `${...}` is a
**function call (or `recur(...)` call) that returns a reference-counted /
non-trivial value** (e.g. `String`, an enum with a `Box` field, etc.), the
generated C is malformed:

1. It tries to take the address of an rvalue (the call result):
   `(&fn_xxx_render(inner->_u42_))`
2. It emits a `___drop` line that references a `_temp_NNNN` identifier that
   is never declared.

Source-level workaround (bind to a local first, then interpolate the local)
produces correct code — proving the bug is in template-string codegen, not
in `___drop`/`___dup` itself.

## Minimal reproduction

`tmp/repro_recur_in_template.yo`:

```rust
open import "std/string";
open import "std/fmt";

E :: enum(A, B(inner : Box(Self)));

render :: (fn(e : E) -> String)(
  match(e,
    .A => `A`,
    .B(inner) => `(${recur(inner.*)})`     // <-- recur call inside ${}
  )
);

main :: (fn() -> unit)({
  e := E.B(box(E.A));
  println(render(e));
});

export main;
```

Run:

```
./yo-cli compile tmp/repro_recur_in_template.yo --release -o /tmp/repro1
```

Generated C (excerpt):

```c
__yo_struct_yoa98c08fb_id_22* _yo2a4bd4ef_temp_39163 =
    (&fn_yo2a4bd4ef_id_38_render(inner->_u42_));   // ERROR: address of rvalue
...
fn_yoa98c08fb_id_40___drop(
    (__yo_struct_yoa98c08fb_id_22)(_yo2a4bd4ef_temp_39162)); // ERROR: undeclared
```

`clang` errors:

```
error: cannot take the address of an rvalue of type '__yo_struct_yoa98c08fb_id_22'
error: use of undeclared identifier '_yo2a4bd4ef_temp_39162'
```

## Workaround that confirms the diagnosis

```rust
.B(inner) => {
  s := recur(inner.*);
  `(${s})`
}
```

compiles and runs cleanly (`(A)` printed). The only difference is that the
template-string interpolation now sees an lvalue identifier rather than a
fresh function-call result.

## Suspected location

`src/parser.ts` desugars `${expr}` to `expr.to_string()`. `String.to_string`
(and similar) takes `&self`, so the codegen for the method call wraps the
argument in `(&...)`. There's an off-by-one between the temp variable
allocated for spilling the call result and the name actually emitted at the
`(&...)` site, so the generated C references an undeclared name AND fails to
spill into an lvalue.

Likely culprit: codegen for method-call argument coercion in
`src/codegen/exprs/other-fn-call.ts` or property-access dispatch — the temp
spill for "rvalue call needs to become an lvalue for `&self`" is not wired
up consistently.

## Impact

Blocks direct, recursive Yo code that builds strings from a recursive data
structure — exactly the pattern needed for `type_to_string`,
`expr_to_string`, etc. in the self-hosted compiler.

## Fix

In `src/codegen/exprs/ptr-fns.ts` `generateAddressOf`, before emitting the
generic `(&${argCode})` fallback, detect if `arg` is an rvalue function-call
expression (not an atom, not a property access). If so, spill it into a
named temp first and take the address of the temp. This matches the existing
`isIndexTraitAddressOf` branch's spill logic. Reuses `arg.$.variableName` as
the temp name when one was already attached (typical for RC-typed return
values), so the existing scope-end drop in the begin block still references
the right variable.

## Status

Fixed.
