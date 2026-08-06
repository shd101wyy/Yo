> **RETIRED (2026-08-06).** Superseded record — 2026-06-15 snapshot of 58 SIGBUS std files; `check ./std` has been 153/153 green since the campaign completed.

# yo-self `check ./<heavy-std-file>` SIGBUS (rc=138, zero output)

**Status:** OPEN — pre-existing, untriaged. Surfaced (not caused) while validating
the return-body specialization fix.

## Symptom

Running the self-hosted compiler `check` on ~58 heavy, generic-heavy std files
crashes with SIGBUS (exit code 138) and **zero stdout/stderr** (buffered output
lost on crash):

```
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./std/collections/hash_map.yo
# rc=138, no output
```

Affected (sample): `std/collections/{hash_map,btree_map,linked_list,ordered_map,
priority_queue}`, `std/sys/*`, `std/net/*`, `std/fs/*`, `std/imm/*`,
`std/crypto/*`, `std/encoding/{json,base64,...}`, `std/http/*`, `std/process/*`,
`std/time/{datetime,instant}`, `std/url/index`. (Full list: the 58 in the std
per-file sweep.) Lighter files (e.g. `std/path.yo`,
`std/collections/array_list.yo`) check clean.

The TS reference checks all of these cleanly.

## What it is NOT

- **Not** the deep-comptime-recursion stack-exhaustion class (CLAUDE.md). That
  one is rc=139 (SIGSEGV) and is fixed by `--release` (LLVM stack coloring) or a
  bigger `YO_MAIN_STACK_MB`. This is rc=138 (SIGBUS) and:
  - `YO_MAIN_STACK_MB=16384` does **not** help,
  - a **`--release` -O2** self-bin still SIGBUSes identically.
- **Not** a regression from the return-body fix: the crash set is byte-identical
  on the pre-fix baseline binary and the post-fix binary.

## Next steps (not yet done)

- Reproduce under `lldb` (`MallocStackLogging` / `gmalloc`) to capture the crash
  frame — SIGBUS often = misaligned/bad pointer access, not stack.
- Minimize: find the smallest construct shared by the heavy files (likely a
  specific generic-container specialization or comptime path) that triggers it.
- Compare the failing eval path against the TS reference at the crash site.
