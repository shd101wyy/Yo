# An unwind through a method call is not caught by the frame that installed the handler

**Severity:** S1 — a miscompilation of effect control flow: the frame that
installed the `ctl` handler does not catch its unwind. The leaked escape is
caught by the next installing frame further up the stack, even one for an
unrelated handler, which reads `__yo_unwind_value` as its own result type:
a wrong value, memory corruption, or a silent early exit. Only when no frame
above installs one does the process abort with `unhandled effect unwind
escaped to top level` (see "What a leaked escape does").

**Status:** fixed (2026-10-23, branch `fix/s1-unwind-through-method-call`). **Found:** 2026-10-23 while writing the regression test for
`issues/fixed/2026-10-23-an-early-return-in-a-derive-generated-body-skips-the-drop-of-a-value-local.md`.
Reproduced with the v0.2.68 seed on develop `56dd8253f`.

## Reproducer

`issues/repros/2026-10-23-an-unwind-through-a-method-call-is-not-caught-by-the-frame-that-installed-the-handler.yo`:
a `ctl` handler `raise` that does `unwind(i32(7))` is installed in
`via_trait`, then passed to a method called through its type,
`Q.make(i32(0), raise)`, whose body calls `raise()`. The control,
`via_plain_fn`, passes the same handler to a plain function.

```text
8
unhandled effect unwind escaped to top level
```

Expected: `8`, then `7`. The method can be a trait member (`impl(Q, Make(make : …))`)
or an inherent one (`impl(Q, make2 : …)`); both abort.

## Where it goes wrong

The emitted C of the installing frame shows it. After the plain-function call,
`via_plain_fn` catches the escape: it clears `__yo_effect_escaped` and returns
the value from `__yo_unwind_value`. After the method call, `via_trait` emits
the transitive form, `if (__yo_effect_escaped) { return (int32_t){0}; }`. That
form re-raises without catching, so the escape reaches `main`. The call
site's `is_handler_installation` argument to `emit_effect_unwind_check`
(`src/codegen/exprs/return.yo`) is false on the method-call path. The method
path's `*_is_install` flags are computed in `src/codegen/exprs/other_fn_call.yo`.

## Root cause

The scope release (`scope_release_body`, `src/expr_info.yo`) replaced the
env that codegen read with a husk. The env it kept belonged to a different
ExprInfo.

1. **What codegen reads.** The concrete method-dispatch arm of
   `generate_other_function_call` (the `cm_` path, taken for any
   `X.name(...)` callee resolved through a type id) built its
   handler-installation probe from the CALL's env:
   `new_expr_info(&ei.env, &cm_mft)`. `_call_is_handler_installation` then
   scans that env's frames for the begin-block frame that binds the handler
   argument (`raise`), and requires `fidx > function_declaration_frame_level`.
2. **What the release keeps.** After a body is evaluated, the scope release
   swaps each logged ExprInfo's env for a husk whose
   `function_declaration_frame_level` is `SCOPE_HUSK_MARK` (987654321).
   `_scope_keeps_env` exempts an info whose type or value installs a handler,
   and a call whose recorded method callee installs one. On a husk the
   frame test `fidx > 987654321` is never true, so the probe answered
   "propagate".
3. **Why the call's env was released.** A non-generic type-qualified call
   (`Q.make(...)`, trait or inherent) evaluates its callee `Q.make` to a
   compile-time FuncVal. The evaluator records `record_method_callee_value`
   for that arm only when the callee is a specialized generic. The receiver
   arm (`q.run(...)`) records the callee too. The call's own info has type
   `Q` and a runtime value and no recorded callee, so its env was released.
   The DOT callee's info (the FuncVal with a `ctl` parameter) was kept.

So the installing frame emitted the transitive
`if (__yo_effect_escaped) { return (int32_t){0}; }`, left the flag set, and
`main`'s belt aborted. The plain-call path (`ou_`) was unaffected because it
already builds the probe from the callee's ExprInfo. With
`YO_SCOPE_RELEASE=off` every failing shape passed, and `YO_SCOPE_RELEASE=shadow`
counted the read as `hard-released/install-param`. `yo check` never shows the
bug: it does not run codegen.

## What a leaked escape does

The transitive check leaves `__yo_effect_escaped` set and returns a zero
value, so every caller up the stack propagates the escape until one of them
is an installation point for SOME handler. That frame takes the escape as
its own: it clears the flag and `memcpy`s `__yo_unwind_value` into its own
result type. The abort above happens only when no such frame exists.

- **Wrong value.** `check` installs a handler `outer` (unwinding `i32(-1)`)
  and calls `probe(f, outer)`, which returns `f() + 100`; `f` is
  `via_inherent`, whose own handler unwinds `i32(2)` through
  `Q.make2(i32(0), raise)`. Before the fix `check` returned `2` (the leaked
  value: neither `outer` nor the `+ 100` ran); after it, `102`.
- **Memory corruption.** The same leak under a `check` whose handler unwinds
  a `String`: built with `--sanitize address --allocator system`, the base
  compiler's program dies with `AddressSanitizer: SEGV on unknown address
  0x000000000002 ... WRITE memory access` (the `i32` 2 read as a `String`);
  the fixed one prints `normal`.
- **A silent no-op in the compiler itself.** `_raw_parse_or_none`
  (`src/main.yo`, the borrow-spelling migration) installs `local_exn` and
  calls `Parser.new(src, file, local_exn)`, which throws on a lexer error
  (`tokenize_shared`). That throw leaked out of the migration loop to an
  outer installing frame, so `yo fix <dir> --migrate borrow-spelling` exited
  rc=0 when any file had a lexer error: no "does not parse" line, no summary,
  and every file after it skipped. A parse error thrown from `p.get_program(local_exn)`, a
  receiver call, was already caught. The fixed `yo` carries the fix only once
  it is compiled by a compiler that has it (a stage-2 binary; the released
  bundle is one), so a stage-1 built by the v0.2.68 seed still shows the
  no-op.

Shapes that failed: a trait method `Q.make(k, raise)`; an inherent
`Q.make2(k, raise)`; a unit-returning `Q.poke(raise)`; the inline
expression `Q.make2(k, raise).n`; an `Exception` parameter
`Q.parse(k, exn)`; `P.via_self(raise)`, whose body forwards through
`Self.make(...)`. Shapes that passed: a receiver call `q.run(raise)`, a
generic `G(i32).gmake(raise)`, a module-qualified `M.f(k, raise)`, and a
plain call.

## Fix

`src/codegen/exprs/other_fn_call.yo`, `cm_` arm: the installation probe
reads the DOT callee's ExprInfo env when the callee has one (keyed on the
callee's id for the scope-release shadow note). It falls back to the call's
env when the callee has none: a receiver call's dot has no info, and its call
env is kept through the recorded method callee. This mirrors the plain-call
path, which passes the callee's `func_ei`. All three `cm_` exits (projection
spill, unit, temp) share `cm_is_install`. The `rm_` arm needs no change,
because it only runs with a recorded callee, which `_scope_keeps_env` keeps.

The broader alternative was to record the method callee in the evaluator for
every `BF_DOT` FuncVal callee, so that the release keeps the call env. It was
not taken: it also moves type-qualified calls off codegen's registry
lookup, a larger emit change.

After the fix, `YO_SCOPE_RELEASE=shadow` on the shapes program reports only
`hard-kept/install-*` reads.

## Regression test

`tests/algebraic_effects.test.yo`, "an unwind through a type-qualified method
call is caught by the installing frame". It covers the six failing shapes
and three controls: receiver, generic and plain. `yo test` clears an escaped
unwind at the batch boundary, so a test body cannot see the escape directly.
Each case therefore runs under `_um_check`, which installs an outer handler
and returns `f() + 100`. A leaked escape is caught there as `_um_check`'s own
result, so a failing shape yields its leaked value (1..9) instead of
101..109. The test fails with the v0.2.68 seed (exit 6) and passes with the
fix. The
batch-boundary clearing is raised in
`issues/questions/2026-10-23-should-a-test-whose-unwind-escaped-the-body-fail.md`.
