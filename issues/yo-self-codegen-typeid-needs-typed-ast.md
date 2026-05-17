# yo-self codegen `typeid` port needs typed AST metadata

## Symptom

`src/codegen/exprs/typeid.ts` cannot be faithfully ported to
`yo-self/codegen/exprs/typeid.yo` yet.

The TypeScript handler reads evaluator-attached metadata:

- `arg.$.value` must be a `TypeValue`
- `type.value.id` is used as the stable type id
- `context.typeIdStatics` deduplicates emitted static declarations
- `context.cIncludes` registers `<stdint.h>`

The current self-hosted codegen receives bare `AstExpr` nodes only:

```rust
AstExpr :: enum(
  Atom(id : ExprId, token : Token),
  FnCall(id : ExprId, func : Box(Self), args : ArrayList(Self), is_infix : bool, token : Token)
);
```

There is no `expr.$` equivalent available to codegen, and
`yo-self/codegen/context.yo` does not yet expose `typeIdStatics` / `cIncludes`.

## Correct fix

Do not add an ad-hoc string-based `typeid` implementation. Preserve 1-to-1
porting by first adding the typed/evaluated expression metadata and context
fields needed by the TypeScript implementation, then port
`src/codegen/exprs/typeid.ts` directly.
