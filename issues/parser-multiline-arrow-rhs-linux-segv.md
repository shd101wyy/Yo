# Two Linux-only SEGVs in yo-self's parser on a multi-line parenthesized `->` RHS

**Found 2026-08-06** by CI run 31024333335, `Compiler internal tests`, TS arm — the first
run ever to reach these tests, because the job previously `--bail`ed on two earlier leaks
(both since fixed). **Pre-existing tests, pre-existing failures**; they were simply never
reached on Linux before.

Result of that run: **2 failures out of 826** in the TS arm, and the self-hosted
differential arm **826/826 green**.

## The two tests

`tests/internal/parser.test.yo`:

- `Parse ?= with multi-line parenthesized -> RHS` (`:669`)
- `Parse colon : with multi-line parenthesized -> RHS in struct field` (`:688`)

Both parse a multi-line parenthesized `->`, e.g.

```rust
x ?= (
  (lhs, rhs) ->
    lhs + rhs
)
```

Both pass on macOS: a local run of `tests/internal/parser.test.yo` is **49/49**. The
single-line variants (`Parse ?= with parenthesized -> RHS` etc.) pass on Linux too — only
the multi-line forms crash.

## Symptom

```
AddressSanitizer:DEADLYSIGNAL
==5396==ERROR: AddressSanitizer: SEGV on unknown address 0x7f92837ff6c0
              (pc 0x7f92837ff6c0 bp 0x7f92837d5f10 sp 0x7f92837d5e48 T1)
==5396==The signal is caused by a READ memory access.
==5396==Hint: PC is at a non-executable region. Maybe a wild jump?
    #1 fn_yoc01ec268_id_168_parse_primary_end
    #2 fn_yoc01ec268_id_171_parse_expression
    #3 fn_yoc01ec268_id_150_parse_paren_expr
    #4 fn_yoc01ec268_id_165_parse_primary
    #5 fn_yoc01ec268_id_171_parse_expression
    #6 fn_yoc01ec268_id_168_parse_primary_end
    #7 fn_yoc01ec268_id_171_parse_expression
    #8 fn_yoc01ec268_id_174_do_parse
    #9 fn_yoc01ec268_id_177_get_program
   #10 fn_yoc01ec268_id_511_parse
   #11 __yo_user_main
   #12 __yo_main_thread_entry
```

`pc == the faulting address`, and that address sits inside T1's stack region (sp is
0x7f92837d5e48, ~0x29878 below pc). So control jumped into the stack: either a corrupted
return address or a call through a garbage function pointer. Module `yoc01ec268` is
`yo-self/parser.yo`.

## Context that matters

1. **Test binaries are compiled at `-O0`** (`src/test-runner.ts:604`,
   `isEmcc ? "-O2" : "-O0"`). `AGENTS.md` documents this configuration as crash-prone for
   deep recursion: at `-O0` clang gives every temporary its own stack slot, so large
   yo-self functions get multi-MB frames. ASan inflates them further.
2. **The stack reserve is macOS-only.** `src/test-runner.ts:629-639` adds
   `-Wl,-stack_size,0x10000000` (256 MB) guarded by `process.platform === "darwin"`;
   Windows gets `-Wl,/STACK:16777216` (16 MB); **Linux gets neither.** The comment there
   explains why it was needed — "the `evaluate` function has ~2482 local variables that
   consume ~1.5 MB of stack space per frame (at -O0, no stack-frame reuse)" — a reason that
   applies equally to Linux.
3. The Yo program runs `main` on a worker thread whose stack comes from `__yo_main_stack`
   (1 GiB default, overridable by `YO_MAIN_STACK_MB`). The crash is on T1, that worker.
4. The `compiler-internal-tests` job set `YO_MAIN_STACK_MB: "4096"` on the **self-hosted**
   arm but not on the TS arm — an inconsistency between two arms running the same 58 files.

## First action taken

Set `YO_MAIN_STACK_MB: "4096"` on the TS arm too, for parity with the self-hosted arm.
`AGENTS.md` names exactly this as the remedy for `-O0` deep-recursion crashes ("keep the
fast `-O0` loop and bump the stack: `YO_MAIN_STACK_MB=4096`").

**UPDATE — the stack hypothesis is REFUTED.** Measured locally: the parser batch was run at
every one of its 49 test indices with `YO_MAIN_STACK_MB=1`, i.e. a **1 MB** worker stack, and
all 49 still pass. The env var is honoured without clamping
(`src/codegen/functions/generation.ts:1048-1055` only checks `> 0`), so the probe was not
vacuous. The parser's recursion for this input therefore needs well under 1 MB and cannot be
exhausting a 1 GiB stack on Linux.

So `YO_MAIN_STACK_MB=4096` on the TS arm will almost certainly NOT fix these crashes. It is
kept only because it removes a real inconsistency between the job's two arms; it should not
be described as a fix. The signature agrees: a wild jump is an instruction fetch from a
non-executable address, whereas stack exhaustion faults on a write to the guard page and ASan
reports `stack-overflow` explicitly.

## If that does not fix it

The alternative lead is a **call through a garbage function pointer**. Both tests build an
`Exception` whose `throw` field is a closure:

```rust
exn := Exception(throw : ((err) -> { unwind(()); }));
prog := parse(`…`, `test.yo`, exn);
```

If the parser takes an error path and calls `exn.throw` through the effect record, a bad
function pointer would produce precisely this wild jump. That would connect to the
effect-record/evidence handling the async audit already flagged. Note the multi-line input
is exactly the case most likely to hit a parser error path that the single-line form does
not.

Next concrete steps, in order:

1. Read the run's artifacts / add a print to confirm whether the parse _errors_ before
   crashing (i.e. whether `exn.throw` is reached at all).
2. Emit the batch C for `tests/internal/parser.test.yo` targeting `x86_64-linux-gnu` and
   inspect `parse_primary_end`'s call through the effect record — note `--target` must
   match the host architecture, so this needs an x86_64 host or a careful read of the
   arm64-linux emission instead.
3. Bisect the input: the single-line variants pass, so shrink the multi-line form until it
   stops crashing.

### A third lead: `-masm=intel` is applied per translation unit, x86_64 only

`src/test-runner.ts:641` adds `-masm=intel` to the whole batch TU when
`moduleManager.needsIntelAsmSyntax` is set. That flag is x86_64-relevant only, so it is
inactive on the arm64 macOS runs that pass. Several modules in a `parser.test.yo` batch
contain inline asm — `yo-self/expr.yo` (which the test imports for `AstExpr`) and
`std/prelude.yo` among them. If two asm blocks in one TU assume different dialects, applying
`-masm=intel` globally mis-assembles one of them, and a mis-assembled block is a
straightforward way to get a wild jump.

Caveat, stated because the same trap caught earlier hypotheses in this session: the crash is
_inside_ `parse_primary_end`, and none of those asm blocks live there — so this only works if
a mis-assembled global-asm definition is being called. Confirm before acting.

### The asymmetry that most narrows it

The **self-hosted** arm of this same job passes all 826 tests, `parser.test.yo` included. So
yo-self-compiled-by-yo-self is fine on Linux x86_64 and yo-self-compiled-by-TS crashes. That
points at the TS compiler's x86_64 emission (or the TS-only test-runner flags above) rather
than at `yo-self/parser.yo` itself.

Reproducing needs Linux x86_64; there is no local Linux (Docker was declined), so this is
CI-bisection work rather than local debugging.

## Why this was invisible until now

`compiler-internal-tests` ran with `--bail` until 2026-08-06, so it never got past the
first failing test. Two leaks were fixed in front of these
(`issues/fixed/ref-enum-unit-variant-inline-construction-leak.md`,
`issues/fixed/module-global-c-name-collision-leak.md`) before the job reached
`parser.test.yo`. Removing `--bail` is what surfaced them, and is why the job now reports
its full scorecard in one run.
