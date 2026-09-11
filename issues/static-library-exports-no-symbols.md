# `yo compile --static-library` exports no symbols — every function is `static inline` under a mangled name

**Status:** OPEN
**Found:** 2026-09-11, while fixing `issues/step-link-does-not-link-the-static-library.md`:
once the build runner passed `libadd.a` to the consumer's link, the link still
failed with `Undefined symbols: "_add"` — because the archive does not contain
`add`. Reproduced with `yo 0.2.30` and with a compiler built from `develop`.
**Severity:** high — static libraries (`build.static_library`, `yo compile
--static-library`, the docs' `extern("Yo", …)` example) cannot be consumed by
anything, and the wasm `-sEXPORTED_FUNCTIONS` plain-name story rests on the
same mechanism.

## Reproducer

```rust
// add.yo
add :: (fn(a : i32, b : i32) -> i32)(a + b);
export(add);
```

```
$ yo compile add.yo --static-library -o libadd
$ nm libadd.a | grep ' T '
0000000000000000 T ___yo_alloc_fail
```

The only external symbol in the archive is a runtime helper. `add` was
emitted as `static inline fn_yo_id_<N>(...)` — internal linkage, mangled name —
so no consumer can reference it. (`___yo_alloc_fail` being external is the
mirror-image bug: when the archive member IS pulled in, that symbol collides
with the consumer's own copy.)

## Root cause

The port kept the TypeScript rule but not the data it keyed on.
`_collect_required_function_field` (`src/codegen/functions/collection.yo:470-528`)
gives a top-level export its plain label as C name — and external linkage via
`exported_function_labels` (`declarations.yo:892`, `generation.yo:582`) — only
when the function is "from the current module", decided as
`func_id.starts_with("fn_" + current_module_id + "_")`. Two things make that
never true:

1. `CodeGenContext.current_module_id` is initialised `.None`
   (`src/codegen/utils/index.yo:356`) and **never assigned** anywhere in `src/`.
   TS set it to `generateModuleId(modulePath)` when creating the context
   (`src-attic-final:src/codegen/codegen-c.ts:114`).
2. Even if it were set, Yo function ids carry no module component: `random_id`
   (`src/utils.yo:292-296`) mints `yo_id_<counter>`, so every function id is
   `fn_yo_id_<N>` and the `fn_<module-hash>_` prefix test can never match. The
   TS test was written against `fn_<sha1-prefix>_…` ids.

So the "current module" test must be re-expressed on data the Yo compiler
has: the defining token of the function body carries its module path
(`ast_expr_token(body).module_path`, already used at `codegen_c.yo:531`), and
`compile_module` has the entry module's path in `module_env.module_path`.

## Fix direction

- `CodeGenContext.current_module_id` → `current_module_path : Option(String)`,
  set in `compile_module` from `module_env.module_path` before collection.
- `_collect_required_function_field`: from-current-module ⇔
  `is_top_level_export && ast_expr_token(_func_val_body(value)).module_path == current_module_path`.
- Library mode: runtime helpers emitted with external linkage
  (`__yo_alloc_fail`, `src/codegen/c/collection.yo:193` and
  `allocator_fixed.yo:501`) become `static` so an archive member does not
  collide with the consumer's own runtime.
- Gate: `tests/cli-cases/build-link-static` (the docs example; the built program
  prints `7`), plus `nm`-level assertions in `tests/internal/` if a runner can
  spawn `nm` portably — otherwise the link itself is the assertion.
