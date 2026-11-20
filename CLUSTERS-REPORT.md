# Cluster lane report — the audit A-rows (v0.2.80 opening set)

Branch `v0279/clusters-r` (pushed as `v0279/clusters`), based on develop `686350960` (post-redfix,
post-AstExpr-retype). One commit per row. All verdicts below were re-verified on the final fmt'd tree
with the stage-1 binary built from it (`yo-out/x86_64-pc-windows-msvc/bin/yo-r4.exe`, seed v0.2.78,
`--cc clang`); the same flips were first established on the pre-retype base (`yo-b18.exe`) and on the
pre-fmt rebased tree (`yo-r1.exe`).

| Row | Verdict | Mechanism | Test added | Issue-doc disposition |
| --- | --- | --- | --- | --- |
| A3 (the `&mut`-binding-matched-bare half) | **FIXED** (VERDICTS-71 rule (c), replacing the first wall) | Each place binding of a `&mut` match is an exclusive local borrow of the scrutinee's place, derived from the local borrow it is reached from, in either spelling (`src/evaluator/exprs/match.yo`). The re-point's name is no access of `cur`, and `local_borrow_require_no_live_derived` skips the binding the re-point goes through (and, when not mentioned after the right-hand side, the bindings it derives from). The earlier E0910 wall closed nothing, because `match(&mut r.*, …)` was the same unchecked program. | `tests/origins/unsound/a3-*.yo`: E0911 rows p3/q5/q7/r6/m04/m20, each bare and spelled, plus r2; accepted walk rows | Moved to `issues/fixed/` |
| A5 | **FIXED** | A reference VALUE in an argument position is typed at its POINTEE (the read rule), so `_origin_of_into`'s R-NONE returned ∅ before R-CALL ran. R-NONE now continues for a call whose callee's result is a reference (or carries an origin / holds binders); the T9 branch also falls through for computed references and calls of closure values. `wrap(first(&xs))` freezes `xs` → E0911 at `xs = …`. | `a5-composite-result-over-nested-call.yo`, `a5-holder-ctor-over-nested-call.yo` (E0911), `-pos.yo` | FIXED in v0.2.79; moved to `issues/fixed/` |
| A6 (rule G, item 1) | **FIXED** | `_d3_judge_local_borrows` no longer gates a `&mut` argument's two-phase activation on the callee's mutation summary — every pending entry is a `&mut`-slot argument (both recorders run on `fn_param_mut_ref_flags`), each is now a Write at activation + `require_writable`. The mask still feeds E0908 and D3. VERDICTS-57 §3.4's census found no sweep targets: `check ./std` 171/171, `check ./src` clean. | `a6-mut-arg-nonwriting-callee-live-loan.yo` (E0911); `v57-mut-self-nonwriting-live-loan-pos.yo` flipped from `accept` to E0911 | FIXED in v0.2.79; moved to `issues/fixed/` |
| A10 | **FIXED** | `return_check`'s parameter branch rejects a root at a parameter whose slot is not a reference — a by-value parameter's place is the callee's own frame — E0912 with the signature rule's message, whatever the result spells. | `a10-ret-byvalue-param-composite.yo`, `a10-ret-byvalue-param-self.yo` (E0912), `-pos.yo` | FIXED in v0.2.79; moved to `issues/fixed/` |
| A14 | **FIXED** | `_origin_carrying_roots_shallow`'s mode-2 receiver branch contributes `origin_of(receiver)` for a non-atom receiver (a temporary cursor / adapter chain), as a bound cursor's registered entries do. `a := (&xs).into_iter().next()` carries `{(xs, &)}` → E0911 at the reallocating push. | `a14-tmp-cursor-item-no-loan.yo`, `a14-tmp-user-cursor-item-no-loan.yo` (E0911), `-pos.yo` | FIXED in v0.2.79; moved to `issues/fixed/` |
| A17 | **FIXED** | `check_tuple_element_lends` (`src/evaluator/calls/function.yo`, called from `evaluate_tuple_value`) runs decision 28 over a tuple literal's elements: a later element may not move (`consumed_at_token`), overwrite or lend `&mut` a place an earlier element lends — E0910 with the tuple message. Two `&` lends pass. | `a17-tuple-lend-and-move-one-place.yo`, `a17-tuple-two-mut-lends-one-place.yo` (E0910), `-pos.yo` | FIXED in v0.2.79; moved to `issues/fixed/` |
| A23 (the inner-projection-call half) | **FIXED** | Same pointee-typing fix as A5: `mkx().get()`'s recorded type is `String`, R-NONE killed the walk before the R-TEMP push for the temporary receiver. R-NONE continues; the store rejects with E0911 naming the temporary. | `a23-holder-from-inner-projection-call.yo` (E0911) | FIXED in v0.2.79; moved to `issues/fixed/` |
| A56 | **FIXED** | Two gaps: the closure call's result froze nothing because its node is pointee-typed (R-NONE continuation covers the call and the atom-reference-binding case), and `_bind_projection_result` read a reference-binding root argument by its pointee type only — it now takes `origin_of` of one. `picked := pick(rx, ry)` borrows both lists → E0911. | `a56-local-closure-ref-result-second-arg.yo` (E0911), `-pos.yo` | FIXED in v0.2.79; moved to `issues/fixed/` |
| row 9 (the 2026-11-18 zip chain, coordinator-added) | **FIXED** | Three changes close it: the mode-2 non-atom receiver contribution (A14's fix, the receiver side), the R-NONE continuation for results that are references / carry origins / hold binders (A5's fix, the generic `IterZip(Self, J)` walk), and a declared-type fallback in `generic_result_binder_modes` for method calls so the `sink(other) : J` parameter the result holds is mode 1 — the `ys` argument's cursor now contributes its roots. Verified E0911 on the rebased tree. | `row9-zip-chain-inline-receiver.yo` (E0911) | FIXED; moved to `issues/fixed/` |

## Verification

All on the final fmt'd tree with the tree-built stage-1 `yo-r4.exe` (one earlier rebuild, r3, had a
one-line E0601 in new code that never reached a verdict; r4 is the binary every number below is from):

- Flip matrix, run with `yo-r4.exe`: A3 E0910 (the first wall; rule (c) later replaced it with E0911 rows), A5 E0911 ×2, A6 E0911, A10 E0912 ×2, A14 E0911 ×2,
  A17 E0910 ×2, A23 E0911, A56 E0911, row 9 E0911, and the flipped v57 positive E0911 — 14/14;
  every `-pos` control accepted (5/5).
- `yo check ./std --std-path ./std` = 171/171 (the first wall draft broke `std/log.yo:276`; the
  `variable_is_borrow_parameter` exclusion fixed it).
- `yo check ./src --std-path ./std` = 273/273.
- `yo test ./tests/origins/model-corpus.test.yo --std-path ./std --parallel 1` = 155/155.
- `yo fmt --check` clean on every changed `.yo` file (run with the tree binary; fmt rewrapped three
  files — `src/evaluator/utils.yo`, `src/evaluator/exprs/match.yo`, the row-9 test — after which the
  flip matrix, std, src-status quo below and the corpus were re-run green).
- No test in `tests/` names any changed identifier (`check_tuple_element_lends`,
  `generic_result_binder_modes`, `_origin_carrying_roots_shallow`, `_d3_judge_local_borrows`,
  `_bind_projection_result`): the changed-identifier gate selection is empty.
- A56 re-confirmed accepted-and-unsafe before the fix by an ASan run (heap-use-after-free, READ of size 4).
- Known measurement caveat, recorded for the future: `check` passing does NOT prove trial health —
  errors raised inside def-time trials are swallowed silently and only surface as broken specialization
  downstream. A poisoned intermediate artifact cache produced binaries with silently-dead trials during
  this work; every verdict above is from a clean-build binary.
- `check ./src` (273/273) ran immediately before the fmt rewrap; fmt is layout-only and the flip
  matrix, std check and corpus all re-ran green on the fmt'd tree afterwards.

## Notes for the PR

- The eight fixed/walled rows map to the audit's clusters 2 (A6), 3 (A3, A5, A10, A14, A17), 5 (A56),
  and 6 (A23). Row 9 is the coordinator-added 2026-11-18 zip-chain finding.
- A3 is fixed by VERDICTS-71 rule (c), which replaced the first E0910 wall. The doc is in `issues/fixed/`.
- The strictness-gap question the redfix audit lane flagged (a PARAMETER scrutinee contributes an empty
  held set by design, bypassing the O2/A29 subset discipline through a match) is the audit lane's to
  file in `issues/questions/`; this PR does not change that behavior.
- `B9`/`C14` needed no work here (coordinator-ruled non-blocking).
