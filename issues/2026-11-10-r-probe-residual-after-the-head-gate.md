# `check src/main.yo` still makes 12.4e9 allocation calls after R-PROBE's reference lookups are gated by head

**Severity:** S2. A compiler-performance cost, no wrong result: the allocation count is 77% above the 6.99e9 baseline of develop `fe58873dd`.

Found 2026-11-10 measuring `vbd/rprobe-gate` (VERDICTS-50): A (develop `30e1411cd`) 16,198,306,101, B (the head / blanket-method gate) 12,381,196,693.
The gate removes 3.82e9 calls. VERDICTS-50 expected the rest to be #1876's borrowed-`for` lowering (tens to low hundreds of millions at most), so about
5.3e9 calls are unexplained: the "B not within ~10% of C" second finding of its section 1 (C, `ad6f8cf5c`, was not measured).

## Hypothesis (from reading, not measured)

The gate is on the receiver's HEAD, and since #1876 every std collection (`ArrayList`, `Deque`, `HashMap`, `HashSet`, `BTreeMap`, `OrderedMap`,
`PriorityQueue`) has a reference impl (`IntoIterator`), so the head is noted for the hottest receivers in the compiler and every method call on them
(`len`, `get`, `push`, ...) still runs both reference lookups, with fresh `t_reference` types the generic-impl cache's identity front cannot hit. Likewise
the bare-binder blanket method names (`clone`, `eq`, `cmp`, `hash`, `to_string`, ...) are common. A key of (head, method) in place of the head, taken from
the names the reference impl registers (trait defaults included), would skip them; `t_reference` interning is the other lever (VERDICTS-50 piece 3 note).

## Test

Measure with `scripts/bootstrap/eval_work_ratchet.sh` (libc stage-2, REPEAT=2); `YO_DEBUG_RPROBE_AUDIT=1` is the soundness check of any tighter gate. The ratchet
row `check_src_main_alloc_calls` is lowered by the fixing PR.
