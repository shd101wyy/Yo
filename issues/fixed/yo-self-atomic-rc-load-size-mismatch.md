# yo-self: atomic `rc()` load cast to `size_t` instead of `uint32_t` (FIXED 2026-08-05)

**Found 2026-08-05** from CI run 31011003610, tier-1 gates, battery file
`tests/imm_string.test.yo`. It had been failing since the `-luring` fix stopped masking
it, and it is the reason `imm_string` reported `rc=1 hollow=0` with **no test summary**
at all.

## Symptom

```
tests/.yo_selftest_batch_1.bin.c:6317:9: warning: misaligned atomic operation may incur
  significant performance penalty; the expected alignment (8 bytes) exceeds the actual
  alignment (4 bytes) [-Watomic-alignment]
 6317 |   if (((atomic_load_explicit((_Atomic size_t*)&((__yo_ref_header_t*)(self))->ref_count,
                                     memory_order_acquire)) == (1ULL))) {
…
/usr/bin/ld: /tmp/-1453e6.o: in function `yo_id_5228':
  undefined reference to `__atomic_load_8'          (×3, one per emitted site)
clang: error: linker command failed with exit code 1
yo-self: error: compile: C compiler failed (exit 256) on tests/.yo_selftest_batch_1.bin.c
yo-self: error: test: batch compile failed (exit 256) for tests/.yo_selftest_batch_1.yo
```

The runner throws at `yo-self/main.yo:1598`, which is **before** the summary print at
`:1639` — hence a failing file with no `N passed` line. `hollow=0` is consistent: the C
was emitted fine, it just would not compile.

## Root cause

`generate_rc_call` (`yo-self/codegen/exprs/rc_fns.yo:393`) emitted

```rust
atomic_load_explicit((_Atomic size_t*)&((__yo_ref_header_t*)(x))->ref_count, memory_order_acquire)
```

where TS (`src/codegen/exprs/rc-fns.ts:549`, the ground truth) emits `(_Atomic uint32_t*)`.

`__yo_ref_header_t` is identical in both compilers:

```c
typedef struct __yo_ref_header_t {
  uint32_t ref_count;     // offset 0, 4 bytes
  uint16_t type_id;       // offset 4
  uint16_t borrow_count;  // offset 6
} __yo_ref_header_t;
```

So casting `&header->ref_count` to `_Atomic size_t*` (8 bytes) is wrong twice over:

1. **It fails to link on Linux.** The address is only 4-byte aligned, so clang cannot
   inline a lock-free 8-byte atomic and emits an out-of-line `__atomic_load_8`. That
   symbol lives in libatomic, which the driver does not link, so the batch dies at link
   time. macOS resolves it from its own runtime — which is exactly why every local run and
   every macOS CI job was green.
2. **It reads the wrong value everywhere.** An 8-byte load at offset 0 returns
   `ref_count | (type_id << 32) | (borrow_count << 48)`, so `rc(self) == 1` is false
   whenever `type_id != 0`. Every copy-on-write uniqueness check in `std/imm/*` therefore
   evaluated false under the self-hosted compiler. That is behaviourally _safe_ — the CoW
   path just always copies — which is the second reason nothing caught it. It also means
   those fast paths have never actually executed in a self-hosted build.

This was the **only** such divergence: every other `ref_count` atomic cast in yo-self
(`yo-self/codegen/functions/gc_runtime.yo:263,270,405,412`) was already `uint32_t`. The
`__yo_atomic_load_size_t` / `__yo_atomic_store_size_t` / `__yo_atomic_exchange_size_t`
helpers in `yo-self/codegen/types/generation.yo:505-515` are legitimate — TS has the
identical helpers for user-level atomic `size_t` operations, which really are 8 bytes.

## Verification

Cross-emitting the actual test batch for `aarch64-linux-gnu` (no Linux host needed —
`--target` is enough to select the platform templates) makes the fix checkable locally:

| check                                                            | before   | after                       |
| ---------------------------------------------------------------- | -------- | --------------------------- |
| `atomic_load_explicit((_Atomic uint32_t*)` in the Linux emission | 0        | **3** (matches TS)          |
| `atomic_load_explicit((_Atomic size_t*)` on ref_count            | 3        | **0**                       |
| all five ref_count atomic sites vs TS                            | 3 differ | **byte-for-byte identical** |

Because the CoW checks now actually fire, the affected files were re-run under the
rebuilt stage-1: `imm_string` 28/28, `imm_list` 16/16, `arc` 15/15, `rc` 18/18.
`check ./yo-self` 238/238, battery 20/20 hollow=0, corpus PASS 155 DIFF 0,
`check ./std` 153/153, **FIXPOINT_HOLDS**.

## How it was found, and the gate change that made it findable

The tier-1 battery redirects each file's output to `/tmp/${P}_${name}.log`, which CI does
not upload — so the failure read as a bare `FAIL: battery imm_string rc=1` with no way to
tell a clang error from a timeout from a failed assertion. `gates_fast.sh` now dumps the
failing gate's log.

The first version of that dump only tailed the log, which was not enough: a single failing
test among 116 prints its `✗` hundreds of lines before the summary, so the tail showed
nothing but passing tests. It now greps the whole log for failure markers (`✗`, `error:`,
`undefined reference`, `Memory leak`, `SIGSEGV`, `SIGABRT`, `panic`) with line numbers
**and** prints the tail. That is still the open lead for the remaining tier-1 failure,
`async_await` (115/116 on Linux, 116/116 on macOS).

## Lesson

A platform-specific link error can hide behind a _warning_ that names the real bug. The
`-Watomic-alignment` warning was present in the same clang invocation and stated the
alignment mismatch outright. Read the warnings above a link failure before theorising —
and `--target <triple> --emit-c` lets you diff platform-specific emission against TS
without owning that platform.
