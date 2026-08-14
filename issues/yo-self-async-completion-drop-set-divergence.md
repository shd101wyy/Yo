# yo-self async completion drops diverge from TS: leaked String temp + phantom never-written Option fields

**Status: OPEN** (found 2026-08-14 during the GATE 3 emit-diff hunt,
issues/fixed/seed-built-stage1-array-fill-method-miss.md).

Comparing the emitted `exists` (std/fs/file.yo:324) resume functions,
"Drop local variables before completion":

|                                         | TS                 | self                                                                                                                                                  |
| --------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cstr_bytes` (ArrayList)                | typed `___drop` fn | raw `__yo_decr_rc` (equivalent)                                                                                                                       |
| String temp (`path.to_string()` result) | **dropped**        | **NOT dropped — leaked**                                                                                                                              |
| two `Option(ArrayList(u8))` temps       | not tracked at all | state fields emitted + payload-drops emitted, but the fields are **never written** anywhere — the drops are dead code (SM is memset-zeroed, tag=None) |

Two defects on the self side:

1. **Leak**: the `path.to_string()` String temp's deferred drop is missing
   from the completion drop set (TS emits it). One leaked String per
   `exists`/`is_file`/`is_dir` call. Likely a member of the 50-file
   leak-debt campaign (issues/self-hosted-emit-leaks-remaining-classes.md)
   — cross-reference when that campaign runs.
2. **Phantom state fields**: the self evaluator's deferred-drop set tracks
   two Option temps that have no assignment in the emitted machine — the
   struct fields and drop switches are emitted from drop expressions whose
   defining stores were elided (consumed/moved through `.unwrap()`?). Dead
   code today (zeroed SM ⇒ tag=None ⇒ no decr), but it means the drop
   scheduler and the store elider disagree about which temps exist — the
   same disagreement in a machine whose fields are ever REUSED (slot
   aliasing) would decrement garbage.

Repro: scratchpad fsprobe emit-diff (see the GATE 3 issue's method
section).
