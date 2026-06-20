# yo-self: `open(import("std/fmt"))` strips function types → forall not inferred

## Status: FIXED

## Symptom

After `open(import("std/fmt"))`, calling a generic std function like
`println(s)` / `eprintln(e.to_string())` emitted `// Failed to transpile
println(...)` in the self-hosted compiler. The SAME call works under a NAMED
import `{ println } :: import("std/fmt")`. This blocked `yo-self/error.yo`
(`print_yo_error` body `eprintln(error.to_string())`) and is pervasive:
`open(import("std/fmt"))` appears in ~104 yo-self files.

## Minimal repro (TS passes, yo-self failed)

```rust
open(import("std/string"));
open(import("std/fmt"));
main :: (fn() -> unit)({ println(String.from("hi")); () });
export(main);
```

`{ println } :: import("std/fmt")` → 0 errors. `open(import("std/fmt"))` → 1
"Failed to transpile". Diagnostic in the emitted C: the named form specialized
`println` as `yo_id_5724_String_rtparam0_String(String v)` (forall T=String
bound), but the open form gave `yo_id_5724_rtparam0_String(void)` — **forall T
unbound, `v : T` lowered to `void`** — so the call couldn't match and produced
no ExprInfo.

## Root cause

`evaluate_open` (open.yo) binds each module field via
`add_variable_to_env(next_env, field_name, field_ty, .Some(field_val), …)`,
computing `field_ty := type_of_eval_value(field_val)`. But `type_of_eval_value`
(value.yo) has **no `.FuncVal` arm** — it falls through to `_ => t_unit()`. So a
function brought in by `open` was bound under type `unit`. At the call site
`try_to_call_function_with_arguments` saw a non-Func callee, soft-fell to `unit`
WITHOUT inferring forall args, and codegen specialized the body with `T` unbound
(→ `void` param). A NAMED import binds the field via the real Func type (the
destructuring path reads the actual variable type), which is why it worked.

In TS the open'd value carries its own `.type` back-reference, so the function's
real Func type (with forall labels) is preserved. yo-self values don't carry
their type; `type_of_eval_value` reconstructs it but omitted the FuncVal case.

## Fix

In `evaluate_open`'s module-field loop, compute a FuncVal field's type from the
function-type registry (`get_func_type(fid)`) — the yo-self equivalent of TS's
`value.type` — instead of `type_of_eval_value`:

```rust
field_ty := match(
  field_val,
  .FuncVal(_, _, _, _, _, _, _, _, fid) => get_func_type(fid),
  _ => type_of_eval_value(field_val)
);
```

Fixed at the open site (not by adding a FuncVal arm to `type_of_eval_value`)
because `value.yo → function_value.yo → env.yo → value.yo` is an import cycle;
open.yo already sits above function_value.yo, so importing `get_func_type` there
adds no new cycle.

## Validation

- Minimal repro + `tests/codegen-bootstrap/open_import_println.yo` (new fixture)
  → 0 errors, runs "YNS" matching TS.
- `yo-self/error.yo` transpile errors 1 → 0.
- Corpus differential: PASS, 0 DIFFs. (The 2 SELF-FAILs seen per run are the
  pre-existing intermittent SIGTRAP-in-malloc heap-corruption bug — DIFFERENT
  fixtures each run; measured 8/20 crashes on `match_arm_folded_fncall` with the
  BASELINE binary (no this fix) vs 6/20 with the fix → this change does not
  affect flakiness. That bug is tracked separately.)
