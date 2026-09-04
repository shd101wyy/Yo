# A ref-typed named local passed by value to a call misses its scope-end drop — the whole RC group leaks

**Status: OPEN — first fix attempt REVERTED 2026-09-04** (verified
**pre-existing** — reproduces identically on the P1 commit's code and on a
stage-1 built from pristine `origin/develop`). The root-cause diagnosis
(below) stands; the fix — idempotent drop flush + an unfiltered bare-tail
flush — broke the stage-2 self-compile with `use of undeclared identifier
'_file____home_temp_NNNN'` at drop sites: the flush system carries latent
never-declared temps whose names ARE registered in `declared_c_var_names`
(registration and C-text declaration diverge), so the `undeclared_temp`
gate cannot catch them once a new flush point exposes the list; and
removal-on-emit is unsafe while any emitter legitimately re-flushes one
node across ALTERNATIVE branch paths. A second attempt must gate the tail
flush on the `declared_scopes` liveness signal (real C-text declaration)
and keep branch-local re-emission intact. The revert commit on PR #400
carries the analysis.

## Reproducer

`issues/repros/ref-local-scope-drop-leak3.yo` (looped) /
`issues/repros/ref-local-scope-drop-leak6.yo` (single-shot):

```rust
diags := ArrayList(Diagnostic).new();
diags.push(Diagnostic(code : Option(String).None, /* … */));
err := YoError(diagnostics : diags);   // ref-struct ctor takes the list by value
s := err.to_string();
```

```bash
nix-shell shell.nix --run '~/.local/bin/yo compile tmp/leak6.yo --sanitize address --allocator system -o /tmp/leak6bin'
/tmp/leak6bin
# SUMMARY: AddressSanitizer: 578 byte(s) leaked in 8 allocation(s).
```

Per construction, exactly 8 allocations leak: the `ArrayList` header (the one
DIRECT root), its element buffer, the `Diagnostic`'s three `String`s (header +
data each) — i.e. **the entire `diags` group**. Looping ×100 leaks exactly ×100.

## Mechanism (read off the emitted C)

`__yo_user_main` emits scope-end drops for `s` (the render string), `err`
(`__yo_decr_rc((void*)(err))`), and the struct-literal temp's fields — but
**no `__yo_decr_rc((void*)(diags))`**. The `YoError` constructor call
(`__yo_new___yo_t16(diags)`) receives the list under the deferred-`___dup`
copy semantics (the +1 is there), so the refcount ends at 1 with both owners
gone: `err`'s drop releases the borrow-side reference and the original
binding's scope-end drop — the one that would take it to 0 — is never
emitted.

This is the `_optimize_dup_drop_pairs` / deferred-dup family
(AGENTS.md "a move … is manufactured by the dup/drop pair optimizer cancelling
that dup against the scope-end drop";
plans/backlog/RC_POLICY_MECHANISM_SPLIT.md): the cancellation analysis
apparently marks the local as consumed by an earlier value-passing call
(`diags.push(...)` also takes `self` by value) and then skips the scope-end
drop even though a LATER value use (`YoError(diagnostics : diags)`) emitted
its own `___dup`.

The same shape leaks in `suggest_code` in `src/diagnostics_registry.yo`
(`entries := registry_entries(); … entries.get(i)` — `get` takes `self` by
value), which is why `tests/internal/diagnostics_registry.test.yo`'s
suggestion test reports a leak, and why several
`tests/internal/error.test.yo` golden tests report leaks under LeakSanitizer
when compiled by the current seed/tree: the error-construction chain
(`ArrayList(Diagnostic)` → ref-struct `YoError`) is this pattern exactly.

## Evidence it is pre-existing

- Built against the **P1 commit's** `src/diagnostics.yo`/`src/error.yo`
  (`git show d2be247cb:…` into a scratch module dir): same 8-allocation leak.
- Compiled by a **stage-1 built from this tree** (`/tmp/yo-self-bin`): same
  leak — so the current codegen carries it, not just the v0.2.23 seed.
- The two `tests/internal/parser.test.yo` multibyte failures
  (issues/parser-multibyte-spec-tests-leak-under-linux-asan.md) are likely
  the same mechanism (small leaked groups in a spec-peel path).

## Why CI has not caught it

The compiler-internal-tests CI job is informational (non-gating), and the
leak is small per occurrence; nothing in the gating jobs constructs this
shape at runtime under LeakSanitizer.

## Suspended test coverage (2026-09-04)

Until the leak is fixed, these golden variants are suspended (they trip
LeakSanitizer per compiler generation and block the required internal
shards; each is restored with the fix):

- tests/internal/error.test.yo — "format_error_message multi-line message
  keeps continuation lines", "format_lexer_error renders like every other
  stage", "a coded diagnostic renders error[E0308] in both renderers"
- tests/internal/parser.test.yo — "make_parse_error renders via the shared
  renderer"
- tests/internal/diagnostics_registry.test.yo — "suggest_code finds near
  misses"

Two fix attempts were reverted (stage-2 undeclared temps; mimalloc
free-list corruption from double-emission — begin.yo's
_emit_deferred_drops emits without the removable path). A third attempt
must first unify every drop emitter onto the removal-on-emit discipline
(or prove no branch-alternative re-emission exists), per below.

## Fix direction

The scope-end drop attachment for ref-typed locals in
`src/codegen/exprs/begin.yo` (`_optimize_dup_drop_pairs`) needs the rule: a
deferred `___dup` emitted for ANY value-pass of a local obligates a scope-end
drop unless the optimizer can prove a cancellation — consumption by one
earlier value-call must not suppress the drop when a later use re-dups. A
regression test is `issues/repros/ref-local-scope-drop-leak6.yo` compiled
`--sanitize address` and run with an empty SUMMARY.
