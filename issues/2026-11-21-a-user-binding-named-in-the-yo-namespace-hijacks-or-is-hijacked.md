# A user binding named in the `__yo_` namespace hijacks a builtin or is hijacked by one

**Severity:** S2 — a safe file can define `__yo_errno :: (fn() -> i64)(i64(7))` and every call to it silently runs the compiler's `errno` read instead, with no diagnostic; the same holds for parameters and locals named like a dispatched builtin.

Found 2026-11-21 by the VERDICTS-72 probes (`p2`, `p14`, `p11`, `p9`), on the v0.2.78 seed and on develop. VERDICTS-72 rule (a) (E0407, v0.2.80) closed the FFI-member form of this
(`issues/fixed/2026-11-21-a-user-extern-member-named-like-a-compiler-builtin-is-silently-shadowed.md`);
every other binder is still open.

## Reproducer

```yo
{ println } :: import("std/fmt");
__yo_errno :: (fn() -> i64)(i64(7));
main :: (fn() -> unit)({
  a := __yo_errno();
  println(&a);
});
export(main);
```

`yo check` accepts it and the program prints `0`, not `7`: codegen matches `__yo_errno` by name and emits `errno`.

| Probe | Program (no pragma) | Result |
| --- | --- | --- |
| p2 | `__yo_incr_rc :: (fn(x : i32) -> i32)(x + i32(1));` then `y := __yo_incr_rc(i32(1))` | accepted; `y` is the builtin's `unit`, prints `()` |
| p14 | `__yo_errno :: (fn() -> i64)(i64(7));` then `__yo_errno()` | accepted, prints `0` |
| p11 | a parameter `__yo_incr_rc : (fn(x : i32) -> i32)`, called | the builtin runs; E0604 on the closure |
| p9 | `__yo_incr_rc := i32(3)`, `(__yo_decr_rc : i32) = i32(4)`, a closure parameter `__yo_rc_own` | accepted |

## Root cause

The evaluator dispatches `__yo_*` builtins by the callee's spelling (`src/evaluator/exprs/dispatch.yo`) before it looks at any binding, and codegen matches others by name (`__yo_errno`), so a user binding of such a name never runs. No binder site rejects the prefix: `is_reserved_builtin_binding_name` (`src/token.yo`) lists only `__yo_cell` and `__yo_atomic_cell` of the namespace.

## Fix (planned, v0.2.81): VERDICTS-72 rule (b)

Reject with E0407 (the code rule (a) registered, the same `may_bind_yo_namespace_name` std-tree test in `src/evaluator/memory-safety.yo`) every user-written binder whose name starts with `__yo_`: `::`, `:=`, `(x : T) = …`, parameters (closure parameters included), pattern and destructuring bindings, import renames. Uses stay legal (calling a builtin by name without declaring it).

What it needs first: a written-versus-minted fact on the token. The compiler mints `__yo_tpl_N` (the parser's template-string lowering, `src/parser.yo`), `__yo_self`, `__yo_pat_s` (`src/evaluator/exprs/pattern-compile.yo`) and `__yo_contract_result` (`src/evaluator/builtins/contracts.yo`) into USER modules with the user's module path, so the module path cannot tell them apart; an allowlist of minted names is ruled out by the verdict. The fact is a flag on the synthetic token constructors (`_template_syn_tok` and its siblings), which touches `TokenData`, a struct the evaluator keeps about 1.9 M of on `check src/main.yo` (`src/token.yo`), so it is its own change.

The sweep that lands with it: the destructuring imports of `__yo_*` names from `std/sys/externs` outside std (`tests/async/sm-ownership.test.yo`, `tests/async/sm-protocol.test.yo`, `tests/parallelism-soundness.test.yo`, `tests/cli-cases/raw-extern-future-sync-await-releases/fixture/src/main.yo`, `scripts/bench/io-bench.yo`, `scripts/bench/io-budget.yo`) switch to a module value (`externs.__yo_async_send_start(…)` is a use, not a binding), and `tests/codegen-bootstrap/iter-structs-identical-layout.yo` renames its `__yo_batch_env` binding.

## Test

To add with the fix: p2, p14, p11, a local `:=`, a pattern binding and an import rename rejected with E0407 in a user file; the canaries (a template string, a struct-pattern `match`, an `ensures` contract, a `self` method) still pass in a user file.
