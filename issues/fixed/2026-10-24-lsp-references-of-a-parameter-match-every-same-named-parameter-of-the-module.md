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

A function whose body is deferred to its calls (a `generic` or `comptime`
parameter, or a closure with an untyped parameter) binds its parameters
again at each call, and those binders used the synthetic token too
(`check_if_function_parameter_matches_argument` and
`create_specialized_function_inline` in `src/evaluator/calls/helper.yo`, the
runtime FuncVal call in `src/evaluator/calls/function.yo`). A first version
of this fix left them alone, and the review of B4-0a found references on
`f`'s `x` in `f :: (fn(comptime(n) : usize, x : i32) -> i32)(x + i32(n))`
still returning `g`'s `x`. A deferred function now registers its
parameters' declaration tokens under its FuncVal id
(`register_func_param_decl_tokens`, `src/evaluator/types/function.yo`; a
closure's from `evaluate_anonymous_function_implementation`), and every
call-time binder looks a parameter's token up there
(`func_param_decl_token`). The interned token stays the fallback for a
parameter with no written declaration.

Tests: `tests/cli-cases/lsp-parameter-identity` runs the program above. References now
answer `f`'s declaration (0:9) and use, definition answers 0:9, and the rename
edits `g`'s declaration and use only.
`tests/cli-cases/lsp-parameter-identity-deferred` runs the same requests on a
`f` with a `comptime` parameter.
