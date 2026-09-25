# The compiler keeps `Exception` handlers in module globals

**Found:** 2026-09-26, the first full battery of `plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 5.
**Severity:** MEDIUM (a latent use of a handler after its frame returned; no failure observed).
**Status:** FIXED on `tss/phase5`.

## What

Phase 5.5 checks a module-level typed binding (`(g : T) = init`) for a control-bound type, as the
`:=` form already was. A stored handler can be invoked after the frame that installed it has
returned, and then `unwind`s into a dead frame. The compiler's own source had two such slots:

```rust
(g_loader_exn : Option(Exception)) = Option(Exception).None;         // src/module_manager.yo
(g_codegen_fatal_exn : Option(Exception)) = Option(Exception).None;  // src/codegen/constants.yo
```

- The demand loader stashed the driver's handler because `ctx.load_module` has no `exn`
  parameter. It used the handler for file read and parse errors only. When no handler was
  set, it returned "no error" for a module it had not loaded.
- Codegen registered the compile's handler so emitters, which do not thread `exn`, could throw
  internal and user errors through it.

The typed form had never been checked, so `check ./src` passed.

## Fix

Errors become values; the frame that owns the handler throws them.
- **The loader.** It reads and parses under local capturing handlers
  (`_read_source_capturing_error`, `_parse_capturing_error`), exactly like
  `_eval_module_exprs_capturing_error`. It returns the error as `LoadModuleResult.module_error`,
  so the import site rethrows it through its own `exn`. `mm_changed_definitions` returns no
  diff on a read or parse error, and the watch round falls back to a file-level reload, which
  reports it.
- **Codegen.** `codegen_fatal` and `codegen_user_error` record the first error in a plain slot
  (`g_codegen_error : Option(AnyError)`, not control-bound). The emitters already returned right
  after reporting. `compile_module` throws the recorded error through its own `exn` after each
  emission phase (`raise_codegen_error`), and clears a stale one at entry.

## Tests

`check ./src` (the rule rejects both old slots), the fixpoint, and the CLI goldens that
exercise `codegen_user_error` (the await-position cases) and a missing import (the loader's
error path).
