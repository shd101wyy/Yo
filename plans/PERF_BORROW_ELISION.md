# Perf: cutting RC traffic in the self-compile (the 55→15 min arc)

_Status: IN PROGRESS. Measurements + method:
`issues/yo-self-compile-performance-rc-string-eq.md`._

> **2026-08-08 — the attribution table below is STALE; re-profile before
> picking a lever.** Lever 1 (`== String.from(x)`) has LANDED: only 29
> sites remain, all cold (`asm.yo` inline assembly + two per-binding
> `__yo_self` checks), and `ast_expr_is_fn_call_of` now compares
> `tok.value == func_name` directly. A fresh `sample` profile of the
> self-hosted `check ./std` showed the hotspot had moved entirely to
> **type-key construction**, which the two entries under "Landed" below
> address. Use `sample <pid>` on a running `check ./std` — it gives
> function-level attribution with no rebuild, and it is what found both.

## Problem

A single `check ./std` (86 s) performs **10.8 billion `__yo_decr_rc` and
9.2 billion `__yo_incr_rc` calls** — ~20 billion RC ops to type-check
153 files. That traffic, not per-call cost, is the self-compile's
runtime.

## Two premises from the first draft of this plan were WRONG

1. **"The corpus diff-test enforces identical C between the two
   emitters."** It does not — `scripts/diff-test.sh` judges _run
   behavior_ ("Equivalence is judged by RUN BEHAVIOR, never C-text
   equality"). The two emitters already differ structurally: the TS
   emit wraps drops in 4,435 `always_inline` `___drop` functions
   (256,772 calls), while yo-self emits `__yo_decr_rc` directly at
   254,824 sites. The binding constraints are behavior parity, test
   counts, and STRICT_FIXPOINT (stage2 ≡ stage3) — which each emitter
   satisfies independently. A prelude/codegen change in one compiler
   alone is therefore fixpoint-safe; both should still be changed to
   keep the port faithful.
2. **"Call arguments are where the dups are."** They are not — an
   argument to a non-owning parameter already gets no dup
   (`helper.ts:411` gates on `parameter.isOwningTheRcValue`). The dups
   were on **match scrutinees**.

## Measure before optimizing — the cheap loop

The clang step of a self-compile is only ~46 s; the ~55 min is entirely
evaluator/codegen runtime. So runtime-level hypotheses can be tested by
patching the already-emitted `.c` and re-clanging (~2 min/experiment),
with no 10-min s1 rebuild. Harnesses in `scratchpad/`:
`patch_decr_rc.py`, `patch_rc_counters.py`, `patch_rc_attrib.py`,
`perf_ab.sh`, `guardmalloc_corpus.sh`.

## Landed / measured

### 1. Match-place dup elision — the big one

`match.ts` evaluated an _atom_ scrutinee directly but wrapped every
other scrutinee in an implicit `begin()`, materializing an owning temp:
`___dup` before the switch, `___drop` after. A field read is a **place**
— already owned by the enclosing scope for the whole match, with arms
that only borrow it.

Fix: widen the predicate from "atom" to "place" (a bare 2-arg `.` chain
rooted at a **runtime** variable). Routing places through the same path
as atoms reuses every already-proven downstream ownership decision
instead of inventing a new elision rule. The root must be runtime:
`Kind.Func` is also a 2-arg dot but has no `variableName` to bind.

Attribution before the fix (share of 10.8e9 decrements):

| share | est. calls | site                                        |
| ----- | ---------- | ------------------------------------------- |
| 33.2% | 3.59e9     | `String ==`                                 |
| 17.5% | 1.89e9     | `ast_expr_is_fn_call_of`                    |
| 9.6%  | 1.04e9     | `ast_expr_is_atom_of`                       |
| 13.9% | 1.50e9     | `_attach_early_return_only_drop_to_returns` |

Effect: `String ==` 4 dups + 4 drops → **0**, in both the repro and the
real yo-self emit.

### 2. Negative result — inlining `decr_rc` is NOT the lever

`always_inline` fast path + outlined slow path measured **-4.7%** only
(86.21 → 82.15 s min user, 3 reps) for **+140% binary size**
(4.8 → 11.6 MB). Not worth landing on its own.

### 3. Type-interning cycle guard: linear scan → hash set (2026-08-08)

`_intern_key_into`'s `visited` set (`yo-self/types/intern.yo`) was an
`ArrayList(String)` probed by linear scan, costing O(visited) full String
comparisons per named type on every key render — and `substitute` re-keys
the whole subtree at each recursion level. It was the **top of the
profile**: `_contains` 3731 samples + `_platform_memcmp` 1562, ahead of
`__yo_decr_rc` (3099).

Swapped for `HashSet(String)`. The membership question is identical, so
the rendered keys are unchanged — proven directly: **25 corpus programs
emit BYTE-IDENTICAL C** before and after.

Effect: `check ./std` 45.14 s → 37.10 s (**-17.8%**), and `__yo_decr_rc`
itself fell 3099 → 1373 samples (the probes were the RC traffic).

### 4. `StringBuilder.write_string`: per-byte push → bulk copy (2026-08-08)

`write_string` appended byte-at-a-time through `ArrayList(u8).push` (each
byte paying a bounds check, an Option match and a capacity test) while its
sibling `write_str` already bulk-copied via `extend_from_ptr`. After
lever 3, `ArrayList(u8).push` was the new top user-code entry (2778).

Effect (interleaved A/B, 5 reps each): min 37.22 s → 35.66 s (**-4.2%**);
4 of 5 runs beat every baseline run. Note the occasional slow outlier —
the two paths allocate in different size sequences (an empty buffer takes
exactly `n` via `ensure_total_capacity`, where `push` starts at 4 and
doubles), which moves GC collection points around.

## Remaining levers, in attribution order

1. ~~**`== String.from(x)` in yo-self hot paths** (177 sites)~~ — **LANDED**
   (see the status banner). 29 cold sites remain, not worth touching.
2. **`_attach_early_return_only_drop_to_returns`** — a recursive AST walk
   run per begin block. Now 333 samples (~1.3%), well below its old 13.9%
   billing, but the algorithmic fix is clear and still worth doing: the M3
   driver (`yo-self/evaluator/exprs/begin.yo`) walks the WHOLE block tree
   once per eligible consumed variable — O(vars x tree) — and synthesizes
   AND evaluates a `___drop` expr per variable BEFORE knowing whether the
   block contains any return/unwind at all. Walk once to collect the
   return/unwind nodes, then test each variable against that small list;
   and short-circuit blocks with no early exits before generating anything.
3. **1.64e9 frees per `check ./std`** — allocation churn itself. String
   interning / small-string optimization is the structural answer, and
   the largest remaining item after the above.

## Hard constraints (unchanged)

- Full gate battery per change; revert on ANY regression.
- **Memory-safety gate per change** — elision bugs are use-after-frees
  and are silent otherwise. NOTE: **AddressSanitizer does not work on
  this machine.** `yo-cli` detects it and silently skips the sanitizer
  (`compiler-utils.ts:96 asanRuntimeIsUsable`), so an
  `--sanitize address` run is VACUOUS — it compiles and passes without
  any instrumentation. Verified by hand: both nix clang 21.1.7 and
  Apple clang 17 produce ASan binaries that hang (`rc=124`) on a
  `int main(void){return 0;}` probe. Use instead:
  - `scratchpad/guardmalloc_corpus.sh` — Guard Malloc
    (`DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib` + `--allocator
libc`), the working ASan substitute here. Proven to FAIL on planted
    bugs: use-after-free read → SIGSEGV (139), double free → SIGABRT
    (134). `MallocScribble` was tried first and does NOT work on this
    macOS allocator (a UAF read still returned live data) — don't build
    a gate on it.
  - `YO_SELF_BIN=<pre-change s1> scripts/diff-test.sh
tests/codegen-bootstrap --release` — compares the CHANGED emitter's
    behavior against the UNCHANGED one over 140 programs, so any
    behavior drift the change introduced shows up as DIFF.
- Port each landed change to the other compiler to keep yo-self faithful.
- Measure with `scratchpad/perf_ab.sh <base> <new> 3` on a quiet box
  (`check ./std`, ~86 s baseline), plus one full stage2 emit for any
  tier claiming victory.
