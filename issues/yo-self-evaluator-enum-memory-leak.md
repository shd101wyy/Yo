# Self-hosted evaluator: memory leaks in enum-related tests

## Status: TODO

## Symptom

5 tests in `yo-self/tests/eval_5a.test.yo` fail with ASAN LeakSanitizer detecting
unfreed memory (all pass correctly with `--disable-sanitize`):

| Test                                               | Direct leak | Indirect | Objects               |
| -------------------------------------------------- | ----------- | -------- | --------------------- |
| Phase 5ar: TypeVal.Variant(args) — Option.Some(42) | 40 B        | 4 B      | 1 direct + 1 indirect |
| Phase 5ar: TypeVal.Variant — Pair with two fields  | 40 B        | 4 B      | 1+1                   |
| Phase 5ax: enum variant destructured in match      | 40 B        | 4 B      | 1+1                   |
| Phase 5ay: ArrayList operations                    | 120 B       | 12 B     | 3+3                   |
| Phase 5ay: Option.is_some on enum variant          | 40 B        | 4 B      | 1+1                   |

## Root cause hypothesis

The leaked objects are `ArrayList(u8)` (40 bytes, the internal buffer struct of
`String`) + the character buffer (4 bytes). These are `String` objects created
during parsing/evaluation that aren't properly freed.

The leak is specifically triggered by tests that:

1. Use `generate_exprs_from_code()` (the self-hosted lexer + parser)
2. Involve enum type definitions, enum variant construction, or type constructor
   calls (`ArrayList(i32).new()`)

The leak trace points to `StringBuilder.to_string()` (which creates Strings from
lexer token buffers), suggesting the leaked String objects originate from token
creation in the self-hosted lexer, or from string construction in the self-hosted
evaluator's enum/variant handling code.

Tests that use direct AST construction (without the parser) do NOT leak.

### Possible causes

1. **Parser not dropping tokens**: The `Parser` struct contains `tokens : ArrayList(Token)`.
   When `get_program()` is called, the `program` field is returned (moved), but an
   empty `ArrayList(AstExpr)` might remain in the parser. If `get_program()` copies
   instead of moving, the original stays and must be dropped.

2. **Early return missing drops in handle_method_dispatch**: The TypeVal.Variant
   handler in `eval.yo` (line 3660-3663) has an early return `return
Option(EvalResult).None` that may not properly drop local variables like
   `sh_vn_str_sr` (the variant name String).

3. **Environment variable Strings**: When `define_val` is called with a `String`
   name, the String is stored in the Variable. If the Environment's `__drop`
   doesn't properly cascade through Frame → Variable → String, the String leaks.

## Investigation notes

- The `__drop` chain for `String` is: `String.__drop → Option(ArrayList(u8)).__drop →
__yo_decr_rc(value)`. The RC mechanism should zero out and free when refcount
  reaches 0.
- The `_ :=` pattern leak (issue `underscore-variable-memory-leak.md`) is fixed in
  the TypeScript evaluator but does NOT apply here — the self-hosted evaluator uses
  `_dch`, `_ffr`, etc. (named variables with underscore prefix), not bare `_`.
- The leak is only visible with ASAN leak detection; with `--disable-sanitize` all
  tests pass correctly.

## Next steps

1. Create a minimal test that only parses code (no evaluation) to isolate the leak
   to the lexer/parser vs. the evaluator.
2. Instrument the C code with debug `printf`s to track allocation/free pairs for
   String objects.
3. Check if the `Parser.__dispose` function properly frees all internal fields
   (`input_string`, `module_path`, `tokens`).
