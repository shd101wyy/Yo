# A closure's capture borrow lasts to the binding's scope end, not its last use

**Severity:** S2 — a valid program is rejected: a capture-list closure bound to a name (`{ &mut n }` or `{ &n }`)
holds its capture until the binding's scope ends, so `n` cannot be read after the closure's last call
(`E0910: the closure bump borrows n ... and the borrow lasts until bump's scope ends`). Sound (an over-freeze), and
bounded by the repair the diagnostic already prints: put the closure and its calls in a block.

Filed 2026-11-13 (VERDICTS-59 §3 decision 12) from the borrow-program generator's precision class (G-D, the
`slot:*/*/*/capture/*` programs): audit row **C14**, a post-VBD known issue (VERDICTS-58 decision 5). The decided
rule is last use (decisions 18, 35 and 38; `BORROW_CHECKER_COMPLETENESS.md` §2, R-CLOSURE-LIT); the as-built
behaviour is a leftover mechanism, not a design position.

## Reproducer

`issues/repros/2026-11-13-a-closures-capture-borrow-lasts-to-the-bindings-scope-end-not-its-last-use.yo` (expects
accept; rejected today):

```yo ignore
main :: (fn() -> unit)({
  mut(n) := i32(0);
  (mut(bump) : Impl(FnMut() -> unit)) = ({ &mut n }() => {
    n.* = (n.* + i32(1));
  });
  bump();
  bump();
  println(&n);
});
```

`…-block.yo` is the workaround (the closure and its calls in a block): accepted. The same shape with a local
borrow, `r := &mut n`, is accepted today, so two holders of one `&mut n` get different live ranges inside Yo.
rustc accepts the closure form.

## Root cause

Capture-list closures are tracked in their own side table (`g_capture_freezes`, `check_capture_freeze_access` in
`src/evaluator/utils.yo`), whose liveness test is "the holder is still in the environment and unconsumed", that is,
the scope end. Every other holder lives in `g_local_borrows` with a range from `local_borrow_range_of`.

## Fix: P4-0, post-VBD, not in v0.2.78 or v0.2.79

The first PR of P4 (post-VBD lane A, v0.2.80, owned by the `modes` lane's owner of the capture region):
a bound capture-list closure registers each `&`/`&mut` capture through `local_borrow_register` with
`local_borrow_range_of(…, to_scope_end : type_reaches_user_drop(capture record))`, and `_CaptureFreeze`,
`g_capture_freezes` and `check_capture_freeze_access` are deleted (VERDICTS-59 decision 11). It waits for clusters 2
and 7 and for the A6 closure rows to leave `tests/origins/gen-known.tsv`: the over-freeze shields A6's bodyless half,
A46 and A47 until then. E0910's text and help are not touched before it.

## Test

The G-C ledger row `corpus-closure-mut-capture-last-use` (kind `parity`) in `tests/origins/rust/DIVERGENCES.tsv`
records the divergence; the repro moves to `tests/origins/` with P4-0 together with the must-stay-rejected rows of
VERDICTS-59 decision 11.
