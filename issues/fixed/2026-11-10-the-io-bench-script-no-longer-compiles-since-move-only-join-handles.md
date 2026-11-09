# `scripts/bench/io_bench.yo` no longer compiles: `hs(k).await(io)` copies a move-only `JoinHandle`

**Severity:** S3. The I/O-budgets CI job runs `scripts/bench-io-backends.sh`
(Yo vs libuv) as a `continue-on-error` step, so the failure was silent: the
release and merge gates are unaffected, the backend comparison table is not
produced.

Found 2026-11-10 (coordinator, from the I/O-budgets job log).

## Reproduction

```text
$ YO=<tree yo> YO_STD=./std bash scripts/bench-io-backends.sh
error[E0901]: ... cannot copy `hs(k)`, whose type `JoinHandle(i32)` is move-only ...
  --> scripts/bench/io_bench.yo:114:14
  |
114 |     if(match(hs(k).await(io), .Some(b) => (b != i32(0)), .None => true), {
```

## Cause

`await` consumes its handle, and a `JoinHandle` is move-only (the owning
handle landed 2026-10-02, #1093; reading a move-only element out of a list by
value is E0901 under decision 17/26). The script awaited the handles in
place through the list, which was a copy of the handle before the language
rejected that. No gate compiles `scripts/bench/*.yo` (`check-embedded-yo.sh`
covers only here-documents), so nothing noticed.

## Fix

The handles are moved out of the list to be awaited: `while(hs.len() > 0)`
with `match(hs.pop(), .Some(h) => ...)`. `YO=<tree yo> YO_STD=./std bash
scripts/bench-io-backends.sh` compiles and runs both backends again (the
table prints; on a loaded box the `timer` row can fall below its floor, which
is a machine-dependent ratchet and not a CI gate).

## Found while checking the other scripts

Two more Yo programs under `scripts/` that no gate compiles are stale in the
same way, filed separately and not fixed here:
`issues/2026-11-10-two-async-vs-libuv-bench-programs-no-longer-compile.md`.
