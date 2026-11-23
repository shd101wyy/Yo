# The evaluator work ratchet fails after #2020: `invariant_origin_names` runs per `lend_through` argument

**Severity:** S3 — no wrong verdict or output; `check src/main.yo` made 27% more heap allocation calls, and develop's "Evaluator memory ratchet" job failed on every battery since #2020.

- Filed: 2026-11-23 (lane `evalwork-memo`, v0.2.80).
- Status: fixed by `fix/evalwork-invariant-memo`.

## Reproducer

The ratchet itself, by CI's method: the tree's stage 1 emits the stage-2 C of `src/main.yo`, `clang -O2 -I scripts/bootstrap/libc_mimalloc` rebuilds it on glibc malloc, and `REPEAT=1 bash scripts/bootstrap/eval_work_ratchet.sh <binary> <alloc_count.so>` counts the calls of `check src/main.yo`:

```text
check src/main.yo: 13522369200 allocation calls; baseline 10588125544, tolerance ±5%
FAIL: evaluator work regression — 13522369200 allocation calls > 11117531821 (baseline 10588125544 + 5%).
```

(develop battery 44866017559, `bb237b871`). Per-commit measurements put the whole step at #2020 (`7373bbbc3`): 10,671,053,059 at its parent `c36523d8e`, 13,572,945,216 at #2020.

## Root cause

#2020 made `lend_through`'s step 1 ask `invariant_origin_names(&slot)` for every argument of every non-std call whose slot carries an origin and is not `&mut`. The walk pairs the type with itself through every struct, enum and tuple, formats a `${id}:${under_mut}` key per visited nominal, and for every constructor type argument asks `_ctor_arg_is_invariant`, which cloned the constructor's whole `params` list, cloned the constructor and instance ids, and formatted a `${cid}:${i}` key. It ran from scratch at every call site of every function, across all CTFE.

A sampling allocation profile (a backtrace every 16381st allocation call, frames mapped to `.yo` lines through `--line-directives`) of the round-2 memo (`fecf7193a`, 12,371,841,525 calls) put 0.87e9 calls under `invariant_origin_names`, nearly all of them walks after a memo miss. Every other function #2020 added was below 0.001%. The same profile, diffed against `c36523d8e`, found two more costs:

- #2036's bare-binder blankets (`ToString(&T)`, `Hash(&T)`) make `reference_blanket_method_noted` true for `to_string` and `hash`, so R-PROBE runs the `&base` and `&mut base` lookups for every such call (+0.67e9).
- The generic-impl scan copied its bucket's owner list once per entry, 43% of all calls, before and after #2020 (`issues/fixed/2026-11-20-r7-value-records-raise-the-check-allocation-count-by-31-percent.md`). Most of the R-PROBE cost was this copy.

## Fix

- `invariant_origin_names` answers from an allocation-free pre-filter, `_may_reach_mut_reference`, when the type reaches no `&mut` reference. Every position the walk pairs starts covariant and turns invariant only below a `&mut` or at a constructor argument whose parameter the constructor's fields place below one, so such a type names nothing. The pre-filter answers `true` when unsure (depth 32, 512 nodes), so its `false` is exact.
- Other types are memoized by type identity (handles sorted by address, cleared when the type-key epoch moves), and `_ctor_param_name_at` reads one constructor parameter instead of cloning the list.
- `YO_DEBUG_INV_NAMES_MEMO_CHECK=1` re-walks every memo hit and every pre-filter answer and panics on a mismatch.
- The generic-impl scan reads one owner in place, only for a name-matching entry.

`check src/main.yo` now makes 7,191,229,721 allocation calls. The ratchet baseline was lowered to that count in the same PR.

## Test

The ratchet job is the test: it failed before (13,522,369,200 > 11,117,531,821) and passes after at the lowered baseline. Verdict identity: zero C emit-diff of `src/main.yo` against a develop-built binary, the origins corpus (G-A), `scripts/origins-unsound.sh` (G-B), the sink and totality audits, and `YO_DEBUG_INV_NAMES_MEMO_CHECK=1` over `check ./src` and `check ./std`.
