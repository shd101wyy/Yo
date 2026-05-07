# Self-hosted evaluator: memory leaks in enum-related tests

## Status: FIXED

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

### Root Cause 2 (FIXED): Later move suppressed earlier return cleanup

The leak persists after the dup fix. Investigation shows the String allocation
comes from `StringBuilder.to_string()` in the tokenizer (lexer), and the leaked
string matches the variant name token ("Some" = 4 bytes, "TypeA" = 5 bytes).

The remaining leak was not in `eval_atom`. It was in the self-hosted evaluator's
method-call path in `yo-self/evaluator/eval.yo`: `method_expr` is initialized
from `inner_args.get(1)`, used by enum-variant early-return branches, and then
later moved into `box(method_expr)` on the method-dispatch fallthrough path.

The evaluator marked `method_expr` as consumed because of the later
`box(method_expr)`. The normal scope-end drop list therefore excluded it, and
`generatePendingDeferredDrops` also treated any `consumedAtToken` as a binary
"already moved" flag. On enum-variant early returns before the `box` call, the
value was still owned by `method_expr`, but no drop was emitted.

```c
__yo_enum_yob0b9aff6_id_2 method_expr = ...;
...
return Option(EvalResult).Some(...); // needed drop(method_expr) here
...
box(method_expr); // later fallthrough consumes it
```

**Fix:** the evaluator now records per-return `earlyReturnOnlyDeferredDropExpressions`
for owning RC locals that are initialized at a return site but consumed later in
the same source scope. Codegen emits those drops only on the annotated return
site, while normal scope exit still skips them because ownership has moved.
`generatePendingDeferredDrops` was also made token-position aware so a consume
after the current return no longer suppresses that return's cleanup.

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

## Verification

1. `./yo-cli compile yo-self/tests/_leak_test.yo --release --sanitize address --allocator libc -o tmp/leak_test && ./tmp/leak_test`
2. `./yo-cli test ./yo-self/tests/eval_5a.test.yo --parallel 1`
