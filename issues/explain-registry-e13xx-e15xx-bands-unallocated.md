# The diagnostics registry's E13xx/E15xx bands are still unallocated — install/fetch failures and ICEs remain uncoded prose

**Severity:** S3 — whole failure families (the dependency toolchain, internal
compiler errors) surface as uncoded prose an agent cannot route on; the
registry audit that named the bands closed without allocating them.

**Status: OPEN.** Re-confirmed 2026-10-01 by the agent-loop audit: the
E13xx (codegen) and E15xx (CLI/build/deps) bands reserved by
`plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` §3.3 still have no codes,
and §3.3's own closing note ("NOT done: the E13xx/E15xx bands — no consumer
asked for them yet") has no tracking doc until this one.

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
