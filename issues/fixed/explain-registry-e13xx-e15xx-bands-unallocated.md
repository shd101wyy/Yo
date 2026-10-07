# The diagnostics registry's E13xx/E15xx bands are still unallocated — install/fetch failures and ICEs remain uncoded prose

**Severity:** S3 — whole failure families (the dependency toolchain, internal
compiler errors) surface as uncoded prose an agent cannot route on; the
registry audit that named the bands closed without allocating them.

**Status: FIXED (2026-10-04, branch `s3/batch-0-fixes`).** See "Fixed" below.

## Symptom

```
$ yo install            # (network down)
yo: error: install: failed to fetch shd101wyy/yo-net: …    # no E-code
```

Install/fetch/lock failures and the ICE wrapper print human prose with no
`error[Exxxx]`, so `--error-format json` carries no code for them, `yo
explain` has nothing to point at, and an agent's error router (retry vs
report vs fix) has to string-match.

## Root cause (narrowed, not fixed)

The classifier (`src/error.yo`) allocates codes at raise sites it knows;
the install/fetch family raises through a different path (`src/fetch.yo`,
`src/install_command.yo`, `src/lock_file.yo`) that never goes through the
coded-diagnostic stash, and the ICE wrapper wraps with a bare string.

## Fix direction

Allocate the reserved bands (E15xx for the CLI/build/deps family first —
it is what agents hit on fresh clones), starting with the five most
common install failures (network, missing manifest, lock mismatch, store
corruption, version-not-found), each with a registry entry carrying
`bad`/`good` examples (the §3.3 test harness already compiles every
registry example —
`tests/internal/diagnostics_registry_examples.test.yo`). E13xx (codegen)
afterwards. No consumer asked — until one did: this issue.

## Fixed

**Fixed 2026-10-04, branch `s3/batch-0-fixes`.** The E13xx and E15xx bands
are allocated and their first consumers routed through them.
`src/diagnostics.yo` defines `E1301` (the ICE wrapper) and `E1501`–`E1505`
(fetch failed, missing manifest, lock mismatch, store integrity, no matching
version), each with a full bilingual registry entry
(`src/diagnostics_registry.yo` whose examples are command and manifest
transcripts — the band is exempt in the examples harness because none of its
codes is raised by the evaluator). Root cause as suspected: the install/fetch
family raised through `dyn("Error: …")` strings that bypassed the coded
diagnostic pipeline, and `codegen_fatal` wrapped with a bare string. A new
`format_coded_error(code, message)` (`src/error.yo`) builds the span-less
coded `YoError`; `src/fetch.yo`, `src/resolver.yo`, `src/install_command.yo`
and `codegen_fatal` (`src/codegen/constants.yo`) raise it, so `yo install`
prints `error[EXXXX]` with the `yo explain` tail and `--error-format json`
and `sarif` carry the code. Tests: `tests/internal/error.test.yo` (the
helper, the ICE code — both failed before the fix: the band constants did
not exist), `tests/internal/diagnostics_registry.test.yo` (band allocation),
`tests/internal/resolver.test.yo` (E1501/E1503 through `resolve_and_fetch`),
`tests/internal/install_command.test.yo` (E1502). Cli goldens updated:
`explain-list` and `lock-locked-no-lock` re-recorded;
`install-offline-empty-cache`'s golden and keep-pattern hand-edited with the
same one-line `Error: ` → `error[E1501]: ` swap because the case cannot run
on Windows (the store lives under `%LOCALAPPDATA%`, outside the harness's
sandbox `HOME`, and the `<PROJ>` substitution needs POSIX path spelling).
The audit note (`plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` §3.3) is
updated, and `docs/en-US/ERROR_DIAGNOSTICS.md` + `docs/zh-CN/ERROR_DIAGNOSTICS.md`
document the bands.
