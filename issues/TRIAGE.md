# `issues/` triage index — open docs, categorised

**Generated** by `scripts/gen-issue-triage.py` over the 210 open docs in
`issues/` root. A NAVIGATION aid, not a source of truth: each doc stays
authoritative about itself. Regenerate rather than hand-edit.

## How to read this

Three things are worth knowing before trusting any row.

1. **A doc's own `Status:` header is a claim, not a verdict.** The 2026-09-14
   pass closed 20 docs whose headers already said FIXED and which had been
   counted as open for months — each verified against the tree first. Treat the
   Status column as "what the doc says about itself".

2. **A repro that exits 0 has not necessarily passed.** Most repros here PRINT
   evidence and exit 0 regardless, so the exit code says the program ran, not
   that the bug is gone. The `Repro` column means only that a reproducer exists.
   Rows under **Confirmed still reproducing** are the ones whose OUTPUT was read.

3. **An expected-value table inside a doc is also a claim.** Two were wrong on
   2026-09-14 — a weekday row, and a "largest valid code point". Derive
   expectations independently, from a spec or a second algorithm, before pinning
   them in a regression test; otherwise red-then-green certifies a wrong answer.

## Counts by area

| Area | Open docs | Has repro |
| --- | ---: | ---: |
| CI/Release/Build | 13 | 0 |
| Async / effects | 32 | 11 |
| Codegen / emitted C | 23 | 4 |
| Evaluator / types | 39 | 8 |
| Std library | 63 | 16 |
| Tooling (fmt/doc/lsp) | 16 | 2 |
| Self-hosting legacy | 19 | 2 |
| Vendor (markdown_yo) | 3 | 0 |
| Other | 2 | 1 |
| **Total** | **210** | **44** |

## Cross-cutting buckets

### Confirmed still reproducing (output read, 2026-09-14)

Ready to work on — the defect was observed, not inferred.

- [`stddoc-coll-imm-vec-dedup-leaks-rc-elements.md`](./stddoc-coll-imm-vec-dedup-leaks-rc-elements.md) — `disposed: 0 (expected 3)`
- [`stddoc-io-arg-parser-help-is-an-error-and-errors-are-strings.md`](./stddoc-io-arg-parser-help-is-an-error-and-errors-are-strings.md) — both arms are `.Err(String)`; nothing distinguishes help from error
- [`stddoc-io-arg-parser-positionals-are-never-required.md`](./stddoc-io-arg-parser-positionals-are-never-required.md) — a missing required arg still parses `Ok`
- [`stddoc-io-json-parse-string-accepts-raw-control-bytes.md`](./stddoc-io-json-parse-string-accepts-raw-control-bytes.md) — raw control bytes accepted inside a string

### Verified still open, by reading the current source

Adjudicated by code reading rather than by running a reproducer — the
defect the doc describes is still present, so these are safe to pick up.

- [`stringerror-indexoutofbounds-is-declared-but-no-string-api-can-return-it.md`](./stringerror-indexoutofbounds-is-declared-but-no-string-api-can-return-it.md) — the variant is declared at std/string/string.yo:68 with no producer in the module
- [`stddoc-str-string-builder-clear-drops-capacity.md`](./stddoc-str-string-builder-clear-drops-capacity.md) — `clear` still does `self._buf = ArrayList(u8).new()`, discarding the buffer; ArrayList.clear retains capacity and is the one-line fix
- [`float-to-string-is-platform-dependent-for-non-finite-values.md`](./float-to-string-is-platform-dependent-for-non-finite-values.md) — std/fmt/to_string.yo still routes non-finite through %g and says so in its own module doc
- [`make-sockaddr-ignores-inet-pton-failure-and-returns-the-wildcard-address.md`](./make-sockaddr-ignores-inet-pton-failure-and-returns-the-wildcard-address.md) — std/sys/tcp.yo:188 still documents the failure as unreported
- [`bench-with-zero-iterations-returns-min-ns-greater-than-max-ns.md`](./bench-with-zero-iterations-returns-min-ns-greater-than-max-ns.md) — min_ns still seeded to i64::MAX with no zero-iteration guard; bench_auto can never pass 0, so a guard is safe
- [`derive-body-field-name-collides-with-a-builtin-type.md`](./derive-body-field-name-collides-with-a-builtin-type.md) — still fails: derive body renders a field named `unit` as the builtin type

### Retirement candidates — subject no longer exists

The TypeScript compiler was deleted in P2.5. A doc whose SUBJECT is that
compiler, or whose content is a TS-vs-self divergence, cannot be acted on.


### Duplication — six of the docs once counted as open were not

Two distinct mechanisms, both invisible to a "does the cited path resolve"
check, and both found on 2026-09-14:

1. **Same name, two directories** (3 docs). A fixing commit COPIED instead of
   MOVING, leaving a stale OPEN snapshot in root beside the FIXED copy.
   `scripts/check-issue-refs.sh` now asserts this cannot happen.
2. **Different name, same defect** (3 pairs: IPv6 RFC 5952, the release-gate
   fast path, IPv4 parse / UdpSocket.send). Fix titles are written from the
   FIXER's point of view — past tense, often consolidating two defects into one
   file — while the original is the REPORTER's, present tense, one defect each.
   No filename check sees that; a title-similarity scan of open docs against
   `fixed/` and `retired/` does, and finding one is usually a sign the code
   already contains the prescribed fix, so READ THE SOURCE before implementing
   any "suggested fix".


### Reference integrity

`scripts/check-issue-refs.sh` asserts every cited `issues/**` path resolves.
Run it on the MERGE RESULT, not on a branch: a concurrent move reads as a
stale reference there, and 'repairing' it reverts someone else's work.

### Largest docs (usually clusters, not single defects)

- [`yo-self-async-emission-cluster.md`](./yo-self-async-emission-cluster.md) — 40 KB
- [`borrowed-arg-invalidated-by-aliased-container-mutation.md`](./borrowed-arg-invalidated-by-aliased-container-mutation.md) — 27 KB
- [`a-bodyless-http-response-is-not-read-until-the-deadline.md`](./a-bodyless-http-response-is-not-read-until-the-deadline.md) — 17 KB
- [`calling-an-io-param-closure-in-a-generic-fn-keeps-an-unresolved-somet.md`](./calling-an-io-param-closure-in-a-generic-fn-keeps-an-unresolved-somet.md) — 17 KB
- [`yo-self-compile-performance-rc-string-eq.md`](./yo-self-compile-performance-rc-string-eq.md) — 16 KB
- [`yo-self-collections-batch-residuals.md`](./yo-self-collections-batch-residuals.md) — 16 KB
- [`d6-schannel-hangs-the-windows-test-legs-for-four-hours.md`](./d6-schannel-hangs-the-windows-test-legs-for-four-hours.md) — 12 KB
- [`err-expr-id-0-aliases-the-prelude-in-compiles-shared-exprinfo-table.md`](./err-expr-id-0-aliases-the-prelude-in-compiles-shared-exprinfo-table.md) — 12 KB

---

## By area


### CI/Release/Build (13)

| Doc | Status (self-reported) | Repro |
| --- | --- | --- |
| [`build-option-value-cannot-feed-an-artifact-field.md`](./build-option-value-cannot-feed-an-artifact-field.md) | OPEN (found 2026-09-12) | — |
| [`build-release-small-is-identical-to-release-safe.md`](./build-release-small-is-identical-to-release-safe.md) | OPEN | — |
| [`d6-schannel-hangs-the-windows-test-legs-for-four-hours.md`](./d6-schannel-hangs-the-windows-test-legs-for-four-hours.md) | — | — |
| [`emscripten-heap-is-fixed-at-16mb-so-thread-heavy-programs-abort.md`](./emscripten-heap-is-fixed-at-16mb-so-thread-heavy-programs-abort.md) | OPEN | — |
| [`http-limits-test-depends-on-httpbin-org-inside-a-required-gate.md`](./http-limits-test-depends-on-httpbin-org-inside-a-required-gate.md) | — | — |
| [`leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md`](./leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md) | OPEN | — |
| [`manifest-package-yo-msrv-field-is-parsed-but-never-enforced.md`](./manifest-package-yo-msrv-field-is-parsed-but-never-enforced.md) | OPEN | — |
| [`release-gate-accepts-a-docs-only-fast-path-success.md`](./release-gate-accepts-a-docs-only-fast-path-success.md) | open (found 2026-09-10 while cutting v0 | — |
| [`seed-early-return-drops-later-local-through-shadowing-pattern-name.md`](./seed-early-return-drops-later-local-through-shadowing-pattern-name.md) | — | — |
| [`v0.2.23-seed-build-lottery-corrupts-shifted-trees.md`](./v0.2.23-seed-build-lottery-corrupts-shifted-trees.md) | — | — |
| [`version-install-cross-device-link.md`](./version-install-cross-device-link.md) | — | — |
| [`windows-images-lost-libasan.md`](./windows-images-lost-libasan.md) | OPEN (CI workaround landed with the module-gl | — |
| [`yo-lock-records-the-annotated-tag-object-not-the-commit.md`](./yo-lock-records-the-annotated-tag-object-not-the-commit.md) | OPEN — found 2026-09-14 while re-pinning `mar | — |

### Async / effects (32)

| Doc | Status (self-reported) | Repro |
| --- | --- | --- |
| [`a-bodyless-http-response-is-not-read-until-the-deadline.md`](./a-bodyless-http-response-is-not-read-until-the-deadline.md) | OPEN — an inner | — |
| [`a-captured-closure-is-judged-by-its-capture-struct-so-a-send-closure-is-rejected.md`](./a-captured-closure-is-judged-by-its-capture-struct-so-a-send-closure-is-rejected.md) | OPEN | — |
| [`a-closure-typed-slot-never-releases-its-captures.md`](./a-closure-typed-slot-never-releases-its-captures.md) | PARTIALLY FIXED 2026-09-12 | yes |
| [`a-ref-value-passed-to-an-async-future-is-never-released.md`](./a-ref-value-passed-to-an-async-future-is-never-released.md) | — | yes |
| [`a-while-in-a-match-arm-with-spawns-still-runs-zero-iterations.md`](./a-while-in-a-match-arm-with-spawns-still-runs-zero-iterations.md) | OPEN — a SECOND defect in the same family, NO | yes |
| [`async-abort-dispose-double-drops-moved-enum-payload.md`](./async-abort-dispose-double-drops-moved-enum-payload.md) | — | — |
| [`async-await-nested-if-lost-continuation.md`](./async-await-nested-if-lost-continuation.md) | — | — |
| [`async-capture-mode-argument-rendering-cluster.md`](./async-capture-mode-argument-rendering-cluster.md) | — | — |
| [`async-cond-dispatch-skips-chained-sibling-arm.md`](./async-cond-dispatch-skips-chained-sibling-arm.md) | FIXED in the C33 change — `src/codegen/async/ | yes |
| [`async-cond-value-with-await-arm-inside-while-yields-zero.md`](./async-cond-value-with-await-arm-inside-while-yields-zero.md) | — | — |
| [`async-cond-value-with-throwing-arm-after-await-undeclared-temp.md`](./async-cond-value-with-throwing-arm-after-await-undeclared-temp.md) | — | — |
| [`async-effect-setter-emits-a-raw-non-ascii-identifier-as-a-c-member-name.md`](./async-effect-setter-emits-a-raw-non-ascii-identifier-as-a-c-member-name.md) | — | — |
| [`async-nested-cond-await-duplicate-while-labels.md`](./async-nested-cond-await-duplicate-while-labels.md) | — | — |
| [`async-postwhile-multiple-await-ifs.md`](./async-postwhile-multiple-await-ifs.md) | OPEN — std uses ONE post-cond awaiting `if` | — |
| [`async-tail-match-return-hangs-state-machine.md`](./async-tail-match-return-hangs-state-machine.md) | OPEN — std avoids the shape (the | — |
| [`closure-argument-inside-an-io-async-body-loses-the-future-result-type.md`](./closure-argument-inside-an-io-async-body-loses-the-future-result-type.md) | — | yes |
| [`command-stdin-windows-pipe-write-blocks-the-event-loop.md`](./command-stdin-windows-pipe-write-blocks-the-event-loop.md) | — | — |
| [`impl-fn-param-captured-by-an-async-block-is-not-in-the-capture-struct.md`](./impl-fn-param-captured-by-an-async-block-is-not-in-the-capture-struct.md) | open | yes |
| [`impl-method-self-receiver-hollows-forwarded-spawn-closures.md`](./impl-method-self-receiver-hollows-forwarded-spawn-closures.md) | OPEN — worked around in `std/thread | yes |
| [`io-async-sync-path-returns-a-c-comment-and-orphans-its-future-typedef.md`](./io-async-sync-path-returns-a-c-comment-and-orphans-its-future-typedef.md) | OPEN | — |
| [`io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await.md`](./io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await.md) | — | yes |
| [`io-await-on-a-join-handle-is-reported-as-an-internal-compiler-error.md`](./io-await-on-a-join-handle-is-reported-as-an-internal-compiler-error.md) | — | yes |
| [`pending-io-future-local-drop-uaf.md`](./pending-io-future-local-drop-uaf.md) | OPEN — analysis-verified hazard, not | — |
| [`spawn-blocking-degrades-to-inline-on-a-threadless-target.md`](./spawn-blocking-degrades-to-inline-on-a-threadless-target.md) | OPEN — the behaviour is deliberate and | — |
| [`spawn-wrapper-forwarded-io-crosses-specializations.md`](./spawn-wrapper-forwarded-io-crosses-specializations.md) | OPEN — blocks a std-side wrapper around a use | yes |
| [`sync-main-awaits-propagate-errors-through-a-null-exn.md`](./sync-main-awaits-propagate-errors-through-a-null-exn.md) | — | — |
| [`unwind-from-a-handler-installed-inside-io-async-exits-main-with-rc-0.md`](./unwind-from-a-handler-installed-inside-io-async-exits-main-with-rc-0.md) | — | yes |
| [`windows-1ms-deadline-race-loses-since-cancellation-landing.md`](./windows-1ms-deadline-race-loses-since-cancellation-landing.md) | — | — |
| [`windows-async-io-runtime-audit.md`](./windows-async-io-runtime-audit.md) | — | — |
| [`with-lock-and-with-permit-cannot-see-an-unwind.md`](./with-lock-and-with-permit-cannot-see-an-unwind.md) | OPEN — doc/API accuracy, not a defect | — |
| [`yield-now-costs-a-millisecond-per-turn-inside-a-test-batch.md`](./yield-now-costs-a-millisecond-per-turn-inside-a-test-batch.md) | OPEN — a PERFORMANCE observation, not a corre | — |
| [`yield-resumption-order-diverges-on-macos-ci.md`](./yield-resumption-order-diverges-on-macos-ci.md) | — | — |

### Codegen / emitted C (23)

| Doc | Status (self-reported) | Repro |
| --- | --- | --- |
| [`a-box-over-an-impl-fn-is-emitted-as-two-c-structs.md`](./a-box-over-an-impl-fn-is-emitted-as-two-c-structs.md) | OPEN | — |
| [`address-of-a-parameter-in-a-generic-fn-emits-a-placeholder.md`](./address-of-a-parameter-in-a-generic-fn-emits-a-placeholder.md) | OPEN | — |
| [`asm-documented-target-and-register-validation-does-not-exist.md`](./asm-documented-target-and-register-validation-does-not-exist.md) | OPEN | — |
| [`assign-to-by-value-closure-param-under-generic-result-types-unit.md`](./assign-to-by-value-closure-param-under-generic-result-types-unit.md) | — | yes |
| [`bare-fn-type-param-accepts-a-closure-then-emits-invalid-c.md`](./bare-fn-type-param-accepts-a-closure-then-emits-invalid-c.md) | OPEN | yes |
| [`c-include-global-accepted-by-comptime-binding.md`](./c-include-global-accepted-by-comptime-binding.md) | PARTIALLY FIXED 2026-09-08 — the `::` half is | — |
| [`c-include-rvalue-macro-constant-cannot-be-addressed.md`](./c-include-rvalue-macro-constant-cannot-be-addressed.md) | OPEN | — |
| [`cinclude-int-comparison-fails-to-transpile.md`](./cinclude-int-comparison-fails-to-transpile.md) | — | — |
| [`comptime-str-passed-where-string-is-declared-emits-invalid-c.md`](./comptime-str-passed-where-string-is-declared-emits-invalid-c.md) | OPEN | — |
| [`dead-yo-stat-accessor-family-emitted-into-every-program.md`](./dead-yo-stat-accessor-family-emitted-into-every-program.md) | OPEN | — |
| [`derive-tostring-on-a-generic-struct-emits-invalid-c.md`](./derive-tostring-on-a-generic-struct-emits-invalid-c.md) | OPEN | yes |
| [`drop-bookkeeping-hangs-off-a-generator-return-value-that-is-empty-for-multi-line-drops.md`](./drop-bookkeeping-hangs-off-a-generator-return-value-that-is-empty-for-multi-line-drops.md) | OPEN for the two remaining sites | — |
| [`emitted-c-flipped-once-under-extreme-load-unexplained.md`](./emitted-c-flipped-once-under-extreme-load-unexplained.md) | — | — |
| [`emitted-c-hardcodes-linux-at-fdcwd.md`](./emitted-c-hardcodes-linux-at-fdcwd.md) | — | — |
| [`ftt-abort-stub-error-attribute-does-not-fire-above-optimize-0.md`](./ftt-abort-stub-error-attribute-does-not-fire-above-optimize-0.md) | — | — |
| [`ftt-stub-in-live-closure-falls-off-non-void-function.md`](./ftt-stub-in-live-closure-falls-off-non-void-function.md) | — | yes |
| [`match-arm-and-or-rhs-temp-drop-leaks-arm-scope.md`](./match-arm-and-or-rhs-temp-drop-leaks-arm-scope.md) | — | — |
| [`no-volatile-so-black-box-needs-inline-asm.md`](./no-volatile-so-black-box-needs-inline-asm.md) | OPEN — missing capability, not a defect | — |
| [`rc-value-copied-address-taken-and-returned-is-double-dropped.md`](./rc-value-copied-address-taken-and-returned-is-double-dropped.md) | OPEN | — |
| [`self-hosted-debug-emission-undeclared-temp.md`](./self-hosted-debug-emission-undeclared-temp.md) | — | — |
| [`swallowed-closure-spec-emits-wrong-typed-return-msvc-error.md`](./swallowed-closure-spec-emits-wrong-typed-return-msvc-error.md) | — | — |
| [`wasm-runtime-missing-six-statx-accessors-that-std-declares.md`](./wasm-runtime-missing-six-statx-accessors-that-std-declares.md) | OPEN | — |
| [`wasm-statx-nsec-accessors-return-int64-but-are-declared-u32.md`](./wasm-statx-nsec-accessors-return-int64-but-are-declared-u32.md) | OPEN | — |

### Evaluator / types (39)

| Doc | Status (self-reported) | Repro |
| --- | --- | --- |
| [`annotated-local-from-a-trait-constrained-receiver-loses-every-method.md`](./annotated-local-from-a-trait-constrained-receiver-loses-every-method.md) | — | — |
| [`anonymous-module-trial-swallows-a-top-level-derive.md`](./anonymous-module-trial-swallows-a-top-level-derive.md) | — | yes |
| [`arraylist-private-ptr-read-across-module-boundaries.md`](./arraylist-private-ptr-read-across-module-boundaries.md) | OPEN | — |
| [`assignment-to-call-expression-silently-accepted.md`](./assignment-to-call-expression-silently-accepted.md) | — | — |
| [`blanket-inherent-method-on-a-dyn-receiver-dispatches-through-the-vtable.md`](./blanket-inherent-method-on-a-dyn-receiver-dispatches-through-the-vtable.md) | OPEN | — |
| [`blanket-into-iter-is-not-an-intoiterator-impl.md`](./blanket-into-iter-is-not-an-intoiterator-impl.md) | OPEN | — |
| [`borrowed-arg-invalidated-by-aliased-container-mutation.md`](./borrowed-arg-invalidated-by-aliased-container-mutation.md) | — | — |
| [`builtin-name-shadows-user-definition.md`](./builtin-name-shadows-user-definition.md) | — | yes |
| [`calling-an-io-param-closure-in-a-generic-fn-keeps-an-unresolved-somet.md`](./calling-an-io-param-closure-in-a-generic-fn-keeps-an-unresolved-somet.md) | — | yes |
| [`comments-preceding-definitions-can-hollow-the-definition.md`](./comments-preceding-definitions-can-hollow-the-definition.md) | — | — |
| [`comptime-enum-payload-field-assignment-is-a-silent-no-op.md`](./comptime-enum-payload-field-assignment-is-a-silent-no-op.md) | — | — |
| [`comptime-float-negation-loses-the-sign-of-zero.md`](./comptime-float-negation-loses-the-sign-of-zero.md) | OPEN | — |
| [`comptime-str-method-result-does-not-convert-to-str-in-typed-binding.md`](./comptime-str-method-result-does-not-convert-to-str-in-typed-binding.md) | — | — |
| [`ctfe-memo-shared-struct-id-fast-path-smell.md`](./ctfe-memo-shared-struct-id-fast-path-smell.md) | OPEN as a hardening opportunity — | yes |
| [`derive-body-field-name-collides-with-a-builtin-type.md`](./derive-body-field-name-collides-with-a-builtin-type.md) | open (found 2026-09-09 while adding `Encoding | yes |
| [`derived-eq-ref-enum-self-payload-hollow-at-runtime.md`](./derived-eq-ref-enum-self-payload-hollow-at-runtime.md) | — | — |
| [`dyn-as-a-direct-downcast-argument-reports-got-option.md`](./dyn-as-a-direct-downcast-argument-reports-got-option.md) | OPEN | — |
| [`dyn-cannot-resolve-a-trait-method-that-comes-from-a-generic-impl.md`](./dyn-cannot-resolve-a-trait-method-that-comes-from-a-generic-impl.md) | OPEN | — |
| [`dyn-of-a-static-method-call-in-a-bare-tail-fn-body-loses-the-payload-type.md`](./dyn-of-a-static-method-call-in-a-bare-tail-fn-body-loses-the-payload-type.md) | OPEN | — |
| [`dyn-of-an-existing-dyn-value-emits-an-error-comment-into-the-c.md`](./dyn-of-an-existing-dyn-value-emits-an-error-comment-into-the-c.md) | OPEN | — |
| [`dyn-selftrait-payload-never-matches-the-named-trait.md`](./dyn-selftrait-payload-never-matches-the-named-trait.md) | OPEN | — |
| [`env-sharing-live-frame-membership-leak.md`](./env-sharing-live-frame-membership-leak.md) | OPEN — found during the env-sharing implement | — |
| [`equality-operator-without-an-eq-impl-evaluates-to-unit.md`](./equality-operator-without-an-eq-impl-evaluates-to-unit.md) | — | — |
| [`err-expr-id-0-aliases-the-prelude-in-compiles-shared-exprinfo-table.md`](./err-expr-id-0-aliases-the-prelude-in-compiles-shared-exprinfo-table.md) | OPEN | — |
| [`forward-referenced-definition-fails-to-type-check-when-forced-early.md`](./forward-referenced-definition-fails-to-type-check-when-forced-early.md) | OPEN — observed once, NOT REPRODUCIBLE on dev | — |
| [`function-info-is-closure-is-always-false.md`](./function-info-is-closure-is-always-false.md) | OPEN | — |
| [`generic-fn-forall-unresolved-when-argument-is-a-method-call.md`](./generic-fn-forall-unresolved-when-argument-is-a-method-call.md) | open — root-caused, NOT fixed | — |
| [`generic-fn-specialized-at-two-types-hands-the-closure-the-wrong-param-type.md`](./generic-fn-specialized-at-two-types-hands-the-closure-the-wrong-param-type.md) | — | yes |
| [`generic-fn-type-compatibility-is-not-alpha-equivalent.md`](./generic-fn-type-compatibility-is-not-alpha-equivalent.md) | — | — |
| [`generic-type-var-rebinds-per-argument.md`](./generic-type-var-rebinds-per-argument.md) | OPEN — the io-builtin face is fixed by a cont | — |
| [`iterator-chain-shared-stamp-cross-item-pollution.md`](./iterator-chain-shared-stamp-cross-item-pollution.md) | — | — |
| [`method-call-on-a-comptime-only-type-param-is-rejected-at-definition-time.md`](./method-call-on-a-comptime-only-type-param-is-rejected-at-definition-time.md) | OPEN | — |
| [`module-level-control-bound-binding-not-rejected.md`](./module-level-control-bound-binding-not-rejected.md) | — | — |
| [`mutual-recursion-between-a-fn-and-a-trait-impl-body.md`](./mutual-recursion-between-a-fn-and-a-trait-impl-body.md) | — | yes |
| [`same-operator-chain-of-four-or-more-is-not-left-associative.md`](./same-operator-chain-of-four-or-more-is-not-left-associative.md) | — | — |
| [`self-trait-in-a-return-type-loses-the-trait-on-an-erased-receiver.md`](./self-trait-in-a-return-type-loses-the-trait-on-an-erased-receiver.md) | — | yes |
| [`unit-zst-residual-gaps.md`](./unit-zst-residual-gaps.md) | OPEN (deliberate scope boundary, not regressi | — |
| [`varbound-combinator-receiver-impl-match.md`](./varbound-combinator-receiver-impl-match.md) | — | — |
| [`where-bound-gc-trace-still-fails-when-run-standalone.md`](./where-bound-gc-trace-still-fails-when-run-standalone.md) | — | — |

### Std library (63)

| Doc | Status (self-reported) | Repro |
| --- | --- | --- |
| [`bench-with-zero-iterations-returns-min-ns-greater-than-max-ns.md`](./bench-with-zero-iterations-returns-min-ns-greater-than-max-ns.md) | OPEN | — |
| [`cli-option-declared-with-an-empty-default-never-materializes.md`](./cli-option-declared-with-an-empty-default-never-materializes.md) | OPEN | — |
| [`cli-parse-returns-err-for-help-so-the-documented-example-aborts.md`](./cli-parse-returns-err-for-help-so-the-documented-example-aborts.md) | OPEN | — |
| [`cli-rejects-double-dash-bare-dash-and-long-option-equals-value.md`](./cli-rejects-double-dash-bare-dash-and-long-option-equals-value.md) | OPEN | — |
| [`cli-repeated-option-yields-the-first-value-and-the-rest-are-unreachable.md`](./cli-repeated-option-yields-the-first-value-and-the-rest-are-unreachable.md) | OPEN | — |
| [`cli-required-arg-field-is-declared-but-never-enforced.md`](./cli-required-arg-field-is-declared-but-never-enforced.md) | OPEN | — |
| [`crypto-random-reports-every-failure-as-unavailable-and-discards-the-errno.md`](./crypto-random-reports-every-failure-as-unavailable-and-discards-the-errno.md) | OPEN | — |
| [`empty-path-redirect-location-drops-the-base-paths-last-segment.md`](./empty-path-redirect-location-drops-the-base-paths-last-segment.md) | — | — |
| [`error-source-result-cannot-be-held-as-anyerror.md`](./error-source-result-cannot-be-held-as-anyerror.md) | OPEN — blocks `ErrorChain` / `root_cause` | yes |
| [`file-from-fd-metadata-stats-the-current-directory.md`](./file-from-fd-metadata-stats-the-current-directory.md) | OPEN | — |
| [`float-to-string-is-platform-dependent-for-non-finite-values.md`](./float-to-string-is-platform-dependent-for-non-finite-values.md) | — | — |
| [`hash-container-capacity-overflow-guard-has-no-regression-test.md`](./hash-container-capacity-overflow-guard-has-no-regression-test.md) | OPEN | — |
| [`http-client-omits-the-port-from-the-host-header.md`](./http-client-omits-the-port-from-the-host-header.md) | — | — |
| [`http-whitespace-before-header-colon-not-rejected.md`](./http-whitespace-before-header-colon-not-rejected.md) | — | — |
| [`httpmethod-from-string-returns-option-not-result.md`](./httpmethod-from-string-returns-option-not-result.md) | — | — |
| [`json-stringify-renders-numbers-with-percent-g-and-loses-them.md`](./json-stringify-renders-numbers-with-percent-g-and-loses-them.md) | OPEN — wrong value on a shipped serializer; J | — |
| [`make-sockaddr-ignores-inet-pton-failure-and-returns-the-wildcard-address.md`](./make-sockaddr-ignores-inet-pton-failure-and-returns-the-wildcard-address.md) | — | — |
| [`network-path-redirect-location-resolved-against-the-base-host.md`](./network-path-redirect-location-resolved-against-the-base-host.md) | — | — |
| [`path-join-and-push-never-refold-parent-segments.md`](./path-join-and-push-never-refold-parent-segments.md) | OPEN | — |
| [`path-new-destroys-the-windows-unc-and-verbatim-prefix.md`](./path-new-destroys-the-windows-unc-and-verbatim-prefix.md) | OPEN | — |
| [`path-new-drops-a-leading-parent-segment.md`](./path-new-drops-a-leading-parent-segment.md) | OPEN | — |
| [`random-f64-single-flake-under-sweep.md`](./random-f64-single-flake-under-sweep.md) | — | — |
| [`read-dir-maps-dt-unknown-to-filetype-other-so-walks-go-flat.md`](./read-dir-maps-dt-unknown-to-filetype-other-so-walks-go-flat.md) | OPEN | — |
| [`redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md`](./redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md) | — | — |
| [`redirect-resolution-never-removes-dot-segments.md`](./redirect-resolution-never-removes-dot-segments.md) | — | — |
| [`s3-fs-wrappers-windows-semantics-audit.md`](./s3-fs-wrappers-windows-semantics-audit.md) | OPEN | — |
| [`std-doc-examples-use-parenless-import-which-does-not-parse.md`](./std-doc-examples-use-parenless-import-which-does-not-parse.md) | OPEN | — |
| [`std-imm-exports-nine-internal-node-types-nothing-can-use.md`](./std-imm-exports-nine-internal-node-types-nothing-can-use.md) | — | yes |
| [`std-path-exemptions-are-lexical-so-tmp-symlink-breaks-them.md`](./std-path-exemptions-are-lexical-so-tmp-symlink-breaks-them.md) | OPEN | — |
| [`stddoc-coll-duplicate-fromiterator-impl-on-hashset.md`](./stddoc-coll-duplicate-fromiterator-impl-on-hashset.md) | OPEN | — |
| [`stddoc-coll-imm-vec-dedup-leaks-rc-elements.md`](./stddoc-coll-imm-vec-dedup-leaks-rc-elements.md) | OPEN — | yes |
| [`stddoc-core-doc-comment-attached-by-bare-member-name.md`](./stddoc-core-doc-comment-attached-by-bare-member-name.md) | OPEN | yes |
| [`stddoc-core-yo-doc-degrades-a-whole-module-to-nameless-constants.md`](./stddoc-core-yo-doc-degrades-a-whole-module-to-nameless-constants.md) | OPEN | — |
| [`stddoc-io-arg-parser-help-is-an-error-and-errors-are-strings.md`](./stddoc-io-arg-parser-help-is-an-error-and-errors-are-strings.md) | — | yes |
| [`stddoc-io-arg-parser-positionals-are-never-required.md`](./stddoc-io-arg-parser-positionals-are-never-required.md) | — | yes |
| [`stddoc-io-dns-lookup-discards-the-gai-error-code.md`](./stddoc-io-dns-lookup-discards-the-gai-error-code.md) | open | — |
| [`stddoc-io-dns-lookup-host-returns-duplicate-addresses.md`](./stddoc-io-dns-lookup-host-returns-duplicate-addresses.md) | open | — |
| [`stddoc-io-dns-resolution-blocks-the-event-loop.md`](./stddoc-io-dns-resolution-blocks-the-event-loop.md) | open | — |
| [`stddoc-io-doc-renders-every-stability-marker-as-unstable.md`](./stddoc-io-doc-renders-every-stability-marker-as-unstable.md) | open | — |
| [`stddoc-io-json-parse-string-accepts-raw-control-bytes.md`](./stddoc-io-json-parse-string-accepts-raw-control-bytes.md) | open | yes |
| [`stddoc-io-negative-duration-sleeps-forever.md`](./stddoc-io-negative-duration-sleeps-forever.md) | — | yes |
| [`stddoc-io-percent-encode-calls-str-to-string-without-importing-fmt.md`](./stddoc-io-percent-encode-calls-str-to-string-without-importing-fmt.md) | open, and | — |
| [`stddoc-io-stdio-handles-write-positionally-and-clobber-redirected-output.md`](./stddoc-io-stdio-handles-write-positionally-and-clobber-redirected-output.md) | open | yes |
| [`stddoc-io-url-empty-host-collapses-to-none.md`](./stddoc-io-url-empty-host-collapses-to-none.md) | open | yes |
| [`stddoc-io-windows-status-changed-mixes-two-timestamps.md`](./stddoc-io-windows-status-changed-mixes-two-timestamps.md) | OPEN — filed, not fixed (documentation-only P | — |
| [`stddoc-io-windows-temp-naming-is-not-atomic.md`](./stddoc-io-windows-temp-naming-is-not-atomic.md) | OPEN — filed, not fixed (documentation-only P | — |
| [`stddoc-str-regex-g-and-u-flags-are-silently-ignored.md`](./stddoc-str-regex-g-and-u-flags-are-silently-ignored.md) | open (found by the `std/` `///` doc sweep, 20 | yes |
| [`stddoc-str-regex-split-emits-the-literal-string-undefined.md`](./stddoc-str-regex-split-emits-the-literal-string-undefined.md) | open (found by the `std/` `///` doc sweep, 20 | yes |
| [`stddoc-str-string-builder-clear-drops-capacity.md`](./stddoc-str-string-builder-clear-drops-capacity.md) | open (found by the `std/` `///` doc sweep, 20 | — |
| [`stddoc-str-string-builder-write-f64-truncates.md`](./stddoc-str-string-builder-write-f64-truncates.md) | open (found by the `std/` `///` doc sweep, 20 | yes |
| [`stddoc-sys-signal-handler-data-always-null.md`](./stddoc-sys-signal-handler-data-always-null.md) | open | — |
| [`stddoc-sys-windows-copyfile-ignores-flags.md`](./stddoc-sys-windows-copyfile-ignores-flags.md) | open | yes |
| [`string-to-cstr-truncates-at-an-interior-nul.md`](./string-to-cstr-truncates-at-an-interior-nul.md) | OPEN | — |
| [`stringerror-indexoutofbounds-is-declared-but-no-string-api-can-return-it.md`](./stringerror-indexoutofbounds-is-declared-but-no-string-api-can-return-it.md) | OPEN | — |
| [`sys-signals-macos-numbers-are-linux-values.md`](./sys-signals-macos-numbers-are-linux-values.md) | open | yes |
| [`tempfile-dispose-and-file-pos-interaction.md`](./tempfile-dispose-and-file-pos-interaction.md) | — | — |
| [`thread-safety-phase-p-never-landed-but-plan-says-complete.md`](./thread-safety-phase-p-never-landed-but-plan-says-complete.md) | Complete | yes |
| [`tls-and-datetime-errors-lack-the-error-impl-they-are-thrown-as.md`](./tls-and-datetime-errors-lack-the-error-impl-they-are-thrown-as.md) | PARTIALLY FIXED 2026-09-05 — items 1 (`TlsErr | — |
| [`url-origin-drops-userinfo-so-redirect-resolution-loses-credentials.md`](./url-origin-drops-userinfo-so-redirect-resolution-loses-credentials.md) | — | — |
| [`url-parse-accepts-any-byte-in-the-scheme.md`](./url-parse-accepts-any-byte-in-the-scheme.md) | — | — |
| [`utf16-unpaired-surrogate-reported-as-invalidchar-zero.md`](./utf16-unpaired-surrogate-reported-as-invalidchar-zero.md) | OPEN — found during STD_API_AUDIT D8 (the `En | — |
| [`walker-follow-symlinks-windows-unsupported.md`](./walker-follow-symlinks-windows-unsupported.md) | — | — |
| [`writer-write-padded-measures-bytes-but-pads-in-runes.md`](./writer-write-padded-measures-bytes-but-pads-in-runes.md) | OPEN | — |

### Tooling (fmt/doc/lsp) (16)

| Doc | Status (self-reported) | Repro |
| --- | --- | --- |
| [`collection-method-docs-written-with-plain-slashes-are-dropped-by-yo-doc.md`](./collection-method-docs-written-with-plain-slashes-are-dropped-by-yo-doc.md) | OPEN | — |
| [`collection-test-names-still-use-pre-rename-method-spellings.md`](./collection-test-names-still-use-pre-rename-method-spellings.md) | OPEN | — |
| [`diagnostic-codes-are-assigned-by-substring-matching-the-message-text.md`](./diagnostic-codes-are-assigned-by-substring-matching-the-message-text.md) | — | — |
| [`fixed-async-cond-dispatch-doc-left-in-open-issues-root.md`](./fixed-async-cond-dispatch-doc-left-in-open-issues-root.md) | OPEN | yes |
| [`fmt-not-idempotent-call-wrapped-match-in-block.md`](./fmt-not-idempotent-call-wrapped-match-in-block.md) | — | yes |
| [`fmt-pointer-type-paren-verdict-is-context-dependent.md`](./fmt-pointer-type-paren-verdict-is-context-dependent.md) | OPEN | — |
| [`fmt-reformats-parse-invalid-files.md`](./fmt-reformats-parse-invalid-files.md) | — | — |
| [`nested-backtick-template-interpolates-the-injected-import.md`](./nested-backtick-template-interpolates-the-injected-import.md) | OPEN — valid source is rejected, and the diag | — |
| [`template-string-backslash-before-interpolation-eats-both.md`](./template-string-backslash-before-interpolation-eats-both.md) | — | — |
| [`template-string-nested-inside-an-interpolation-fails-to-parse.md`](./template-string-nested-inside-an-interpolation-fails-to-parse.md) | — | — |
| [`test-runner-std-path-shadowed-by-binary-tree-std.md`](./test-runner-std-path-shadowed-by-binary-tree-std.md) | — | — |
| [`user-facing-async-restrictions-reported-as-internal-compiler-error.md`](./user-facing-async-restrictions-reported-as-internal-compiler-error.md) | OPEN | — |
| [`yo-doc-leaks-private-compiler-temps-into-the-search-index.md`](./yo-doc-leaks-private-compiler-temps-into-the-search-index.md) | OPEN — found 2026-09-14, incidentally, while | — |
| [`yo-doc-renders-std-prelude-as-an-empty-module.md`](./yo-doc-renders-std-prelude-as-an-empty-module.md) | OPEN | — |
| [`yo-doc-without-std-path-silently-emits-token-only-docs.md`](./yo-doc-without-std-path-silently-emits-token-only-docs.md) | open | — |
| [`yo-fmt-walks-gitignored-generated-files.md`](./yo-fmt-walks-gitignored-generated-files.md) | — | — |

### Self-hosting legacy (19)

| Doc | Status (self-reported) | Repro |
| --- | --- | --- |
| [`compiler-holds-emit-memory-during-cc.md`](./compiler-holds-emit-memory-during-cc.md) | — | — |
| [`debug-probe-line-costs-gigabytes-at-compile-time.md`](./debug-probe-line-costs-gigabytes-at-compile-time.md) | — | — |
| [`desugar-token-clones-evaluator-regression.md`](./desugar-token-clones-evaluator-regression.md) | — | — |
| [`self-hosted-emit-leaks-remaining-classes.md`](./self-hosted-emit-leaks-remaining-classes.md) | — | — |
| [`yo-self-async-await-argcount-overpermissive.md`](./yo-self-async-await-argcount-overpermissive.md) | — | — |
| [`yo-self-async-completion-drop-set-divergence.md`](./yo-self-async-completion-drop-set-divergence.md) | — | — |
| [`yo-self-async-emission-cluster.md`](./yo-self-async-emission-cluster.md) | — | — |
| [`yo-self-collections-batch-residuals.md`](./yo-self-collections-batch-residuals.md) | — | yes |
| [`yo-self-compile-performance-rc-string-eq.md`](./yo-self-compile-performance-rc-string-eq.md) | — | — |
| [`yo-self-ctfe-nested-fn-analysis-gap.md`](./yo-self-ctfe-nested-fn-analysis-gap.md) | — | — |
| [`yo-self-dup-eval-inside-macro-generated-body-corrupts-module-eval.md`](./yo-self-dup-eval-inside-macro-generated-body-corrupts-module-eval.md) | SIDESTEPPED for Stage 0 (fix direction 2 belo | — |
| [`yo-self-missing-duplicate-impl-checks.md`](./yo-self-missing-duplicate-impl-checks.md) | — | — |
| [`yo-self-rc-depth-cap-skips-deep-teardown.md`](./yo-self-rc-depth-cap-skips-deep-teardown.md) | — | yes |
| [`yo-self-rc-teardown-not-factored-into-dispose.md`](./yo-self-rc-teardown-not-factored-into-dispose.md) | — | — |
| [`yo-self-test-runner-cannot-run-wasm-batches.md`](./yo-self-test-runner-cannot-run-wasm-batches.md) | — | — |
| [`yo-self-unwired-port-gaps.md`](./yo-self-unwired-port-gaps.md) | — | — |
| [`yo-self-where-clause-full-enforcement.md`](./yo-self-where-clause-full-enforcement.md) | partially implemented (marker-trait subset li | — |
| [`yoself-accepts-await-in-cond-that-ts-rejects.md`](./yoself-accepts-await-in-cond-that-ts-rejects.md) | — | — |
| [`yoself-missing-compiling-with-print.md`](./yoself-missing-compiling-with-print.md) | — | — |

### Vendor (markdown_yo) (3)

| Doc | Status (self-reported) | Repro |
| --- | --- | --- |
| [`vendor-markdown-punycode-encode-reads-past-the-buffer.md`](./vendor-markdown-punycode-encode-reads-past-the-buffer.md) | OPEN (upstream — `vendor/markdown_yo`, submod | — |
| [`vendor-markdown-shared-utf8-codec-has-no-callers.md`](./vendor-markdown-shared-utf8-codec-has-no-callers.md) | OPEN (upstream — `vendor/markdown_yo`, submod | — |
| [`vendor-markdown-truncated-utf8-aliases-a-valid-link-label.md`](./vendor-markdown-truncated-utf8-aliases-a-valid-link-label.md) | OPEN (upstream — `vendor/markdown_yo`, submod | — |

### Other (2)

| Doc | Status (self-reported) | Repro |
| --- | --- | --- |
| [`main-return-value-is-discarded-so-a-main-computed-exit-code-is-always-zero.md`](./main-return-value-is-discarded-so-a-main-computed-exit-code-is-always-zero.md) | OPEN | — |
| [`own-param-leaks-when-a-conditional-return-is-not-taken.md`](./own-param-leaks-when-a-conditional-return-is-not-taken.md) | OPEN | yes |
