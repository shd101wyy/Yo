# LSP references, definition and rename of a parameter match every same-named parameter of the module

**Severity:** S2. `yo lsp` answered references on a parameter with the uses of every same-named parameter in the module, sent go-to-definition to line 0, column 0, and renamed the other functions' uses while leaving every declaration alone, which breaks the program.

> Found 2026-10-24 while fixing
> `issues/fixed/2026-10-23-explicit-copy-migration-keys-every-parameter-of-a-module-alike.md`.
> Both have one cause.

## Symptom

```yo
f :: (fn(x : i32) -> i32)(x + i32(1));
g :: (fn(x : i32) -> i32)(x * i32(2));
main :: (fn() -> unit)(());
export(main);
```

With the v0.2.69 tree binary (`f271ed005`):

- `textDocument/references` on `f`'s `x` (line 0, character 26) answered
  `f`'s use and `g`'s use (1:26). It omitted the declaration at 0:9.
- `textDocument/definition` on the same `x` answered 0:0, which is `f`
  itself.
- `textDocument/rename` of `g`'s `x` (1:26) to `n` edited `f`'s use (0:26)
  and `g`'s use. Neither declaration changed, so both functions referred to
  an undefined `n`.

## Root cause

The LSP finds the declaration of the variable an atom names
(`_binding_token_of`, `src/lsp/references.yo`) through `Variable.token`
(`initialized_at_token`), and compares declarations by position
(`_same_declaration`). A parameter was bound with
`synthetic_token(name, module)` (`_build_def_time_body_env`,
`src/evaluator/calls/function_type.yo`). That token is interned per module and
name, and sits at row 0, column 0. So every parameter named `x` in a module
had one declaration, at 0:0.

## Fix

The def-time body env binds each parameter with its declaration token, the
identifier its label is spelled with in the fn literal's `fn(...) -> R`
(`_fn_literal_param_tokens`). The fix and its scope are described in
`issues/fixed/2026-10-23-explicit-copy-migration-keys-every-parameter-of-a-module-alike.md`.

That covers a function whose body is evaluated at its definition. A body
deferred to its calls (a `generic` or `comptime` parameter, a closure with
an untyped parameter) has no ExprInfo on its atoms: a call evaluates a copy
of it. `src/lsp/references.yo` kept such an atom by name, so the review of
B4-0a found, for

```yo
f :: (fn(comptime(n) : usize, x : i32) -> i32)(x + i32(n));
g :: (fn(x : i32) -> i32)(x * i32(2));
```

references on `f`'s `x` (0:47) answering `g`'s declaration and use too,
definition answering nothing, and a rename of `g`'s `x` rewriting `f`'s body
but not `f`'s declaration. Calling `f` changes nothing, and neither would
binding the call's parameters with their declaration tokens: the
specialized copy's atoms are not the document's.

An atom with no ExprInfo is now judged by its syntactic scope
(`_scoped_atoms`, `src/lsp/references.yo`): the innermost fn literal or
closure declaring the name as a parameter, the `match` arm whose pattern
binds it, or a `name := v` above it in its block. References and rename
drop it when that declaration is not the target's, a target in a deferred
body takes its scope's declaration (`syntactic_decl_at`), and definition
answers it (`handle_definition`, `src/lsp/definition.yo`). An atom no scope
declares (a module-level name used in a deferred body) is still kept by
name.

Tests: `tests/cli-cases/lsp-parameter-identity` runs the first program above.
References now answer `f`'s declaration (0:9) and use, definition answers
0:9, and the rename edits `g`'s declaration and use only.
`tests/cli-cases/lsp-parameter-identity-deferred` runs the second: references
on `f`'s `x` answer 0:30 and 0:47, definition 0:30, and the rename of `g`'s
`x` edits 1:9 and 1:26 only.
`tests/cli-cases/lsp-deferred-body-scopes` covers a local and a `match` arm
binding in two deferred bodies: each `y` answers its own occurrences, where
all six were one symbol before.
