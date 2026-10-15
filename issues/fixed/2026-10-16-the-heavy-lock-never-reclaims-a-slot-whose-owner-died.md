# The heavy lock never reclaims a slot whose owner died

**Severity:** S3 — developer tooling: after a reboot (or a `kill -9` of a holder) every later `heavy_take` waits forever, until someone deletes the `.heavy-lock*` directories by hand.

Found 2026-10-16 when the development machine rebooted in the middle of a gate run.

## Symptom

`scripts/heavy-lock.sh` prunes a queue ticket whose pid is dead, but a held slot directory (`.heavy-lock`, `.heavy-lock-b`, …) is removed only by its owner's `heavy_drop`. A holder that dies without running its `EXIT` trap — a reboot, `kill -9`, an OOM kill — leaves its slot behind. After the reboot, twelve slot directories from one dead `exclusive` holder stayed, and 22 queued tickets would have waited forever: the slots counted as held, and their owner line still said `[EXCLUSIVE]`, which blocks every admission.

## Fix

The slot scan in `heavy_take` reclaims an orphaned slot before counting it (`_heavy_slot_orphaned`): the owner line's pid is not running (`kill -0` fails), or the slot directory is older than the machine's boot time (`/proc/stat` `btime` on Linux, `sysctl kern.boottime` on macOS), which covers a pid that the reboot reused for an unrelated process. A slot without an owner line yet (between its `mkdir` and the owner write) and the old one-slot loop's slot 0 (no owner file) are never judged orphaned.

## Test

`scripts/heavy-lock-test.sh` scenario 8: one slot owned by a pid that has exited, one owned by a live pid but dated 2000-01-01; with `HEAVY_SLOTS=2`, two jobs must run at once. With develop's script the scenario never finishes (the test is killed by its timeout); with the fix it passes.

`.github/instructions/testing.instructions.md` ("The heavy lock") now says a dead holder is reclaimed, instead of telling the reader to delete its directory by hand.
