# The escape path drops the result temp of the call that unwound

**Found 2026-08-06.** Root cause of the two Linux-x86_64 `parser.test.yo` SEGVs that
were the last thing keeping `continue-on-error: true` on `compiler-internal-tests`.
Investigated as `issues/fixed/parser-multiline-arrow-rhs-linux-segv.md` — a bug in the
**TypeScript** compiler's codegen, mirrored into `yo-self`.

## Symptom

```
AddressSanitizer:DEADLYSIGNAL
==5388==ERROR: AddressSanitizer: SEGV on unknown address 0x7f0d79bff6c0
              (pc 0x7f0d79bff6c0 bp 0x7f0d79bd5f10 sp 0x7f0d79bd5e48 T1)
==5388==Hint: PC is at a non-executable region. Maybe a wild jump?
    #0 0x7f0d79bff6c0  (<unknown module>)
    #1 … in fn_yoc01ec268_id_168_parse_primary_end
```

Linux x86_64 only. `tests/internal/parser.test.yo` is **49/49 on macOS arm64**, and the
same job's self-hosted arm is 826/826 on the same Linux runner.

## What the emitted C actually does

`yo-self/parser.yo:1261` calls `exn.throw(...)` in **value position** (a `cond` arm whose
type is `ParseResult`). The handler in the test is `(err) -> { unwind(()); }`.

```c
ParseResult _temp_61956 = ((ParseResult (*)(__yo_dyn_ba9487de67))exn.throw)(_temp_61955);
if (__yo_effect_escaped) {
  // Drop local variables before early return
  …
  // Drop consumed variables (unwind propagation)
  fn_yodb87f9d4_id_21___drop((ParseResult)(_temp_61956));   // <-- drops a NEVER-ASSIGNED temp
  return (ParseResult){0};
}
```

The handler unwound, so it **never returned a value**. `_temp_61956` therefore holds
whatever the ABI left in the return registers, and the escape path calls `___drop` on it.
`ParseResult.___drop` recurses into its `AstExpr*` field, so the garbage word is
dereferenced and ultimately called through.

`_temp_61956`'s drop was elided from the normal path because it is _consumed by the return
value_ — that is precisely what puts it on `consumedVarPendingDrops`, and that list is
replayed at every escape point, including the escape of the very call that produced it.

## Why macOS passed and Linux crashed

The declared type of the handler is `void` (it unwinds, so codegen gives it no return
value), while each call site casts `exn.throw` to whatever the surrounding expression
needs. The garbage in the return registers is therefore ABI-dependent:

- On **Linux x86_64** the registers happened to hold **an address inside
  `parse_primary_end`'s own stack frame**. The drop read it as an `AstExpr*` and the code
  ultimately jumped through it.
- On **macOS arm64** they happened to hold something benign, which is why
  `tests/internal/parser.test.yo` was 49/49 locally throughout.

**What exactly leaves that stack address in the return registers is NOT established, and the
fix does not depend on it.** An earlier draft of this document claimed it was the
destination pointer that x86_64 SysV leaves in RAX after a MEMORY-class (sret) return, from
the preceding `String` `+` concatenations. **That is wrong:** `String` is
`Option(ArrayList(u8))`, emitted as `{tag; union{ArrayList(u8)* value;}}` = **exactly 16
bytes**, which SysV classifies as INTEGER,INTEGER and returns in `RAX:RDX` — no hidden
pointer is involved. Other candidates at `-O0` + ASan (an internal `memcpy`, which returns
its destination; a drop helper returning a pointer) were not pinned down. What _is_ measured
is that the value is deterministic and that it is a stack address:

- across three CI runs the faulting `pc` was `0x7f0d79bff6c0`, `0x7ff9919ff6c0`,
  `0x7f2c335ff6c0` — different ASLR bases, **identical low 20 bits**;
- `pc - sp == 0x29878`, byte-identical across both runs of the `?=` test, and a different
  constant for the other test;
- `pc > sp` with a frame that is tens of KB wide at `-O0` + ASan, so the target lies inside
  the crashing function's own frame.

And `pc == the faulting address` with "PC is at a non-executable region" means an
instruction fetch, i.e. a call through a data pointer — a deterministic offset into a live
frame, not random heap garbage.

The stack trace blames `parse_primary_end` directly rather than a drop helper because
`___drop`/`___dispose` are `__attribute__((always_inline))`.

## The fix

At every escape check, exclude the escaping call's **own** result temp from both drop
sets. Nothing leaks by skipping it: the callee never produced a value.

- `src/codegen/exprs/return.ts` — new trailing `escapedCallResultCName` parameter on
  `generatePendingDeferredDrops` and `generateConsumedVarDropsForEscape`, filtering on
  `getDeferredDropTargetCName` (the identifier the drop actually emits, not the atom name).
- `src/codegen/exprs/other-fn-call.ts` — `emitEffectUnwindCheck` derives it from
  `expr.$?.variableName`, which covers every caller in one place; the two escape sites that
  emit their own check (the direct-call and handler-installation paths) pass `tempVar`.
- `yo-self/codegen/exprs/return.yo` — the mirror: `_drop_targets_escaped_result` plus the
  same trailing parameter threaded through all 14 call sites.

Note `other-fn-call.ts:3168` already zero-initialized its temp before a void-returning
call, so the hazard was half-known in the codebase.

## Verification

Measured on the emitted C of `tests/internal/parser.test.yo` (11 s to rebuild — this batch
does not pull in the evaluator):

| gate                                                         | before | after |
| ------------------------------------------------------------ | ------ | ----- |
| `exn.throw` sites dropping their own unwound result temp     | 16     | **0** |
| ALL escape-checked call sites dropping their own result temp | 16/515 | **0** |

Minimal reproducer of the shape (an RC-typed value consumed by the return value, thrown
from a `cond` arm) — see the `get_list` case in the regression test added to
`tests/algebraic_effects.test.yo`.

### Could excluding the temp LEAK instead?

Only if the temp already held a live owned value at the escape check. `other-fn-call.ts`
guards its declaration with `if (!declaredTempVars.has(tempVar))` while the escape check is
emitted _outside_ that guard, so in principle a second emission could reach the check with
a stale value in the temp.

Audited against the largest Yo program available — the whole self-hosted compiler's stage-2
C (`/tmp/escfix_stage2.c`, 17146 escape checks):

| shape                                                           | count     |
| --------------------------------------------------------------- | --------- |
| escape checks immediately preceded by their own temp assignment | **15390** |
| …of those, preceded by a _stale_ (non-fresh) assignment         | **0**     |
| escape checks after a void statement call (no temp declared)    | 1756      |

So every assignment-preceded check has its own fresh assignment on the line directly above,
and for the void calls the exclusion is a no-op (temp names are per-expression, so there is
nothing else named that could be skipped). The leak path does not occur in practice.

**Caveat on local evidence:** LeakSanitizer is Linux-only, so no macOS run — including the
2657-test fast suite — can detect a leak regression. The `compiler-internal-tests` job on
Linux, which runs every test binary under ASan/LSan, is the arbiter for that.

## Honest limitation of the regression test

The added `.yo` test **does not fail pre-fix on macOS arm64** — the garbage left in X0/X1
there is benign, which is the whole reason this bug survived every local run. Its value is
that it exercises the shape under ASan on Linux x86_64 in CI, where it does fail pre-fix.
The deterministic, platform-independent gate is the emitted-C check in the table above.

## Related

- `issues/fixed/parser-multiline-arrow-rhs-linux-segv.md` — the investigation, including the
  hypotheses ruled out by measurement (stack exhaustion refuted with a 1 MB stack,
  `-masm=intel`, uninitialized reads via `-Wconditional-uninitialized`).
- **Still open, separate:** the `void`-handler-through-a-value-returning-cast mismatch is
  itself latent UB. It is harmless for return types of ≤16 bytes (returned in registers),
  but a `ctl` whose `ResumeType` is a **larger** struct would make the caller pass an sret
  pointer in RDI and shift every argument, so the handler would read the sret pointer as
  its `err` argument. Not reachable from the current corpus; filed as
  `issues/ctl-handler-void-signature-vs-sret-cast.md`.
