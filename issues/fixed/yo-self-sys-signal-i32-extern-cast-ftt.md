# yo-self: `i32(<extern-C call>)` fails to transpile — sys/signal red

**Status: FIXED 2026-07-22** (this commit) — flips sys/signal 1/1 (#69 +1,
152/183). Two-part fix: `is_convertible_numeric_type` gains the TS
`isExtern === "c" && isSomeType` clause (evaluator/calls/numeric_type.yo),
and `c_include` type declarations (`pid_t : Type`) now
`register_extern_type_name` like `extern(...)` blocks do
(evaluator/exprs/c_include.yo) — the registry was empty for c_include
opaque types, so the new clause (and every other extern-aware check) never
saw them.

## Symptom

`s2 test ./tests/sys/signal.test.yo` rc=1: batch C contains
`int32_t pid = // Failed to transpile i32(unsafe(getpid()));` → cascade of
"unexpected type name / undeclared identifier" clang errors. (The old sweep
recorded rc=138 for this file; with the 150/183 binary it is a plain rc=1
compile failure — this FTT.)

## Repro (issues/repros shape; TS prints `pid positive: true`)

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/string"));
open(import("std/fmt"));
{ getpid } :: import("std/libc/unistd");
main :: (fn() -> unit)({
  pid := i32(unsafe(getpid()));
  println(`pid positive: ${pid > i32(0)}`);
});
export(main);
```

Variants tested (all fail the same way with /tmp/rc3_s2):

- `raw := unsafe(getpid()); pid := i32(raw);` — `raw` lowers to `void*`
  (extern pid_t type unrendered) AND `i32(raw)` still FTTs.
- `pid := unsafe(i32(getpid()));` — `i32(getpid())` FTTs.

⇒ the discriminator is the EXTERN-C-typed argument (`pid_t`), not the
`unsafe` nesting: `i32(<extern call>)` reaches
`generate_other_function_call` (codegen/exprs/other_fn_call.yo) and returns
`.None` → the generation.yo:598 "Failed to transpile" fallback.

## Where to look (next session)

- TS lowers `i32(x)` through the BUILTIN-YO-INLINE path: std's `i32` fn body
  is a single `__yo_builtin_inline` call;
  `isFunctionValueWithOnlyBuiltinYoInlineFunctionCall` +
  `generateYoInlineFunctionCall` (other-fn-call.ts:898) emit
  `(int32_t)(...)` directly. yo-self has the mirrored machinery
  (other_fn_call.yo:1082 method path, :1529 extern-name path) — find which
  gate bails when the ARG's type is an extern opaque type (pid_t): suspects
  are the callee ExprInfo value lookup (i32's FuncVal missing on this route)
  or an arg-type render returning "" that nulls the call.
- Also fix the secondary rendering: `unsafe(getpid())` bound to a local
  lowers the extern return type to `void*` (see variant 2) — extern type
  names should render via `is_extern_type_name` (codegen/utils/index.yo).
- Probe recipe: eprintln at other_fn_call.yo's major `.None` bail-outs gated
  on `ast_expr_token(expr).module_path.contains("/tmp/")`, compile the repro
  above, read which bail fired.

Likely covers additional sys/\* reds that call libc-returning externs
through numeric casts.
