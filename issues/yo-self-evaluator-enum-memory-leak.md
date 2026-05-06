# Self-hosted evaluator: memory leaks in enum-related tests

## Status: PARTIALLY FIXED

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

## Minimal reproduction

The file `yo-self/tests/_leak_test.yo` contains a minimal test case. The leak
reproduces with:

```yo
src := "MyOpt :: enum(None, Some(i32)); val := MyOpt.Some(i32(42));";
```

Leak scales linearly: 3 variant constructions = 120B direct + 12B indirect.

The leak does NOT reproduce with:

- Parse-only (no evaluation)
- Fieldless variant construction (`.None`)
- Simple type constructor (`i32(42)`)
- Two-field variants (Pair test) — only in the minimal test; leaks in the test framework context

## Root cause analysis

### Root Cause 1 (FIXED): Buggy `___dup` function codegen

**File:** `src/evaluator/types/utils.ts`

The `generateDupFunctionCodeForStructType` and `generateDupFunctionCodeForEnumType`
functions generated `___dup` bodies that destructured RC-managed fields, called
`___dup` on local copies, **discarded the return values**, and returned the
original `__yo_self` unchanged.

```yo
// Old (broken) struct dup:
(__yo_self: StructType) -> StructType {
  { field1: _alias } := __yo_self;
  (___dup)(_alias);          // Return value discarded!
  return __yo_rc_own(__yo_self);  // Original returned unchanged
}
```

This meant `dup` was a **no-op** for all RC tracking — the returned value had the
same reference counts as the input. This affected _all_ struct and enum types,
including `String`, `Token`, `AstExpr`, etc. The RC increments from the internal
`___dup` calls leaked into local variables that were never dropped.

**Fix:** The dup functions now properly construct new struct/enum values with the
dup'd field values:

```yo
// New (fixed) struct dup:
(__yo_self: StructType) -> StructType {
  { field1: _alias } := __yo_self;
  return Self(field1: _alias.___dup());  // New struct with dup'd value
}
```

For the Token type, the generated C now correctly:

1. Destructures all fields (kind, value, row, column, character, module_path, input)
2. Calls `___dup` on String fields (value, module_path, input), storing the results
3. Constructs and returns a new Token with the dup'd values

### Root Cause 2 (INVESTIGATING): Token parameter not dropped in `eval_atom`

The leak persists after the dup fix. Investigation shows the String allocation
comes from `StringBuilder.to_string()` in the tokenizer (lexer), and the leaked
string matches the variant name token ("Some" = 4 bytes, "TypeA" = 5 bytes).

In `eval_atom` (called during evaluation of Atom AST nodes), the `tok` parameter
is received by value. The function accesses `tok.value` and creates a dup'd copy
for the IntLit/StrLit/etc. EvalValue. But the original `tok` parameter (and its
String fields) are **never dropped** in the generated C code.

At the call site in `evaluate`:

```c
__yo_struct_yo1584f7d8_id_30 tok = e.data.Atom.token;  // bitwise copy from AST
fn_yob146cf76_id_34_eval_atom((__yo_struct_yo1584f7d8_id_30)(tok), env);
// tok is NOT dropped after this call
```

The Yo compiler should generate a drop for `tok` since its ownership was
transferred to `eval_atom`, but the C code misses this drop. This is a codegen
bug in how function parameters of value type (struct) are handled after being
"moved" into a function call.

## Investigation notes

- The `__drop` chain for `String` is: `String.__drop → Option(ArrayList(u8)).__drop →
__yo_decr_rc(value)`. The RC mechanism should zero out and free when refcount
  reaches 0.
- The `_ :=` pattern leak (issue `underscore-variable-memory-leak.md`) is fixed in
  the TypeScript evaluator but does NOT apply here — the self-hosted evaluator uses
  `_dch`, `_ffr`, etc. (named variables with underscore prefix), not bare `_`.
- The leak is only visible with ASAN leak detection; with `--disable-sanitize` all
  tests pass correctly.
- Incremental LSAN checks (`__lsan_do_leak_check()`) during program execution do NOT
  detect the leak, meaning the leaked String is still reachable through some pointer
  chain (likely a live local variable or the AST). The String is only flagged as
  leaked at process exit when all stack variables are gone.
- The Parser's `__dispose` correctly frees all internal fields (input_string,
  module_path, tokens). Parse-only tests confirm no leak.
- The Environment's `__dispose` chain (Environment → frames → Frame → variables →
  Variable → fields) correctly drops all Strings.

## Next steps

1. Fix the codegen for function parameter dropping after a value parameter is
   "moved" into another function call (e.g., `eval_atom(tok, env)` should drop
   the caller's copy of `tok`).
2. Verify the fix eliminates the remaining leak in the minimal test and the
   eval_5a tests.
3. Run the full yo-self test suite with ASAN to confirm all leaks are fixed.
