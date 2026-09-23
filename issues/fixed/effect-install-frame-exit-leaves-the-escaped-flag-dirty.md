# An effect install-frame exit leaves `__yo_effect_escaped` set (dirty flag rides to main)

**Status: FIXED (2026-09-23)** — surfaced by the safe-mode Phase 0a belt check
(`issues/fixed/effect-unwind-escaping-a-task-or-main-is-silent.md`); the belt was
deferred until this was fixed; both landed together.

## The behavior (measured 2026-09-22, CI battery on the 0a branch + a patched
batch binary locally)

A handler bound locally and invoked DIRECTLY at the install scope:

```rust
run_test :: (fn() -> unit)({
  (raise : Raise) = ((msg, msg2) -> { println(msg); unwind(()); });
  raise(`direct-call`, `No using parameter needed`);
  assert(false, "This line should not be reached");
});
run_test();
```

The unwind does exactly what the docs promise — `run_test` exits early, the
assert never runs — but the emitted escape path is:

```c
  __yo_effect_escaped = 0;
  int32_t tmp = ((int32_t (*)(...))raise)(...);
  if (__yo_effect_escaped) {
    /* drop locals */
    return;          // exits the install frame — flag left SET
  }
```

Nobody clears the flag afterwards (every later effect protocol resets it in
its own prologue, which launders the dirt in longer programs), so at `main`'s
exit the flag is still set. The Phase 0a belt (`if (__yo_effect_escaped) {
fprintf(stderr, ...); abort(); }` after `__yo_user_main`) correctly detected
this as a dirty-at-exit flag — and fired on four perfectly legitimate
`tests/algebraic_effects.test.yo` tests ("fn unwind called directly",
"zero-arg unwind exits unit function", "nested fn unwind inside resume
handler", "Mixed unwind and return in effect handler"). The belt was removed
in the same commit; it returns with this fix.

## Root cause

`_call_is_handler_installation`
(`src/codegen/exprs/other_fn_call.yo:927`) rule 1 classifies a direct call to
a locally-bound ctl handler as an INSTALLATION — in which case
`emit_effect_unwind_check` (`src/codegen/exprs/return.yo:1167`,
`is_handler_installation=true`) clears the flag and extracts the unwind value.
In the failing shape the call is classified as a propagation point instead
(flag left set, dummy return), so the install frame exits dirty. The
misclassification reproduces in the TEST-BATCH context (`yo test` inlines
test bodies into `__yo_user_main`, and the local `run_test` def +
`(raise : Raise) = ...` binding land in frames where rule 1's
`find_innermost_frame_with_given_variable` / `fidx > fdfl` check does not
match); the same shape outside a batch currently fails to transpile the
handler body entirely (abort-stub), which is why only batch-run tests
exercise it.

## Root cause — pinpointed 2026-09-22 via the #838 probe PR

The probe (draft PR #838) instrumented `_call_is_handler_installation` and ran
the full tier-1 battery. Result: **zero `[install-probe]` lines while the
`algebraic_effects` battery passed** — the direct local-handler calls
(`(raise : Raise) = lambda; raise(...)`) never route through
`_call_is_handler_installation` at all. That predicate is consulted only on
the method-dispatch and named-extern paths
(`src/codegen/exprs/other_fn_call.yo:1327/1444/2027`); the plain atom-callee
call path — `raise` is a local variable of ctl/fn type, the "cFuncName
direct-call path" that other_fn_call.yo:993 calls "the live corpus path" —
emits the post-call check **unconditionally in propagate form**
(`__yo_effect_escaped = 0; call; if (escaped) { drop locals; return; }` with
no clear), which is exactly the dirty-flag shape visible in the batch C.

So the fix is: in the atom-callee direct-call path, when the callee's value is
a locally-bound ctl handler (rule 1's own classification), emit the
install-form check (clear + extract the unwind value at the frame exit)
instead of the propagate form. The `#838` probe's dump (fdfl/fidx/frames/
begin) is in place to verify what the frame bookkeeping sees in the batch
context once the path is routed through the predicate.

## The fix (landed 2026-09-23, probed locally)

The probe's own assumption was half wrong — corrected by a YO_DEBUG_INSTALL
dump against the CURRENT tree: the predicate IS consulted for the failing
calls (the registered-callee path passes `ou_is_install`), and the Func
meta's `is_control` flag is TRUE on both the callee's call type and its
ExprInfo type. What failed was rule 1's FIRST conjunct: in the batch context
the callee atom's ExprInfo carries NO FuncVal (only its ctl-marked type), so
`is_control_fn(_func_val_id(v))` never ran and the fid-based frame search had
no id to search with.

Three pieces landed together:

1. **Rule 1 accepts a valueless ctl-typed callee** — `is_control` from the
   Func meta (the same flag `_call_may_unwind` reads) admits the callee, and
   a new `callee_name` parameter (the callee ATOM's token, passed by the
   registered-callee path) lets the binding search fall back to the NAME:
   a begin-block frame inside the current fn (`fidx > fdfl`) that binds the
   callee's name. Params bind at the declaration frame and stay excluded —
   propagation through handler params (the "Mixed"/"Struct-record" shapes)
   classifies exactly as before.
2. **The test-batch main is a boundary of last resort** — "Mixed unwind and
   return in effect handler" DELIBERATELY lets an unwind escape to top level
   (abort-this-test with no outer handler), so the batch main clears the flag
   after its dispatch the way task boundaries already do. The belt is
   emitted by `generate_main_wrapper` in two shapes keyed on the main's
   defining module containing `.yo_selftest_batch_`.
3. **The belt re-landed** on all three platform arms (POSIX/Windows/wasm)
   from the 0a commit, via the shared `belt_block` snippet.

Verified locally (deck box, nix clang, `YO_TEST_LEAK_VERDICT=0`):
algebraic_effects 77/77 with the belt armed; the non-batch direct-call shape
(a standalone program) now also transpiles and runs correctly — handler
prints, unwind exits main early, flag clean, rc 0 — closing the
"same shape outside a batch fails to transpile (abort-stub)" note above as a
side effect. The belt stays a tripwire for real programs: no legitimate
non-batch path is known to leave the flag set (the 0a analysis), and the
deliberate-escape idiom exists only in test batches.

When this lands, re-add the three post-`__yo_user_main` belt checks
(POSIX/Windows/wasm arms of `generate_main_wrapper`) from the 0a commit.
