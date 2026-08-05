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

### DEAD LEAD: `-masm=intel` (measured, ruled out)

`src/test-runner.ts:641` adds `-masm=intel` to the whole batch TU when
`moduleManager.needsIntelAsmSyntax` is set. That flag is x86_64-relevant only, so it is
inactive on the arm64 macOS runs that pass. Several modules in a `parser.test.yo` batch
contain inline asm — `yo-self/expr.yo` (which the test imports for `AstExpr`) and
`std/prelude.yo` among them. If two asm blocks in one TU assume different dialects, applying
`-masm=intel` globally mis-assembles one of them, and a mis-assembled block is a
straightforward way to get a wild jump.

**Measured and ruled out.** The emitted batch C for `tests/internal/parser.test.yo` contains
**zero** inline asm blocks (`grep -c '__asm__|asm volatile|asm('` = 0), so
`needsIntelAsmSyntax` is false for this batch and there is nothing for `-masm=intel` to
mis-assemble. Kept here so nobody re-tests it.

### CONFIRMED BY CI: the stack change made no difference

Run 31035092248, with `YO_MAIN_STACK_MB=4096` now set on the TS arm, reports **exactly the
same two failures** — TS arm 824/826, self-hosted arm 826/826, no new failures anywhere. So
the local 1 MB-stack refutation was right and the env var is not the fix, as predicted. It
stays only as arm-to-arm parity.

This also establishes the scorecard as **stable**: two failures, both this bug, nothing else
hiding behind them.

### DEAD LEAD: an uninitialized read (measured, ruled out)

The most attractive theory for "identical code, passes on macOS, wild-jumps on Linux" is an
**uninitialized** local or field read as a function pointer — stack garbage that happens to
be benign on one platform. ASan does not catch that (MSan would, and MSan is Linux-only).

Ruled out as far as static analysis can: the test runner compiles with `-w` (all warnings
suppressed), so recompiling the batch C by hand with diagnostics on is free information:

```bash
clang -std=c11 -fno-strict-aliasing -fwrapv -O0 -fsyntax-only \
      -Wall -Wuninitialized -Wsometimes-uninitialized -Wconditional-uninitialized \
      <batch>.c
```

Result: **1801 warnings, ZERO of the uninitialized class** — and
`-Wconditional-uninitialized` is the aggressive one. The categories are all benign:
818 `unused-function`, 463 `unused-value`, 286 `unused-variable`, 158 `unused-label`,
27 `parentheses-equality`, 12 `switch`, 3 `void-ptr-dereference`, 3 `self-assign`,
2 `pointer-sign`. Notably **no function-pointer or calling-convention warnings**, which
also rules out a mismatched function-pointer cast (a real wild-jump mechanism on x86_64).

Caveat: clang's uninitialized analysis is intraprocedural and incomplete, so this lowers the
probability rather than eliminating it. Running the batch under **MSan on Linux** is the
decisive version of this test and is the single most promising next experiment.

### THE LEADING LEAD: a struct-size mismatch yielding a garbage function pointer

The async port audit independently found a bug with **exactly this signature** — a type whose
generated struct view is larger than the object actually allocated, so a field read past the
allocation returns a neighbouring block's bytes:

> `IoFuture` is typed as a 48-byte generic-Future-interface struct over the 32-byte
> `__yo_io_future_t` runtime object. Any path that reads offsets 32..47 through that pointer
> (`->__yo_resume_fn`, `->__yo_set_effect_fn`) reads 16 bytes past the allocation. On Linux
> that reads a neighbouring block's live `ref_count` as a function pointer — non-NULL, so the
> guard passes and the call goes through garbage; on macOS it may land in slack that reads 0
> and is silently skipped.

That is precisely a macOS-passes / Linux-wild-jumps shape, and it explains a `pc` landing
_inside the stack_: a garbage pointer, called. The audit judged that particular instance
unreachable from `tests/async_await.test.yo`, but the _mechanism_ is what to look for here.

Both failing parser tests pass an `Exception` whose `throw` field is a closure, and
`parse_primary_end` would call it through the effect record on a parse-error path. So the
concrete check is: **compare the emitted struct layout/size of the effect record at its
construction site against the view used where `parse_primary_end` calls `throw`**, and look
for a field read at an offset beyond the allocated size.

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

---

## RESOLVED 2026-08-06 — root cause found, and it was none of the leads above

The wild jump was **the escape path dropping the result temp of the call that unwound**.
`parse_primary_end` calls `exn.throw(...)` in value position; the handler unwinds, so the
result temp is never assigned; the `// Drop consumed variables (unwind propagation)` block
then calls `___drop` on it, dereferencing whatever the ABI left in the return registers.
On x86_64 that is the RAX left by the preceding sret-class `String` `+` call — the address
of a `parse_primary_end` stack local. `___drop` is `always_inline`, which is why the trace
blamed `parse_primary_end` with no drop frame.

Full analysis, the fix, and the before/after measurement (16 → 0 bad drops in this batch's
emitted C) are in `issues/fixed/escape-path-drops-unwound-call-result-temp.md`.

**The address arithmetic in this document was the decisive clue and was under-used at the
time.** Across three runs the faulting `pc` had identical low 20 bits and `pc - sp` was
byte-identical (`0x29878`) for repeats of the same test. A _deterministic offset into a live
frame_ rules out random heap/stack garbage and points straight at "a specific stack slot's
address is being called". Earlier passes read the symptom ("wild jump") but not the
arithmetic.

Also worth recording: the "self-hosted arm passes, TS arm crashes" asymmetry in
**§ The asymmetry that most narrows it** was **misleading**. It was read as evidence about
the TS compiler's x86_64 emission, but the self-hosted test runner adds **no sanitizer**
(`yo-self/main.yo`, `sanitize = ""`), and yo-self's drop sets are sparser, so the two arms
were never comparable on this. The real discriminator was macOS-arm64 vs Linux-x86_64,
i.e. AAPCS64's dedicated X8 result register vs SysV's RDI-consuming sret.

The `-Wconditional-uninitialized` sweep (1801 warnings, zero of that class) was a correct
result reported honestly, but it could not see this: the temp _is_ assigned, from a call
whose callee simply never wrote a return value. That is an inter-procedural,
ABI-level fact, invisible to clang's intraprocedural analysis — and MSan, named here as the
decisive next experiment, would have flagged it. The cheaper decisive tool turned out to be
reading the emitted C for the one indirect call in the crashing function.
