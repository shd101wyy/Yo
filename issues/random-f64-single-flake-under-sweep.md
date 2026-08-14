# One-shot failure of `random_f64 in range 0 to 1` under a hollow sweep (macOS, unreproduced)

**Status: OPEN (observation; 13 reruns clean).** 2026-08-14, during P2.5
Group B's sweep: `tests/crypto/random.test.yo` went RED once —
`✗ random_f64 in range 0 to 1` / exit 6 — under `/tmp/yo-gb3` (the Group B
binary). 3 targeted + 5 full-file + 5 sweep-context reruns all green.

Why it is strange on macOS: the entropy path is `arc4random_buf` (cannot
fail, cannot short-read), and `f64(random_u64()) / f64(u64::MAX)` cannot
leave [0,1] (both convert to 2^64). The test's exception handler also
asserts, so ANY thrown CryptoError lands in the same ✗ — but no macOS throw
path exists. Candidates: a latent batch-context miscompile (the batch binary
differs from the standalone one), or memory corruption elsewhere in the
batch. The runner now captures child output; a recurrence will show WHICH
assert fired on the line after "Test failed with exit code" (run with -v for
the full message).

**What the investigation DID find and fix (same commit):** the Linux
`getrandom` arm accepted SHORT READS silently — the tail of the buffer kept
its zero initialization (biased bytes from a "successful" call) — and threw
`Unavailable` on a transient EINTR. Now loops until full and retries EINTR
(getrandom(2) semantics). Not the macOS flake's cause, but a real bug the
flake pointed at.

Next occurrence: keep the batch (`YO_KEEP_BATCH=1`), diff the batch binary's
random paths against standalone, and capture the exact assert message.
