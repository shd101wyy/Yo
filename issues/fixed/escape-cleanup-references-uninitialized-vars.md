# Escape / break cleanup references uninitialized variables

**Status:** FIXED

## Symptoms

C compilation of generated code fails with `use of undeclared identifier`
errors for variable names that _will_ be declared later in the same C function
body. The undeclared names are emitted in cleanup blocks attached to:

- `if (__yo_effect_escaped) { ... fn_..._drop(NAME); ... return ...; }` paths
  produced after a function-pointer effect call, **and**
- `if (cond) { fn_..._drop(NAME); ... goto loop_xxx; }` paths produced for
  `break`/`continue` inside a `match` arm or `cond` branch.

Example, distilled from `yo-self/parser/parser.yo`:

```rust
parse_paren_expr : (fn(self : *(Self), index : usize, using(exn : Exception)) -> ParseResult)({
  (tok : Token) = match(self.tokens.get(index),
    .None    => exn.throw(dyn ParseError(message: `unexpected end of input`)),
    .Some(t) => t
  );
  ...
});
```

emits cleanup that references `tok` _before_ `tok`'s C declaration:

```c
((void (*)(...))exn__throw)(...);
if (__yo_effect_escaped) {
  ...
  fn_..._drop((__yo_struct_..._30)(tok));   // ❌ tok not yet declared
  ...
}
...
__yo_struct_..._30 tok = _yode3c21e6_temp_52731;  // declared HERE
```

The break-in-loop variant looks like:

```rust
while runtime(true), {
  match(self.tokens.get(cur_idx),
    .None         => { break; },
    .Some(next_dot) => {
      if((next_dot.kind != TokenKind.Dot), { break; });
      chain_pr := self.parse_primary((cur_idx + usize(1)), using(exn));   // declared after the break
      ...
    }
  );
};
```

emits `fn_..._drop(chain_pr); goto loop_xxx;` before `chain_pr`'s declaration.

## Root cause

`evaluateBinding` adds the LHS variable to the environment **before** the RHS
is evaluated, with `initializedAtToken: undefined` (the variable exists in the
env but has not yet been initialized). When the RHS is itself a `match` /
`cond` whose arm performs a control-flow exit (escape / break / continue /
return), the cleanup code generator walks `pendingDeferredDrops` (which
contains a drop entry for the soon-to-be-bound variable, because that drop was
registered for the enclosing begin-block at evaluation time) and emits a
drop whose target identifier is not yet declared in C.

For begin-block-local variables that are declared _after_ the early-exit
point, the same problem appears in `emitLoopBodyDropsBeforeExit` (the
`break`/`continue` path), which previously did not consult any environment at
all.

## Fix

Two filters were added:

1. `generatePendingDeferredDrops` (`src/codegen/exprs/return.ts`): in the
   env-aware branch, additionally skip a pending drop if the latest version
   of the target variable in `expr.$.env` has `initializedAtToken === undefined`.

2. `emitLoopBodyDropsBeforeExit` (`src/codegen/exprs/atom.ts`): now accepts
   the `break` / `continue` / `return` atom expression and uses its
   `expr.$.env` to skip drops whose target is either absent from the env or
   not yet initialized (or already consumed).

Together these prevent the codegen from emitting drops for variables whose
C declaration appears later than the cleanup site.

## Regression test

`tests/escape_cleanup_uninit_vars.test.yo` covers both shapes: a `(tok : T) =
match(..., .None => exn.throw(...), .Some(v) => v)` pattern, and a
`while runtime(true), match(..., .Some(_) => { if(_, { break; }); X := ...; })`
pattern.
