# `issues/` triage index — open docs, categorised

**Generated** by `scripts/gen-issue-triage.py` over the 167 open bug
docs in `issues/` root and the 11 design questions in
`issues/questions/`. A NAVIGATION aid, not a source of truth: each doc stays
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
| CI/Release/Build | 11 | 1 |
| Async / effects | 13 | 2 |
| Codegen / emitted C | 18 | 3 |
| Evaluator / types | 22 | 4 |
| Std library | 50 | 12 |
| Tooling (fmt/doc/lsp) | 12 | 1 |
| Self-hosting legacy | 12 | 2 |
| Vendor (markdown_yo) | 3 | 0 |
| Other | 26 | 6 |
| **Total** | **167** | **31** |

## Counts by severity

Scale defined in `issues/README.md`; assigned in the 2026-09-28 triage pass.

| Severity | Open docs |
| --- | ---: |
| S1 | 34 |
| S2 | 84 |
| S3 | 48 |
| (missing) | 1 |

- MISSING SEVERITY: `ref-joinhandle-rewrites-left-value-shape-emitters-linux-stage1-red.md`

## Design questions (issues/questions/)

Open decisions, not defects — each doc carries a `## Recommendation`
awaiting the maintainer's verdict. Not counted in the tables above.

- [`builtin-name-shadows-user-definition.md`](./questions/builtin-name-shadows-user-definition.md) — which name-resolution policy when user definitions collide with builtins: reserve, prefer user bindings, or warn
- [`emscripten-heap-is-fixed-at-16mb-so-thread-heavy-programs-abort.md`](./questions/emscripten-heap-is-fixed-at-16mb-so-thread-heavy-programs-abort.md) — grow the emscripten heap, size it from a flag, or make the OOM abort say what happened
- [`httpmethod-from-string-returns-option-not-result.md`](./questions/httpmethod-from-string-returns-option-not-result.md) — `HttpMethod.from_string` should be a `FromString` impl — with which error type
- [`manifest-package-yo-msrv-field-is-parsed-but-never-enforced.md`](./questions/manifest-package-yo-msrv-field-is-parsed-but-never-enforced.md) — how the `[package] yo` MSRV field is enforced: error vs warning, `>=` or range, checked where
- [`no-volatile-so-black-box-needs-inline-asm.md`](./questions/no-volatile-so-black-box-needs-inline-asm.md) — `volatile` qualifier, volatile builtins, or a per-target `__yo_black_box` builtin
- [`spawn-blocking-degrades-to-inline-on-a-threadless-target.md`](./questions/spawn-blocking-degrades-to-inline-on-a-threadless-target.md) — how a caller learns `spawn_blocking` degrades to inline on a threadless target
- [`stddoc-io-url-empty-host-collapses-to-none.md`](./questions/stddoc-io-url-empty-host-collapses-to-none.md) — empty authority host: `.Some("")` plus an authority bit (Rust's shape) vs keeping `.None`
- [`stddoc-str-regex-split-emits-the-literal-string-undefined.md`](./questions/stddoc-str-regex-split-emits-the-literal-string-undefined.md) — `Regex.split`: Rust's shape (pieces only) vs Python's shape (`ArrayList(Option(String))`)
- [`stddoc-sys-signal-handler-data-always-null.md`](./questions/stddoc-sys-signal-handler-data-always-null.md) — carry the `SignalHandler` user data (the `events.yo` precedent) or drop the parameter
- [`with-lock-and-with-permit-cannot-see-an-unwind.md`](./questions/with-lock-and-with-permit-cannot-see-an-unwind.md) — correct the unlock-on-unwind comment only, or make with_lock/with_permit effect-transparent
- [`yo-doc-document-private-flag-is-a-no-op.md`](./questions/yo-doc-document-private-flag-is-a-no-op.md) — implement or remove the inert `--document-private` flag

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

- [`make-sockaddr-ignores-inet-pton-failure-and-returns-the-wildcard-address.md`](./make-sockaddr-ignores-inet-pton-failure-and-returns-the-wildcard-address.md) — std/sys/tcp.yo:188 still documents the failure as unreported
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


### Twenty closed docs still carry an OPEN status line

`scripts/check-issue-refs.sh` now reports these. A doc under `fixed/` or
`retired/` whose `**Status**` line still reads a bare OPEN is either a stale
header or a live bug hiding in the closed pile, and nothing else here can see
the difference — several contradict themselves outright, carrying a `FIXED`
banner at the top and an `OPEN` status line below it.

**Do not bulk-rewrite these headers.** Each needs the same treatment as any
other status claim: check the code. Of the three examined on 2026-09-15, one was
a live-looking blocker (`an ArrayList(Waker)` tracer said to be blocking the
channel rewrite) that turned out to be FIXED — but only reading
`std/async/channel.yo`, and finding the waiter queues present and the 1 ms tick
gone, established that. Rewriting the header to match the directory would have
been the same error as trusting a Status header in the first place, just
pointing the other way.


### Reference integrity

`scripts/check-issue-refs.sh` asserts every cited `issues/**` path resolves.
Run it on the MERGE RESULT, not on a branch: a concurrent move reads as a
stale reference there, and 'repairing' it reverts someone else's work.

### Largest docs (usually clusters, not single defects)

- [`warm-compile-selfcheck.md`](./warm-compile-selfcheck.md) — 19 KB
- [`a-bodyless-http-response-is-not-read-until-the-deadline.md`](./a-bodyless-http-response-is-not-read-until-the-deadline.md) — 17 KB
- [`yo-self-compile-performance-rc-string-eq.md`](./yo-self-compile-performance-rc-string-eq.md) — 16 KB
- [`yo-self-collections-batch-residuals.md`](./yo-self-collections-batch-residuals.md) — 16 KB
- [`std-imm-exports-nine-internal-node-types-nothing-can-use.md`](./std-imm-exports-nine-internal-node-types-nothing-can-use.md) — 13 KB
- [`d6-schannel-hangs-the-windows-test-legs-for-four-hours.md`](./d6-schannel-hangs-the-windows-test-legs-for-four-hours.md) — 12 KB
- [`err-expr-id-0-aliases-the-prelude-in-compiles-shared-exprinfo-table.md`](./err-expr-id-0-aliases-the-prelude-in-compiles-shared-exprinfo-table.md) — 12 KB
- [`asm-documented-target-and-register-validation-does-not-exist.md`](./asm-documented-target-and-register-validation-does-not-exist.md) — 10 KB

---

## By area


### CI/Release/Build (11)

| Doc | Severity | Status (self-reported) | Repro |
| --- | --- | --- | --- |
| [`build-option-value-cannot-feed-an-artifact-field.md`](./build-option-value-cannot-feed-an-artifact-field.md) | S2 | OPEN (found 2026-09-12) | — |
| [`build-release-small-is-identical-to-release-safe.md`](./build-release-small-is-identical-to-release-safe.md) | S3 | OPEN | — |
| [`d6-schannel-hangs-the-windows-test-legs-for-four-hours.md`](./d6-schannel-hangs-the-windows-test-legs-for-four-hours.md) | S1 | — | — |
| [`leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md`](./leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md) | S3 | OPEN | — |
| [`release-gate-accepts-a-docs-only-fast-path-success.md`](./release-gate-accepts-a-docs-only-fast-path-success.md) | S3 | open (found 2026-09-10 while cutting v0 | — |
| [`seed-early-return-drops-later-local-through-shadowing-pattern-name.md`](./seed-early-return-drops-later-local-through-shadowing-pattern-name.md) | S2 | — | — |
| [`seed-emitted-unknown-type-comment-breaks-the-musl-gcc-leg.md`](./seed-emitted-unknown-type-comment-breaks-the-musl-gcc-leg.md) | S3 | OPEN (blocked on a seed bump) | yes |
| [`v0.2.23-seed-build-lottery-corrupts-shifted-trees.md`](./v0.2.23-seed-build-lottery-corrupts-shifted-trees.md) | S1 | — | — |
| [`version-install-cross-device-link.md`](./version-install-cross-device-link.md) | S2 | — | — |
| [`windows-images-lost-libasan.md`](./windows-images-lost-libasan.md) | S3 | OPEN (CI workaround landed with the module-gl | — |
| [`yo-lock-records-the-annotated-tag-object-not-the-commit.md`](./yo-lock-records-the-annotated-tag-object-not-the-commit.md) | S3 | OPEN — found 2026-09-14 while re-pinning `mar | — |

### Async / effects (13)

| Doc | Severity | Status (self-reported) | Repro |
| --- | --- | --- | --- |
| [`a-bodyless-http-response-is-not-read-until-the-deadline.md`](./a-bodyless-http-response-is-not-read-until-the-deadline.md) | S1 | OPEN — an inner | — |
| [`a-captured-closure-is-judged-by-its-capture-struct-so-a-send-closure-is-rejected.md`](./a-captured-closure-is-judged-by-its-capture-struct-so-a-send-closure-is-rejected.md) | S2 | OPEN | — |
| [`async-abort-dispose-double-drops-moved-enum-payload.md`](./async-abort-dispose-double-drops-moved-enum-payload.md) | S1 | — | yes |
| [`async-await-nested-if-lost-continuation.md`](./async-await-nested-if-lost-continuation.md) | S1 | — | — |
| [`async-capture-mode-argument-rendering-cluster.md`](./async-capture-mode-argument-rendering-cluster.md) | S2 | — | — |
| [`async-tail-match-return-hangs-state-machine.md`](./async-tail-match-return-hangs-state-machine.md) | S1 | OPEN — std avoids the shape (the | — |
| [`command-stdin-windows-pipe-write-blocks-the-event-loop.md`](./command-stdin-windows-pipe-write-blocks-the-event-loop.md) | S1 | — | — |
| [`impl-method-self-receiver-hollows-forwarded-spawn-closures.md`](./impl-method-self-receiver-hollows-forwarded-spawn-closures.md) | S1 | OPEN — worked around in `std/thread | yes |
| [`pending-io-future-local-drop-uaf.md`](./pending-io-future-local-drop-uaf.md) | S1 | OPEN — analysis-verified hazard, not | — |
| [`windows-1ms-deadline-race-loses-since-cancellation-landing.md`](./windows-1ms-deadline-race-loses-since-cancellation-landing.md) | S2 | — | — |
| [`windows-async-io-runtime-audit.md`](./windows-async-io-runtime-audit.md) | S3 | — | — |
| [`yield-now-costs-a-millisecond-per-turn-inside-a-test-batch.md`](./yield-now-costs-a-millisecond-per-turn-inside-a-test-batch.md) | S3 | OPEN — a PERFORMANCE observation, not a corre | — |
| [`yield-resumption-order-diverges-on-macos-ci.md`](./yield-resumption-order-diverges-on-macos-ci.md) | S2 | — | — |

### Codegen / emitted C (18)

| Doc | Severity | Status (self-reported) | Repro |
| --- | --- | --- | --- |
| [`asm-documented-target-and-register-validation-does-not-exist.md`](./asm-documented-target-and-register-validation-does-not-exist.md) | S2 | OPEN | — |
| [`assign-to-by-value-closure-param-under-generic-result-types-unit.md`](./assign-to-by-value-closure-param-under-generic-result-types-unit.md) | S2 | — | yes |
| [`c-include-global-accepted-by-comptime-binding.md`](./c-include-global-accepted-by-comptime-binding.md) | S2 | PARTIALLY FIXED 2026-09-08 — the `::` half is | — |
| [`c-include-rvalue-macro-constant-cannot-be-addressed.md`](./c-include-rvalue-macro-constant-cannot-be-addressed.md) | S2 | OPEN | — |
| [`cinclude-int-comparison-fails-to-transpile.md`](./cinclude-int-comparison-fails-to-transpile.md) | S2 | — | — |
| [`dead-yo-stat-accessor-family-emitted-into-every-program.md`](./dead-yo-stat-accessor-family-emitted-into-every-program.md) | S3 | OPEN | — |
| [`derive-tostring-on-a-generic-struct-emits-invalid-c.md`](./derive-tostring-on-a-generic-struct-emits-invalid-c.md) | S2 | OPEN | yes |
| [`drop-bookkeeping-hangs-off-a-generator-return-value-that-is-empty-for-multi-line-drops.md`](./drop-bookkeeping-hangs-off-a-generator-return-value-that-is-empty-for-multi-line-drops.md) | S1 | OPEN for the two remaining sites | — |
| [`emitted-c-flipped-once-under-extreme-load-unexplained.md`](./emitted-c-flipped-once-under-extreme-load-unexplained.md) | S3 | — | — |
| [`emitted-c-hardcodes-linux-at-fdcwd.md`](./emitted-c-hardcodes-linux-at-fdcwd.md) | S3 | — | — |
| [`emitted-c-identifiers-collide-with-header-macros.md`](./emitted-c-identifiers-collide-with-header-macros.md) | S1 | OPEN | — |
| [`ftt-stub-in-live-closure-falls-off-non-void-function.md`](./ftt-stub-in-live-closure-falls-off-non-void-function.md) | S1 | — | yes |
| [`match-arm-and-or-rhs-temp-drop-leaks-arm-scope.md`](./match-arm-and-or-rhs-temp-drop-leaks-arm-scope.md) | S2 | — | — |
| [`rc-value-copied-address-taken-and-returned-is-double-dropped.md`](./rc-value-copied-address-taken-and-returned-is-double-dropped.md) | S1 | OPEN | — |
| [`self-hosted-debug-emission-undeclared-temp.md`](./self-hosted-debug-emission-undeclared-temp.md) | S2 | — | — |
| [`swallowed-closure-spec-emits-wrong-typed-return-msvc-error.md`](./swallowed-closure-spec-emits-wrong-typed-return-msvc-error.md) | S1 | — | — |
| [`wasm-runtime-missing-six-statx-accessors-that-std-declares.md`](./wasm-runtime-missing-six-statx-accessors-that-std-declares.md) | S2 | OPEN | — |
| [`wasm-statx-nsec-accessors-return-int64-but-are-declared-u32.md`](./wasm-statx-nsec-accessors-return-int64-but-are-declared-u32.md) | S3 | OPEN | — |

### Evaluator / types (22)

| Doc | Severity | Status (self-reported) | Repro |
| --- | --- | --- | --- |
| [`annotated-local-from-a-trait-constrained-receiver-loses-every-method.md`](./annotated-local-from-a-trait-constrained-receiver-loses-every-method.md) | S2 | — | — |
| [`anonymous-module-trial-swallows-a-top-level-derive.md`](./anonymous-module-trial-swallows-a-top-level-derive.md) | S2 | — | yes |
| [`arraylist-private-ptr-read-across-module-boundaries.md`](./arraylist-private-ptr-read-across-module-boundaries.md) | S3 | OPEN | — |
| [`blanket-into-iter-is-not-an-intoiterator-impl.md`](./blanket-into-iter-is-not-an-intoiterator-impl.md) | S2 | OPEN | — |
| [`comments-preceding-definitions-can-hollow-the-definition.md`](./comments-preceding-definitions-can-hollow-the-definition.md) | S2 | — | — |
| [`comptime-enum-payload-field-assignment-is-a-silent-no-op.md`](./comptime-enum-payload-field-assignment-is-a-silent-no-op.md) | S1 | — | — |
| [`comptime-float-negation-loses-the-sign-of-zero.md`](./comptime-float-negation-loses-the-sign-of-zero.md) | S2 | OPEN | — |
| [`comptime-str-method-result-does-not-convert-to-str-in-typed-binding.md`](./comptime-str-method-result-does-not-convert-to-str-in-typed-binding.md) | S2 | — | — |
| [`derive-body-field-name-collides-with-a-builtin-type.md`](./derive-body-field-name-collides-with-a-builtin-type.md) | S2 | open (found 2026-09-09 while adding `Encoding | yes |
| [`derived-eq-ref-enum-self-payload-hollow-at-runtime.md`](./derived-eq-ref-enum-self-payload-hollow-at-runtime.md) | S1 | — | — |
| [`dyn-as-a-direct-downcast-argument-reports-got-option.md`](./dyn-as-a-direct-downcast-argument-reports-got-option.md) | S3 | OPEN | — |
| [`dyn-of-a-static-method-call-in-a-bare-tail-fn-body-loses-the-payload-type.md`](./dyn-of-a-static-method-call-in-a-bare-tail-fn-body-loses-the-payload-type.md) | S2 | OPEN | — |
| [`env-sharing-live-frame-membership-leak.md`](./env-sharing-live-frame-membership-leak.md) | S1 | OPEN — found during the env-sharing implement | — |
| [`err-expr-id-0-aliases-the-prelude-in-compiles-shared-exprinfo-table.md`](./err-expr-id-0-aliases-the-prelude-in-compiles-shared-exprinfo-table.md) | S2 | OPEN | — |
| [`forward-referenced-definition-fails-to-type-check-when-forced-early.md`](./forward-referenced-definition-fails-to-type-check-when-forced-early.md) | S2 | OPEN — observed once, NOT REPRODUCIBLE on dev | — |
| [`function-info-is-closure-is-always-false.md`](./function-info-is-closure-is-always-false.md) | S2 | OPEN | — |
| [`generic-trial-degrades-a-failed-evaluation-to-unit.md`](./generic-trial-degrades-a-failed-evaluation-to-unit.md) | S2 | OPEN | — |
| [`method-call-on-a-comptime-only-type-param-is-rejected-at-definition-time.md`](./method-call-on-a-comptime-only-type-param-is-rejected-at-definition-time.md) | S2 | OPEN | — |
| [`mutual-recursion-between-a-fn-and-a-trait-impl-body.md`](./mutual-recursion-between-a-fn-and-a-trait-impl-body.md) | S2 | — | yes |
| [`same-operator-chain-of-four-or-more-is-not-left-associative.md`](./same-operator-chain-of-four-or-more-is-not-left-associative.md) | S1 | — | — |
| [`unit-zst-residual-gaps.md`](./unit-zst-residual-gaps.md) | S2 | OPEN (deliberate scope boundary, not regressi | yes |
| [`where-bound-gc-trace-still-fails-when-run-standalone.md`](./where-bound-gc-trace-still-fails-when-run-standalone.md) | S2 | — | — |

### Std library (50)

| Doc | Severity | Status (self-reported) | Repro |
| --- | --- | --- | --- |
| [`cli-option-declared-with-an-empty-default-never-materializes.md`](./cli-option-declared-with-an-empty-default-never-materializes.md) | S2 | OPEN | — |
| [`cli-parse-returns-err-for-help-so-the-documented-example-aborts.md`](./cli-parse-returns-err-for-help-so-the-documented-example-aborts.md) | S2 | OPEN | — |
| [`cli-rejects-double-dash-bare-dash-and-long-option-equals-value.md`](./cli-rejects-double-dash-bare-dash-and-long-option-equals-value.md) | S2 | OPEN | — |
| [`cli-repeated-option-yields-the-first-value-and-the-rest-are-unreachable.md`](./cli-repeated-option-yields-the-first-value-and-the-rest-are-unreachable.md) | S2 | OPEN | — |
| [`cli-required-arg-field-is-declared-but-never-enforced.md`](./cli-required-arg-field-is-declared-but-never-enforced.md) | S2 | OPEN | — |
| [`empty-path-redirect-location-drops-the-base-paths-last-segment.md`](./empty-path-redirect-location-drops-the-base-paths-last-segment.md) | S2 | — | — |
| [`file-from-fd-metadata-stats-the-current-directory.md`](./file-from-fd-metadata-stats-the-current-directory.md) | S2 | OPEN | — |
| [`hash-container-capacity-overflow-guard-has-no-regression-test.md`](./hash-container-capacity-overflow-guard-has-no-regression-test.md) | S3 | OPEN | — |
| [`http-client-omits-the-port-from-the-host-header.md`](./http-client-omits-the-port-from-the-host-header.md) | S2 | — | — |
| [`http-whitespace-before-header-colon-not-rejected.md`](./http-whitespace-before-header-colon-not-rejected.md) | S2 | — | — |
| [`json-stringify-renders-numbers-with-percent-g-and-loses-them.md`](./json-stringify-renders-numbers-with-percent-g-and-loses-them.md) | S2 | OPEN — wrong value on a shipped serializer; J | — |
| [`make-sockaddr-ignores-inet-pton-failure-and-returns-the-wildcard-address.md`](./make-sockaddr-ignores-inet-pton-failure-and-returns-the-wildcard-address.md) | S2 | — | — |
| [`network-path-redirect-location-resolved-against-the-base-host.md`](./network-path-redirect-location-resolved-against-the-base-host.md) | S2 | — | — |
| [`path-join-and-push-never-refold-parent-segments.md`](./path-join-and-push-never-refold-parent-segments.md) | S2 | OPEN | — |
| [`path-new-destroys-the-windows-unc-and-verbatim-prefix.md`](./path-new-destroys-the-windows-unc-and-verbatim-prefix.md) | S2 | OPEN | — |
| [`path-new-drops-a-leading-parent-segment.md`](./path-new-drops-a-leading-parent-segment.md) | S2 | OPEN | — |
| [`random-f64-single-flake-under-sweep.md`](./random-f64-single-flake-under-sweep.md) | S3 | — | — |
| [`read-dir-maps-dt-unknown-to-filetype-other-so-walks-go-flat.md`](./read-dir-maps-dt-unknown-to-filetype-other-so-walks-go-flat.md) | S2 | OPEN | — |
| [`redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md`](./redirect-location-with-an-absolute-url-in-its-query-fails-to-resolve.md) | S2 | — | — |
| [`redirect-resolution-never-removes-dot-segments.md`](./redirect-resolution-never-removes-dot-segments.md) | S2 | — | — |
| [`s3-fs-wrappers-windows-semantics-audit.md`](./s3-fs-wrappers-windows-semantics-audit.md) | S3 | OPEN | — |
| [`std-doc-examples-use-parenless-import-which-does-not-parse.md`](./std-doc-examples-use-parenless-import-which-does-not-parse.md) | S3 | OPEN | — |
| [`std-imm-exports-nine-internal-node-types-nothing-can-use.md`](./std-imm-exports-nine-internal-node-types-nothing-can-use.md) | S3 | — | yes |
| [`std-path-exemptions-are-lexical-so-tmp-symlink-breaks-them.md`](./std-path-exemptions-are-lexical-so-tmp-symlink-breaks-them.md) | S2 | OPEN | — |
| [`std-sweep-fails-after-collections-annotations.md`](./std-sweep-fails-after-collections-annotations.md) | S3 | — | — |
| [`stddoc-coll-imm-vec-dedup-leaks-rc-elements.md`](./stddoc-coll-imm-vec-dedup-leaks-rc-elements.md) | S1 | OPEN — | yes |
| [`stddoc-core-doc-comment-attached-by-bare-member-name.md`](./stddoc-core-doc-comment-attached-by-bare-member-name.md) | S3 | OPEN | yes |
| [`stddoc-core-yo-doc-degrades-a-whole-module-to-nameless-constants.md`](./stddoc-core-yo-doc-degrades-a-whole-module-to-nameless-constants.md) | S3 | OPEN | — |
| [`stddoc-io-arg-parser-help-is-an-error-and-errors-are-strings.md`](./stddoc-io-arg-parser-help-is-an-error-and-errors-are-strings.md) | S2 | — | yes |
| [`stddoc-io-arg-parser-positionals-are-never-required.md`](./stddoc-io-arg-parser-positionals-are-never-required.md) | S2 | — | yes |
| [`stddoc-io-dns-lookup-discards-the-gai-error-code.md`](./stddoc-io-dns-lookup-discards-the-gai-error-code.md) | S2 | open | — |
| [`stddoc-io-dns-lookup-host-returns-duplicate-addresses.md`](./stddoc-io-dns-lookup-host-returns-duplicate-addresses.md) | S2 | open | — |
| [`stddoc-io-dns-resolution-blocks-the-event-loop.md`](./stddoc-io-dns-resolution-blocks-the-event-loop.md) | S2 | open | — |
| [`stddoc-io-doc-renders-every-stability-marker-as-unstable.md`](./stddoc-io-doc-renders-every-stability-marker-as-unstable.md) | S3 | open | — |
| [`stddoc-io-json-parse-string-accepts-raw-control-bytes.md`](./stddoc-io-json-parse-string-accepts-raw-control-bytes.md) | S2 | open | yes |
| [`stddoc-io-negative-duration-sleeps-forever.md`](./stddoc-io-negative-duration-sleeps-forever.md) | S2 | — | yes |
| [`stddoc-io-percent-encode-calls-str-to-string-without-importing-fmt.md`](./stddoc-io-percent-encode-calls-str-to-string-without-importing-fmt.md) | S2 | open, and | — |
| [`stddoc-io-stdio-handles-write-positionally-and-clobber-redirected-output.md`](./stddoc-io-stdio-handles-write-positionally-and-clobber-redirected-output.md) | S1 | open | yes |
| [`stddoc-io-windows-status-changed-mixes-two-timestamps.md`](./stddoc-io-windows-status-changed-mixes-two-timestamps.md) | S2 | OPEN — filed, not fixed (documentation-only P | — |
| [`stddoc-io-windows-temp-naming-is-not-atomic.md`](./stddoc-io-windows-temp-naming-is-not-atomic.md) | S2 | OPEN — filed, not fixed (documentation-only P | — |
| [`stddoc-str-regex-g-and-u-flags-are-silently-ignored.md`](./stddoc-str-regex-g-and-u-flags-are-silently-ignored.md) | S2 | open (found by the `std/` `///` doc sweep, 20 | yes |
| [`stddoc-str-string-builder-write-f64-truncates.md`](./stddoc-str-string-builder-write-f64-truncates.md) | S2 | open (found by the `std/` `///` doc sweep, 20 | yes |
| [`stddoc-sys-windows-copyfile-ignores-flags.md`](./stddoc-sys-windows-copyfile-ignores-flags.md) | S2 | open | yes |
| [`string-to-cstr-truncates-at-an-interior-nul.md`](./string-to-cstr-truncates-at-an-interior-nul.md) | S1 | OPEN | — |
| [`sys-signals-macos-numbers-are-linux-values.md`](./sys-signals-macos-numbers-are-linux-values.md) | S2 | open | yes |
| [`tempfile-dispose-and-file-pos-interaction.md`](./tempfile-dispose-and-file-pos-interaction.md) | S2 | — | — |
| [`tls-and-datetime-errors-lack-the-error-impl-they-are-thrown-as.md`](./tls-and-datetime-errors-lack-the-error-impl-they-are-thrown-as.md) | S3 | PARTIALLY FIXED 2026-09-05 — items 1 (`TlsErr | — |
| [`url-origin-drops-userinfo-so-redirect-resolution-loses-credentials.md`](./url-origin-drops-userinfo-so-redirect-resolution-loses-credentials.md) | S2 | — | — |
| [`utf16-unpaired-surrogate-reported-as-invalidchar-zero.md`](./utf16-unpaired-surrogate-reported-as-invalidchar-zero.md) | S3 | OPEN — found during STD_API_AUDIT D8 (the `En | — |
| [`walker-follow-symlinks-windows-unsupported.md`](./walker-follow-symlinks-windows-unsupported.md) | S3 | — | — |

### Tooling (fmt/doc/lsp) (12)

| Doc | Severity | Status (self-reported) | Repro |
| --- | --- | --- | --- |
| [`collection-method-docs-written-with-plain-slashes-are-dropped-by-yo-doc.md`](./collection-method-docs-written-with-plain-slashes-are-dropped-by-yo-doc.md) | S3 | OPEN | — |
| [`collection-test-names-still-use-pre-rename-method-spellings.md`](./collection-test-names-still-use-pre-rename-method-spellings.md) | S3 | OPEN | — |
| [`fmt-not-idempotent-call-wrapped-match-in-block.md`](./fmt-not-idempotent-call-wrapped-match-in-block.md) | S3 | — | yes |
| [`fmt-pointer-type-paren-verdict-is-context-dependent.md`](./fmt-pointer-type-paren-verdict-is-context-dependent.md) | S3 | OPEN | — |
| [`fmt-reformats-parse-invalid-files.md`](./fmt-reformats-parse-invalid-files.md) | S3 | — | — |
| [`nested-backtick-template-interpolates-the-injected-import.md`](./nested-backtick-template-interpolates-the-injected-import.md) | S2 | OPEN — valid source is rejected, and the diag | — |
| [`template-string-backslash-before-interpolation-eats-both.md`](./template-string-backslash-before-interpolation-eats-both.md) | S1 | — | — |
| [`template-string-nested-inside-an-interpolation-fails-to-parse.md`](./template-string-nested-inside-an-interpolation-fails-to-parse.md) | S2 | — | — |
| [`test-runner-std-path-shadowed-by-binary-tree-std.md`](./test-runner-std-path-shadowed-by-binary-tree-std.md) | S2 | — | — |
| [`yo-doc-renders-std-prelude-as-an-empty-module.md`](./yo-doc-renders-std-prelude-as-an-empty-module.md) | S3 | — | — |
| [`yo-doc-without-std-path-silently-emits-token-only-docs.md`](./yo-doc-without-std-path-silently-emits-token-only-docs.md) | S3 | open | — |
| [`yo-fmt-walks-gitignored-generated-files.md`](./yo-fmt-walks-gitignored-generated-files.md) | S3 | — | — |

### Self-hosting legacy (12)

| Doc | Severity | Status (self-reported) | Repro |
| --- | --- | --- | --- |
| [`desugar-token-clones-evaluator-regression.md`](./desugar-token-clones-evaluator-regression.md) | S3 | — | — |
| [`self-hosted-emit-leaks-remaining-classes.md`](./self-hosted-emit-leaks-remaining-classes.md) | S1 | — | — |
| [`yo-self-collections-batch-residuals.md`](./yo-self-collections-batch-residuals.md) | S1 | — | yes |
| [`yo-self-compile-performance-rc-string-eq.md`](./yo-self-compile-performance-rc-string-eq.md) | S3 | — | — |
| [`yo-self-ctfe-nested-fn-analysis-gap.md`](./yo-self-ctfe-nested-fn-analysis-gap.md) | S2 | — | — |
| [`yo-self-dup-eval-inside-macro-generated-body-corrupts-module-eval.md`](./yo-self-dup-eval-inside-macro-generated-body-corrupts-module-eval.md) | S2 | SIDESTEPPED for Stage 0 (fix direction 2 belo | — |
| [`yo-self-rc-depth-cap-skips-deep-teardown.md`](./yo-self-rc-depth-cap-skips-deep-teardown.md) | S1 | — | yes |
| [`yo-self-rc-teardown-not-factored-into-dispose.md`](./yo-self-rc-teardown-not-factored-into-dispose.md) | S3 | — | — |
| [`yo-self-test-runner-cannot-run-wasm-batches.md`](./yo-self-test-runner-cannot-run-wasm-batches.md) | S2 | — | — |
| [`yo-self-unwired-port-gaps.md`](./yo-self-unwired-port-gaps.md) | S3 | — | — |
| [`yo-self-where-clause-full-enforcement.md`](./yo-self-where-clause-full-enforcement.md) | S2 | partially implemented (marker-trait subset li | — |
| [`yoself-missing-compiling-with-print.md`](./yoself-missing-compiling-with-print.md) | S3 | — | — |

### Vendor (markdown_yo) (3)

| Doc | Severity | Status (self-reported) | Repro |
| --- | --- | --- | --- |
| [`vendor-markdown-punycode-encode-reads-past-the-buffer.md`](./vendor-markdown-punycode-encode-reads-past-the-buffer.md) | S1 | OPEN (upstream — `vendor/markdown_yo`, submod | — |
| [`vendor-markdown-shared-utf8-codec-has-no-callers.md`](./vendor-markdown-shared-utf8-codec-has-no-callers.md) | S3 | OPEN (upstream — `vendor/markdown_yo`, submod | — |
| [`vendor-markdown-truncated-utf8-aliases-a-valid-link-label.md`](./vendor-markdown-truncated-utf8-aliases-a-valid-link-label.md) | S2 | OPEN (upstream — `vendor/markdown_yo`, submod | — |

### Other (26)

| Doc | Severity | Status (self-reported) | Repro |
| --- | --- | --- | --- |
| [`a-generic-instantiated-over-a-dyn-cannot-cross-a-module-boundary.md`](./a-generic-instantiated-over-a-dyn-cannot-cross-a-module-boundary.md) | S1 | open | — |
| [`a-wrong-cli-golden-reached-develop-between-two-gates.md`](./a-wrong-cli-golden-reached-develop-between-two-gates.md) | S3 | OPEN | — |
| [`an-assignments-old-value-save-reads-uninitialized-memory-for-pod-types.md`](./an-assignments-old-value-save-reads-uninitialized-memory-for-pod-types.md) | S1 | — | — |
| [`an-escaped-task-leaks-references-to-values-it-bound.md`](./an-escaped-task-leaks-references-to-values-it-bound.md) | S2 | OPEN (measured; not yet diagnosed) | yes |
| [`an-inherent-associated-constant-does-not-resolve-as-an-array-length.md`](./an-inherent-associated-constant-does-not-resolve-as-an-array-length.md) | S2 | OPEN | — |
| [`an-integer-literal-on-the-left-of-a-runtime-operand-is-rejected.md`](./an-integer-literal-on-the-left-of-a-runtime-operand-is-rejected.md) | S2 | OPEN | yes |
| [`an-owning-join-handle-costs-an-allocation-per-spawn.md`](./an-owning-join-handle-costs-an-allocation-per-spawn.md) | S3 | — | — |
| [`defining-a-deep-struct-dag-is-exponential.md`](./defining-a-deep-struct-dag-is-exponential.md) | S3 | OPEN (filed 2026-09-29) | — |
| [`five-cli-goldens-are-stale-against-the-current-compiler.md`](./five-cli-goldens-are-stale-against-the-current-compiler.md) | S3 | — | — |
| [`join-handle-ownership-waits-for-the-seed.md`](./join-handle-ownership-waits-for-the-seed.md) | S1 | OPEN — tracker for a two-step landing forced | yes |
| [`live-tls-test-treats-a-dns-outage-as-a-backend-regression.md`](./live-tls-test-treats-a-dns-outage-as-a-backend-regression.md) | S3 | open — | — |
| [`lsp-memory-grows-per-open-edit-close-round.md`](./lsp-memory-grows-per-open-edit-close-round.md) | S2 | — | — |
| [`own-param-leaks-when-a-conditional-return-is-not-taken.md`](./own-param-leaks-when-a-conditional-return-is-not-taken.md) | S1 | OPEN | yes |
| [`parser-accepts-an-unclosed-call-paren.md`](./parser-accepts-an-unclosed-call-paren.md) | S2 | — | yes |
| [`ref-joinhandle-rewrites-left-value-shape-emitters-linux-stage1-red.md`](./ref-joinhandle-rewrites-left-value-shape-emitters-linux-stage1-red.md) | — | — | — |
| [`refined-param-signatures-emit-malformed-c.md`](./refined-param-signatures-emit-malformed-c.md) | S2 | — | — |
| [`statement-level-io-spawn-leaks-the-state-machine.md`](./statement-level-io-spawn-leaks-the-state-machine.md) | S1 | — | yes |
| [`tier1-check-std-now-requires-a-z3-solver.md`](./tier1-check-std-now-requires-a-z3-solver.md) | S3 | — | — |
| [`unused-variable-warning-for-a-forward-declared-comptime-fn-used-only-in-a-body.md`](./unused-variable-warning-for-a-forward-declared-comptime-fn-used-only-in-a-body.md) | S3 | OPEN | — |
| [`verifier-contracted-generic-fn-is-silently-unverified.md`](./verifier-contracted-generic-fn-is-silently-unverified.md) | S2 | — | — |
| [`verifier-loop-variant-obligations-are-signed-for-unsigned-measures.md`](./verifier-loop-variant-obligations-are-signed-for-unsigned-measures.md) | S2 | open | — |
| [`warm-compile-selfcheck.md`](./warm-compile-selfcheck.md) | S3 | — | — |
| [`windows-dir-state-mutex-is-reinitialized-and-deleted-per-loop-but-the-list-is-process-global.md`](./windows-dir-state-mutex-is-reinitialized-and-deleted-per-loop-but-the-list-is-process-global.md) | S1 | — | — |
| [`windows-process-handle-list-is-an-unlocked-process-global.md`](./windows-process-handle-list-is-an-unlocked-process-global.md) | S1 | — | — |
| [`yo-build-artifact-cache-serves-a-stale-binary.md`](./yo-build-artifact-cache-serves-a-stale-binary.md) | S1 | OPEN | — |
| [`yo-test-silently-drops-all-but-the-last-path.md`](./yo-test-silently-drops-all-but-the-last-path.md) | S2 | — | — |
