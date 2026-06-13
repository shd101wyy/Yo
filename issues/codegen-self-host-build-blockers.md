# Self-hosted codegen build blockers (TS compiler → C, on yo-self/codegen/*.yo)

Status: **2 open TS-codegen bugs** block building `yo-self-bin` *with* the
self-hosted codegen linked in. Discovered when wiring `compile_module` into
`run_compile` (`yo-self/main.yo`) — importing `./codegen/codegen_c.yo` pulls the
whole codegen into `main.yo`'s compile graph for the **first time** (previously
`run_compile` threw, so the codegen `.yo` files were `check`-clean but never
compiled to C). Confirmed by isolation: reverting the wiring → `./yo-cli compile
yo-self/main.yo -o /tmp/yo-self-bin` builds clean (exit 0).

One bug found in the same surfacing was **already fixed + committed** (commit
`2714b2f20`): `splitTopLevelArgsList` / `_split_top_level_args_list` not skipping
C string literals (the `)` inside `c.ends_with(")")`'s str initializer corrupted
the bracket-depth counter). Regression test: `tests/short_circuit_str_literal_arg.test.yo`.

## Bug 1 — `void temp = ;` (unit-valued expression assigned to a temp)

Emitted C (module `yo22485147`, a codegen fn matching on a `Func` TypeValue —
the `declarations.yo` `_func_result_type` / `generate_function_prototype` region,
where `function_type.data.Func.result` is read and `___dup`'d):

```c
  }   // end of a preceding (unit-valued) match emitted as a switch
  void _yo22485147_temp_389143 = ;          // <-- incomplete type 'void' + expected expression
  __yo_enum_yob87149e5_id_3 _yo22485147_temp_389148;
  switch ((function_type).tag) {
  case __YO_ENUM_YOB87149E5_ID_3_FUNC: {
    __yo_struct_yo1c2129e9_id_55959* r = function_type.data.Func.result;
    ...
```

Root cause: a **unit-valued sub-expression** in value position (likely an
`if`-without-else, a `match` arm whose body yields unit, or a block whose tail is
unit) is materialized into a temp as `void <temp> = ;` (empty RHS) instead of
being emitted as a bare statement with no temp. A `void`-typed temp is itself
illegal C. The TS codegen must not bind unit-typed values to a C temp.

Repro: TBD — extract the `declarations.yo` construct that lowers to the
`void temp = ;` (bisect the functions around the `Func` match). Likely a
`match`/`if` used in a `:=` or argument position whose result type is `unit`.

## Bug 2 — `return;` inside the `void*` worker entry (effectful module-level init)

Emitted C (`src/codegen/functions/generation.ts` `generateMainWrapper`, the
`__yo_main_thread_entry` module-level-init loop, ~line 912):

```c
static void* __yo_main_thread_entry(void* __yo_unused_arg) {
  ...
  __yo_struct_yod80dab5d_id_735* tmp = fn_..._build_builtin_yo_inline_functions();
  if (__yo_effect_escaped) {
    return;        // <-- non-void function should return a value (-Wreturn-mismatch, hard error in clang 21+)
  }
  BuiltinYoInlineFunctions = tmp;
  ...
```

Root cause: effectful module-level initializers (whose RHS call may unwind, e.g.
`BuiltinYoInlineFunctions = _build_builtin_yo_inline_functions()`) emit the
effect-unwind check `if (__yo_effect_escaped) { return; }` (via
`emitEffectUnwindCheck`, `other-fn-call.ts:3519`). That bare `return;` is correct
for a `void` Yo function but is spliced into `__yo_main_thread_entry`, which
returns `void*` → return-mismatch. Surfaced now because importing the codegen
makes more effectful module-level globals reachable.

Fix options: (a) in the `__yo_main_thread_entry` module-init loop, emit init RHS
in a context whose effect-unwind return is `return NULL;`; or (b) make
`emitEffectUnwindCheck` return-type-aware (it currently assumes `void`); or
(c) module-init effect escapes are unhandleable anyway — emit `return NULL;`
(worker entry) / fatal there.

## Ready-to-apply: `run_compile` wiring (reverted to keep the build clean)

The wiring itself is correct and `check`-clean (`./yo-cli check yo-self/main.yo`
passed). It is reverted only so the `yo-self-bin` build (the validation loop)
stays green until Bugs 1 & 2 are fixed. Re-apply after the fixes, then rebuild
and run `scripts/diff-test.sh` for the first PASS.

`main.yo` imports to add:
```rust
{ host_target } :: import("./target.yo");
{ compile_module } :: import("./codegen/codegen_c.yo");
```

`run_compile` body (replaces the `exn.throw("...removed...")`): parse argv
(`-o`/`--c-compiler`/`--release`/positional), ensure prelude cached
(`check_single_file(`${std_path}/prelude.yo`, ...)`), read+parse the input,
set up the demand loader + env + ctx (mirror `check_single_file` lines 737-756),
`_eval_module_exprs_capturing_error` → `module_value` + `ctx.expr_info_table`,
`compile_module(module_value, ctx.expr_info_table, host_target(), "libc", false,
false, false, false)` → C string, `write_file(`${output}.c`)`, then
`Command.new(cc).arg("-std=c11").arg("-pthread").arg(c_path).arg("-o").arg(output)
.arg("-lm").status(io)`; throw on non-zero exit. (Note: a `.None` module-value
arm uses `return(())` — `unwind(())` is rejected with "no enclosing function".)
