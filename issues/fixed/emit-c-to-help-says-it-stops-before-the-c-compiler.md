# `yo compile --help` said `--emit-c-to` stops before the C compiler; it does not

**Status: FIXED 2026-09-25** (`plans/BUILD_ON_8GB_MACHINES.md` Phase 2 work).

## Symptom

`yo compile --help` (and its zh-CN twin) described the flag as:

```
  --emit-c-to <path>        Write the generated C to a file and stop
```

Running `yo compile src/main.yo --emit-c-to out.c` to measure the front half
of a compile went on to run the C compiler anyway: the process tree showed
`yo __cc-plan a.out.ccplan` and clang after the C was written, and an `a.out`
appeared.

## Root cause

The help text was wrong, not the behaviour. The argument parser in
`run_compile` (`src/main.yo`) documents the real contract: `--emit-c-to`
REDIRECTS the `<output>.c` sidecar ("so the C compiler consumes this same
path"), and `--skip-c-compiler` is the flag that stops after generation. The
warm self-check (`_warm_selfcheck`) and `scripts/make-portable-c.sh` rely on
that, passing both flags together. Only the one-line help entry, written with
the per-subcommand help in #239, claimed the flag stopped.

It misled a measurement: `plans/BUILD_ON_8GB_MACHINES.md` §0 labelled its
`--emit-c-to` row "stops before cc". The footprint figure there is the `yo`
process alone and stands; its wall time includes clang.

## Fix

The help line now reads `Write the generated C to <path> instead of
<output>.c` (zh-CN: `把生成的 C 写到 <path>，代替 <output>.c`), next to the
existing `--skip-c-compiler` entry that does stop. The `help-compile` CLI golden
records the corrected text.
