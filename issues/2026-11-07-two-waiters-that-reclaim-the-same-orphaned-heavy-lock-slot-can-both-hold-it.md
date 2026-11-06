# Two waiters that reclaim the same orphaned heavy-lock slot can both hold it

**Severity:** S3 — two jobs run in one slot, oversubscribing the machine the
lock exists to protect. It happens only when a slot's owner died and two
waiters reclaim that slot in the same poll window. No data is lost.

Found 2026-11-07 on the `fix/borrowed-for-over-mut-param-with-fn-slot` lane
(`scripts/heavy-lock.sh` at develop 142a2f972, last changed in dd9ca178c).

## What happened

A build took a slot from inside a `( … heavy_take …; heavy_drop ) &`
subshell launched by a command that returned at once. `$$` in a subshell is
the PARENT shell's pid, so the owner line named the parent, which exited
immediately. The slot was then correctly judged orphaned
(`_heavy_slot_orphaned`: the pid is gone) while the build kept running. That
first part was a caller error, and the testing-instructions bullet on `$$`
now warns about it.

Two new waiters, started a few milliseconds apart, then both reclaimed that
same slot. Afterwards slot `e`'s owner file read:

```
forfix-early: check src+std, started 02:57 (pid 1090829)
 1090831)
```

Each waiter returned from `heavy_take` believing it held slot `e`, and only
one owner line survived. A third job later took a free slot as usual, so the
machine ran one more heavy job than the slot count allowed.

## Mechanism

The bytes pin the interleaving. The second line is the last 10 bytes of the
67-byte line `forfix-early: targeted language tests, started 02:57 (pid 1090831)`
after the 57-byte line of pid 1090829 overwrote its start, so both processes
wrote the same `owner` inode:

1. Both waiters scan, find slot `e` orphaned (dead pid), and decide to
   `rm -rf` it.
2. Waiter A (1090831): `rm -rf e`, then `mkdir e` succeeds.
3. Waiter B (1090829) acts on its earlier, now stale, verdict: `rm -rf e`
   deletes A's fresh claim. Then `mkdir e` succeeds, and B opens `e/owner`
   (create, truncate).
4. A opens `e/owner`. The path now resolves to B's file, the same inode.
5. A writes its 67 bytes, then B writes its 57 bytes at offset 0.

The orphan verdict and the `rm -rf` in `heavy_take`'s slot scan are two steps,
and nothing stops a stale verdict from deleting a claim made in between.
`mkdir` remains atomic, but here two `mkdir`s each succeed, because the second
waiter's `rm -rf` sits between them.

## Fix direction

Make reclamation atomic per claim. One way: rename the orphaned directory to a
unique tombstone (`mv "$dir" "$dir.reclaim.$$"`, which is atomic), re-read the
tombstone's owner, and delete it only if that owner is the dead pid the
verdict named; otherwise rename it back. Another: re-check the owner line
inside the claim. A claimant that finds its own `(pid $$)` replaced after the
write lost the race and keeps waiting.

## Test

The test lands with the fix: a `scripts/heavy-lock-test.sh` case that plants
an orphaned slot and starts two waiters at once must see them in different
slots.
