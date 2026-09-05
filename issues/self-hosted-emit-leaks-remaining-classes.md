# Self-hosted-emit leak debt: 50 corpus files fail LeakSanitizer (post sync-await fix)

**Status: OPEN — the map for the next RC campaign.** Measured 2026-08-14 on
PR #122 round 3 (Linux, functional ASan), AFTER the sync-await future leak
fix (`issues/fixed/sync-await-future-never-dropped.md`) cleared 29 of the
original 79 files.

## How this surfaced

P2.5 Group B ported TS's test-runner LeakSanitizer verdicts (a leaking test
FAILS even at exit 0 — test-runner.ts:835-843). TS-emitted binaries pass;
self-hosted-emitted binaries leak across 50 corpus files. The debt is
INVISIBLE on the macOS dev box (ASan cannot arm there — the compile-side
probe skips it), so Linux CI is the only detector.

## Interim state (the staging ratchet)

The verdict default stays ON (TS parity). The two self-hosted CI jobs
(tier-1 gates + hollow sweep in `.github/workflows/test.yml`) set
`YO_TEST_LEAK_VERDICT=0`: ASan/LSan still run and REPORT, but a leak alone
does not fail the test there. **Deleting those two env lines is the
campaign's finishing flip.** Everything else (TS legs, local runs, user
invocations) keeps full verdicts.

## Known classes

- `closure_capture_rc_leak.test.yo` is IN the list — the closure-capture
  class has a dedicated test that presumably asserts the balance the emitter
  does not yet keep under LSan.
- The sync-await FUTURE class is FIXED; awaits inside state machines and
  closure/effect captures are the prime remaining suspects (async_await
  still fails with only a subset passing — per-construct leaks beyond the
  top-level future).
- `plans/backlog/RC_POLICY_MECHANISM_SPLIT.md` and the RC-completion
  priority notes are the architectural map; memory-note
  `empty-string-drop-fallback-class` records the drop-lowering fallback trap
  (audit every `true => ""` in drop/dup lowerings first — that class is
  silent by construction).
- **The `own`-param-of-a-generic class is FIXED (2026-09-05,
  `issues/fixed/dyn-box-dispose-is-emitted-with-an-empty-body.md`).** The
  callee-side binding of an `own(name) : T` parameter was not marked owning at
  the CALL-TIME binders, and a `generic(...)` function defers its body eval —
  so every such parameter lost its scope-end drop while the body's store kept
  its `___dup`. `box` is one, and `dyn(value_type)` / `AnyError` go through it,
  so this leaked on every boxed payload and every thrown error with a
  String/struct/enum payload. Several of the 50 files below should clear; the
  Linux LeakSanitizer verdict is the only way to confirm which.

## The 50 files (PR #122 round-3 sweep, results.txt verbatim paths)

- tests/algebraic_effects.test.yo
- tests/arc.test.yo
- tests/async_await.test.yo
- tests/bootstrap_verification.test.yo
- tests/cli/arg_parser.test.yo
- tests/closure.test.yo
- tests/closure_capture_rc_leak.test.yo
- tests/closure_param_forwarding.test.yo
- tests/collection_literals.test.yo
- tests/collections/hash_map.test.yo
- tests/derive.test.yo
- tests/dyn.test.yo
- tests/encoding/base64.test.yo
- tests/encoding/hex.test.yo
- tests/error.test.yo
- tests/fn.test.yo
- tests/fs/dir.test.yo
- tests/fs/file.test.yo
- tests/fs/fs_convenience.test.yo
- tests/fs/metadata.test.yo
- tests/fs/temp.test.yo
- tests/fs/walker.test.yo
- tests/gc_cleanup_exit.test.yo
- tests/http/http.test.yo
- tests/imm_map.test.yo
- tests/imm_set.test.yo
- tests/imm_sorted_map.test.yo
- tests/imm_sorted_set.test.yo
- tests/imm_string.test.yo
- tests/imm_threading.test.yo
- tests/imm_vec.test.yo
- tests/impl.test.yo
- tests/iterator_combinators.test.yo
- tests/net/addr.test.yo
- tests/net/dns.test.yo
- tests/net/tcp.test.yo
- tests/net/udp.test.yo
- tests/option_result_combinators.test.yo
- tests/process/command.test.yo
- tests/rc.test.yo
- tests/ref_field_borrow.test.yo
- tests/regex/regex.test.yo
- tests/sync/atomic.test.yo
- tests/sync/channel.test.yo
- tests/sync/once.test.yo
- tests/sync/rwlock.test.yo
- tests/sync/waitgroup.test.yo
- tests/sys/bufio.test.yo
- tests/sys/timer.test.yo
- tests/toml/toml.test.yo
