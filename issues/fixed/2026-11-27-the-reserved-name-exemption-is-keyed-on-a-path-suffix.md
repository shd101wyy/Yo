# The reserved-builtin-name exemption is keyed on the path suffix `std/prelude.yo`

**Severity:** S3

**Found:** VERDICTS-93 §6 item 6 (2026-11-27), relayed by the v0.2.81 coordinator.

## Symptom

The gate that rejects a binder named by a builtin (E0407) exempted std's
prelude by testing `module_path.ends_with("std/prelude.yo")` at its three
sites (`binding.yo`, `initialization-assignment.yo`,
`destructuring-assignment.yo`). A std root passed with `--std-path` whose
directory is not named `std` therefore made the prelude's own builtin-named
binding (`unsafe :: impl(...)`) an error, and a user file at
`x/std/prelude.yo` was exempt.

Reproducer (`tests/cli-cases/check-prelude-binds-a-reserved-name-under-any-std-root`):

```bash
mkdir lib && printf 'pragma(Pragma.SkipPrelude);\nunsafe :: (fn(x : u8) -> u8)(x);\nexport(unsafe);\n' > lib/prelude.yo
printf 'main :: (fn() -> unit)(());\nexport(main);\n' > main.yo
yo check main.yo --std-path ./lib
```

```text
error[E0407]: "unsafe" names a builtin: every call with this name dispatches to the builtin, so a user binding could never run. Choose a different name.
```

## Root cause

A path suffix stands in for "the prelude of the std root this compilation
uses". VERDICTS-72 already named the same trap for the `__yo_` gate.

## Fix

The reserve-builtin-names PR replaces the three inline gates with one,
`reject_reserved_binder` (`src/evaluator/memory-safety.yo`). Its statement
form, `reject_reserved_definition`, exempts a std module's own top-level
definitions by `is_std_module_path`, which absolutizes the module path and
the resolved std root (`ctx.std_path`) and compares prefixes; no path
suffix is read. The cli-case above checks the prelude under
`./lib` (passes) and a user file binding the same name under that root
(E0407).
