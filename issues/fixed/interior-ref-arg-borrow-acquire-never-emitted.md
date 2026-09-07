# Interior `inout` args never acquire the runtime borrow flag — the documented backstop is dead code (live UAF)

**Status: FIXED (2026-09-07, this PR).** Found the same day during the
`inout` local-binding audit (`plans/INOUT_LOCAL_BINDINGS_AUDIT.md` §1.3).
Reproduced with `yo 0.2.27` against `develop` at `c787fdc45`.

## Symptom

`docs/en-US/FLOWABILITY.md` ("Runtime backstop") and
`issues/fixed/ref-arg-heap-escape-to-global-residual.md` state that the one
shape the static ref-argument place rule cannot see — a container that
escaped into a *global* heap structure before an element of it is passed as
an `inout` argument — is closed by the `borrow_count` flag in the RC header:
the callee's growth method panics deterministically instead of corrupting
memory.

It does not. The reproducer
(`issues/repros/interior-ref-arg-borrow-acquire-never-emitted.yo`) compiles
without diagnostics and:

```
$ yo compile issues/repros/interior-ref-arg-borrow-acquire-never-emitted.yo --optimize 2 -o /tmp/r && /tmp/r
write landed (at .../std/assert.yo:25:17)          # assert FAILED: the write went into a freed buffer
rc=134
$ DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib /tmp/r
rc=139                                              # SEGV under GuardMalloc
```

No `container operation while an interior reference ... borrows from it`
panic is ever printed.

## Root cause — a porting gap

The three halves of the backstop are:

1. `uint16_t borrow_count` in every RC header, zero-initialised
   (`src/codegen/types/generation.yo:785,809,836`,
   `src/codegen/functions/constructors.yo:94,582`) — **present**.
2. `__yo_borrow_assert_unborrowed((void*)self)` auto-emitted before every
   `__yo_realloc` / `__yo_free` inside an RC-object method
   (`_maybe_emit_auto_borrow_assert`, `src/codegen/exprs/other_fn_call.yo:393-403`,
   sole call site `:1884`) — **present**; the emitted C of the reproducer
   contains five such asserts inside the `ArrayList` methods.
3. `__yo_borrow_acquire(container)` / `__yo_borrow_release(container)`
   bracketing every call whose `inout` argument is an index-trait place
   (`xs(i)`) — **defined but never called**. `_emit_borrow_acquires`
   (`other_fn_call.yo:330-359`), `_emit_borrow_releases` (`:360-391`) and
   `_get_interior_ref_container_code` (`:302-329`) are exported at `:2353`
   and have no caller anywhere under `src/`.

The retired TypeScript compiler called them at three sites in
`src/codegen/exprs/other-fn-call.ts` (tag `src-attic-final`, lines 1403/1423
for unit-returning calls, 1528/1556 for value-returning calls, 2286-2317 for
the closure-call path), each acquiring before the emitted call and releasing
immediately after it, *before* the deferred drops and the
`__yo_effect_escaped` check so the release also runs when the callee unwound.
The yo-self port of `generate_other_function_call` carries the helpers but
dropped the three call sites. Since `borrow_count` is therefore never
non-zero, the asserts in (2) can never fire.

Emitted C for `bump(xs(usize(0)))` today (no acquire/release around it):

```c
yo_id_9540((int32_t*)(yo_id_4347_..._index_usize(&xs, 0ULL)));
```

## Why it matters

The static rule (`require_valid_ref_argument_places`,
`src/types/flowability.yo:857-981`) is documented as *relying* on this
backstop for the global-escape residual; with the backstop dead, that
residual is a silent use-after-free reachable from safe code (no
`pragma(Pragma.AllowUnsafe)` in the reproducer). The same primitives are also
the foundation any `inout` local-binding / borrowed-`for` design would build
on (see the audit), so they need to be wired and tested first.

## Fix (landed)

`src/codegen/exprs/other_fn_call.yo`: `_emit_borrow_acquires` now runs
immediately before, and `_emit_borrow_releases` immediately after, the
emitted call line at every statement-emitting exit — the direct-call unit and
temp-var exits, the function-pointer unit and temp-var exits, and both
method-dispatch paths' unit and temp-var exits. The release sits BEFORE
`generate_deferred_drop_expressions` and BEFORE the `__yo_effect_escaped`
early-return check, so an unwinding callee still releases (the TS placement).
The inline-expression exits (no temp var) cannot emit statements and stay
unchanged, as in TS.

Verification (stage-1 binary built from this tree):

- the reproducer's emitted C now reads
  `__yo_borrow_acquire((void*)(xs)); <call>; __yo_borrow_release((void*)(xs));`
  and running it prints
  `panic: container operation while an interior reference (a 'ref' into an element/field) borrows from it`
  (rc=134) instead of asserting on a freed buffer;
- `tests/cli-cases/inout-interior-borrow-growth-panics` pins that panic
  (recorded with the fixed binary; a `build run` case with
  `stdout_keep_match`);
- `tests/ref_field_borrow.test.yo` gains the two release-side tests
  (normal return, effect unwind through the call site) — both would panic on
  the following `push` if a release were missing.

## Original fix sketch

- Call `_emit_borrow_acquires` before, and `_emit_borrow_releases` right
  after, the emitted call at the direct-call path (`other_fn_call.yo:~1865`,
  after `_apply_ref_amp`) and the method-call path (`:~1267`), mirroring the
  TS placement: release before deferred drops and before the
  `__yo_effect_escaped` early-return so an unwinding callee still releases.
  Check the async state-machine call path too (the TS closure-call site at
  attic line 2286 has a yo-self twin).
- `runtime_param_is_ref` must be the per-runtime-parameter `param_is_ref`
  list already computed for `_apply_ref_amp`; `_get_interior_ref_container_code`
  keys on `ExprInfo.index_trait_ptr_type`, which the evaluator sets for
  index places.
- Regression test: the `yo test` runner has no expected-panic assertion
  (no `expect_panic` anywhere in `src/` or `tests/`), so the panicking shape
  belongs in `tests/cli-cases/` via `scripts/cli-diff-test.sh`, which records
  rc + stdout (golden: non-zero rc and the panic text). In
  `tests/ref_field_borrow.test.yo` add the positive halves: a read-only
  element-`inout` call (`to_string(xs(i))`) followed by a `push` still runs
  (release happened), and an effect handler that `unwind`s out of the
  borrowed call followed by a `push` still runs (release is unwind-safe).
- Verify by-hand: `grep -c "__yo_borrow_acquire((void" <emitted.c>` must be
  non-zero for the reproducer, and the reproducer must print the panic and
  exit non-zero instead of asserting.

## Related

- `issues/fixed/ref-arg-heap-escape-to-global-residual.md` — the design of
  the backstop; its status line ("FIXED ... runtime borrow-flag backstop")
  is true for the TS compiler only and should be cross-referenced to this
  issue.
- `docs/en-US/FLOWABILITY.md` / `docs/zh-CN/FLOWABILITY.md` — "Runtime
  backstop" paragraph describes behaviour the shipped compiler does not have.
