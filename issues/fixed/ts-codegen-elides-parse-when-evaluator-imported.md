# TS codegen elides `parse` function body when `evaluator/exprs/_expr.yo` is imported into `main.yo` (FIXED)

> **Fixed** in commit `a75007f9` (`codegen: keep base function emitted
when no specialized replacement is registered`). The skip rule in
> `src/codegen/functions/{declarations,generation}.ts` now keeps the
> base (unspecialized) function emitted unless a _registered_
> specialized FunctionValue actually shares its `cName` — i.e. unless
> there is something in `context.functions` that will resolve the call
> sites that still emit the base name. Importing the evaluator into
> `yo-self/main.yo` now builds cleanly via `./yo-cli compile`. Stream
> A's main.yo wiring (commit `36b2434e`) lands on top of this fix.

## Symptom

When `yo-self/main.yo` adds `import("./evaluator/exprs/_expr.yo")` (or
any transitive import that pulls in `evaluator/calls/helper.yo` or
`evaluator/builtins/type_fns.yo`), the TS-built `yo-cli compile yo-self/
main.yo` produces a `yo-self/yo-self-bin.c` that references
`fn_yode3c21e6_id_525_parse` (the C name for `parser.yo`'s `parse`)
**3 times** but never declares OR defines it:

```text
yo-self/yo-self-bin.c:20414:  ... = fn_yode3c21e6_id_525_parse(src, input_path, exn__throw);
yo-self/yo-self-bin.c:98566:  ... = fn_yode3c21e6_id_525_parse(src, input_path, exn__throw);
yo-self/yo-self-bin.c:100031: ... = fn_yode3c21e6_id_525_parse(src, _yo89259b18_temp_..., exn__throw);
```

With clang `-std=c11`, this is a hard error:

```text
yo-self/yo-self-bin.c:98566:61: error: call to undeclared function
  'fn_yode3c21e6_id_525_parse'; ISO C99 and later do not support
  implicit function declarations [-Wimplicit-function-declaration]
```

Without the evaluator import, `parse` has both a forward declaration
(near line 5037) and a body (near line 22138), all three call sites
resolve, and the build succeeds.

## Why this blocks Stream A

`plans/archive/BOOTSTRAPPING.md` Path Forward Stream A is "wire the proper
evaluator into the main pipeline". The natural shape is:

```yo
// yo-self/main.yo
{ register_evaluate_expression } :: import("./evaluator/exprs/_expr.yo");
{ evaluate_anonymous_module_begin_exprs } :: import("./evaluator/values/anonymous_module.yo");
// … after parse():
table := try_populate_expr_info_table(exprs, input_path);
set_pipeline_expr_info_table(table);
opt_c := compile_module_to_c(exprs, mod_id.as_str(), "main");
```

Both `_expr.yo` and `anonymous_module.yo` transitively import
`evaluator/calls/helper.yo`, which imports `parser/parser.yo`'s
`generate_expr_from_code` — so `parse` is reached via two paths
(directly from main.yo and indirectly via the evaluator). The TS
function collection or specialization step appears to dedup the two
references in a way that loses the definition.

Splitting the wiring into a `yo-self/pipeline/evaluate_pipeline.yo`
shim does not help: the bug only requires that _some_ import path
from main.yo pulls in `_expr.yo`.

## Reproduction (minimal)

The smallest change that triggers the bug:

```diff
 // yo-self/main.yo
 { parse } :: import("./parser/parser.yo");
+{ register_evaluate_expression } :: import("./evaluator/exprs/_expr.yo");
 { compile_module_to_c, ... } :: import("./codegen/driver.yo");
```

Then:

```bash
./yo-cli compile yo-self/main.yo --release -o yo-self/yo-self-bin
# → 6 errors about fn_yode3c21e6_id_525_parse being undeclared
```

Importing only `EvalContext` from `evaluator/context.yo` does **not**
trigger the bug — confirming `_expr.yo`'s import graph is the relevant
shape.

## Likely TS-side fix

Investigation pointed to a mismatch between call-site C-name emission
and the declaration-skip rule in
`src/codegen/functions/declarations.ts`:

```ts
// declarations.ts ~line 135:
if (
  !isUserMain &&
  !value.type.isClosure &&
  !value.isEffectRecordMember &&
  value.specializedFunctionCaches?.length > 0
) {
  continue; // skip the unspecialized — "specialized versions handle codegen"
}
```

The skip rule says: when a function has specialization caches, the
_base_ (unspecialized) version is omitted from declarations on the
assumption that all call sites will emit specialized C names. But in
this bug all three `parse` call sites still emit the _base_ C name
`fn_yode3c21e6_id_525_parse` — no specialization suffix — so the
declaration skip leaves the call sites dangling.

So either:

- The call-site codegen for one of the call sites should pick the
  correct specialization (and emit that specialized name); OR
- When the unspecialized name is still needed at a call site, the
  declaration skip should keep the base around (perhaps emitting
  both base and specialized variants).

Likely the right fix is in `other-fn-call.ts` (or whichever handler
emits the call to `parse`): when a call's effective parameters match
the base type but specializations also exist for other call sites, the
call should be routed to the matching specialization rather than the
base. Or the declarations.ts skip rule should require that _no_ call
site still uses the base name.

Also worth checking: the `isFunctionSpecializable` predicate in
`src/types/guards.ts:514` is logically inconsistent with the
`!functionValue.specializedFunctionCaches` check in
`src/codegen/functions/collection.ts:578` — `isFunctionSpecializable`
already requires `specializedFunctionCaches.length > 0`, so the
conjunction in `collection.ts` is dead code.

## Workaround

Until the TS side is fixed, Stream A's `yo-self/main.yo` wiring stays
on the shelf. The handoff plumbing (`set_pipeline_expr_info_table` +
`compile_module_to_c` slot reading + per-handler ports) is fully in
place — unit tests in `codegen_pipeline_handoff.test.yo` and
`codegen_expr_info_pipeline.test.yo` prove the end-to-end metadata
flow works at the API level. Only the final wiring into main.yo is
blocked.
