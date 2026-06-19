# Phase 6 (self-host fixpoint): stage-2 self-compile crashes on the full self-source

## Status

OPEN (2026-06-19). Phase 5 is DONE (parallelism keystone + Thread.spawn work
end-to-end, corpus 76/76, commit 88d060546). Phase 6's first step — the stage-2
self-compile (`yo-self-bin compile yo-self/main.yo`) — crashes before producing C.

## Symptom

- `YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin compile yo-self/main.yo` (the -O0 binary):
  rc=138 (SIGBUS), ZERO output.
- `YO_MAIN_STACK_MB=16384 ... check yo-self/main.yo` (-O0, eval-only, 16 GB stack):
  rc=138, zero output → the crash is in EVAL/module-load of the full self-source,
  not codegen-specific.
- `YO_MAIN_STACK_MB=8192 /tmp/yo-self-rel compile yo-self/main.yo` (the **--release**
  binary, -O2 small frames): STILL rc=138, zero output.

## Key conclusion: NOT (just) deep-recursion stack exhaustion

CLAUDE.md attributes the rc=139/138 deep-recursion crash to -O0 multi-MB frames and
prescribes `--release` (LLVM stack coloring, ~100× smaller frames → 1000s of levels).
Here the **--release binary crashes identically** (rc=138, 8 GB stack), so it is NOT
stack depth — it is a GENUINE crash (null/misaligned access, or a memory/resource
limit manifesting as SIGBUS) triggered by loading+evaluating the ENTIRE self-source
graph in one process. (The --release binary is otherwise healthy: it compiles +
runs the spawn repro → `thread sees 42` / `main done`.)

Note `check ./yo-self` (Phase-3 milestone, 227/227) checks each file in ISOLATION;
`check yo-self/main.yo` loads main + ALL transitive imports together — the harsher
unified load is what crashes.

## lldb backtrace (2026-06-19) — pinned to `get_specialized` frame

`lldb -b -o run -o bt -- /tmp/yo-self-rel compile yo-self/main.yo`:
```
thread #2, stop reason = EXC_BAD_ACCESS (code=2, address=0x300003ff0)
frame #0: fn_yo51ba7706_id_121_get_specialized_T_TypeValue_Self_ArrayList_(enum(Unit,BoolT,Void,Str,Int(...),Float(...),...,Pointer(Box(enum(...))),Array(Box(enum(...)),length,length_var))...)  +4
->  stp x24, x23, [sp, #0x10]   ; (function PROLOGUE — store to the stack)
```
The fault is a WRITE (code=2) at a stack-pointer-relative store in the function
PROLOGUE → a STACK OVERFLOW, in `get_specialized` specialized over the GIANT nested
`TypeValue` enum (the `Self` = `ArrayList(enum(... the whole TypeValue ...))`). It
runs on thread #2 (the `__yo_main_stack` worker that runs `main`; YO_MAIN_STACK_MB
applies to it), yet 8 GB overflowed at --release — so this is NOT ordinary
deep-recursion-with-small-frames. Likely cause: `get_specialized`'s frame holds the
giant `TypeValue`/`ArrayList(enum…)` BY VALUE (a multi-KB+ frame even at -O2), and it
recurses over the deeply self-referential `TypeValue` (`Box(enum(...Box(enum...)))`),
so a moderate depth × giant frame blows the stack — OR it is genuine unbounded
recursion in `get_specialized` for this self-referential type. NOTE: `get_specialized`
(types/...:id_121, the `Type.get_specialized` method) is unrelated to the closure work
— this is a pre-existing self-compile gap surfaced by the harshest input.

## Diagnosis directions (next session)

0. Pin whether it's unbounded vs deep-but-finite. ATTEMPTED: `lldb bt 200` shows only
   frame #0 — lldb cannot unwind past the overflowing prologue (the frame isn't
   established), so depth is hidden. Next: set a breakpoint on `..._get_specialized`
   with a counter, or instrument the Yo `get_specialized` source with a depth guard
   that panics at N to confirm recursion. Inspect the `Type.get_specialized` source
   (types/...:id_121, a generic method specialized over the self-referential
   `TypeValue` enum): look for (a) a missing cycle/base case when recursing the
   self-referential type, and (b) the giant `TypeValue`/`ArrayList(enum…)` passed/
   returned BY VALUE (multi-KB frames) — box it / pass by ref to shrink frames.
   8 GB overflowing at --release points to deep-or-unbounded recursion over the
   self-referential type, OR giant frames × moderate depth.

1. The empty output is the main obstacle. Force-flush / run under a debugger:
   - `lldb -- /tmp/yo-self-rel compile yo-self/main.yo` → backtrace at the SIGBUS;
     `MallocStackLogging=1` / `MallocScribble=1` if it's a heap/UAF.
   - Check Console.app / `~/Library/Logs/DiagnosticReports` for the crash report
     (signal, faulting address, frame).
2. Bisect by input size: `check` progressively larger SUBSETS of the import graph
   (e.g. a driver that imports only lexer+token+parser, then + evaluator, then +
   codegen) to find the module/threshold that triggers it. Distinguishes
   memory-pressure-scales-with-size from a specific-module bug.
3. Rule out OOM/mmap: watch RSS during the run; if it balloons then SIGBUS, it is
   memory pressure (SIGBUS from a failed lazy page-in), not a logic bug.
4. If a specific construct: minimize to a standalone repro (the usual issues/
   workflow) and fix the evaluator/loader.

## UPDATE — 32 GB stack → OOM-kill (rc=137): NOT fixable by more stack

`YO_MAIN_STACK_MB=32768 /tmp/yo-self-rel compile yo-self/main.yo`: rc=137 (SIGKILL =
OS OOM-kill). So at 8 GB it stack-overflows (rc=138) and at 32 GB it exhausts RAM
before finishing → the recursion is pathologically deep (or unbounded). More stack is
NOT the fix.

The crash frame (`get_specialized` = the SPECIALIZED `ArrayList.get`; C comment:
`(ArrayList(u8)) fn(self, index) -> Option(u8)`) is `ArrayList(TypeValue).get →
Option(TypeValue)` — `Option(TypeValue)` is returned BY VALUE, and `TypeValue` is the
huge self-referential enum, so each such frame is large. `get` itself isn't recursive;
it's just where the already-near-exhausted stack tips over during a deep evaluator
recursion (lldb couldn't unwind the caller chain past the overflow).

Important contrast: `check ./yo-self` (Phase-3, 227/227) checks each file in ISOLATION
and is fine; `check`/`compile yo-self/main.yo` loads main + ALL transitive imports in
ONE evaluation, and THAT unified eval recurses deeply enough to exhaust 32 GB. This
smells like either (a) a missing memoization/cycle-guard so a shared self-referential
type (TypeValue) is re-descended combinatorially in the unified load, or (b) a genuine
unbounded recursion triggered only by the full graph, or (c) just-too-deep × the giant
`TypeValue`-by-value frame cost.

### Refined fix directions
1. Determine bounded-vs-unbounded: instrument the hot evaluator recursion (or
   `ArrayList(TypeValue).get`'s caller) with a depth counter that panics at e.g. 5000
   — a panic with a clean Yo stack trace shows the recursive cycle; no panic before
   OOM = genuinely deep, not a single tight loop.
2. Shrink the per-frame cost: `TypeValue` is large + returned/passed by value in
   hot recursive paths (e.g. `Option(TypeValue)` returns, `clone`, `match` temps).
   Boxing more of TypeValue (or returning `*(TypeValue)` in the hottest helpers)
   cuts frame size ~Nx and may bring depth back under a sane stack.
3. Add memoization/cycle-guards to whatever traverses the self-referential TypeValue
   in the unified load (mirrors the substitute() / type_contains cycle guards already
   added elsewhere this port).

### UPDATE — scales with unified-load size (not main.yo-specific)

`YO_MAIN_STACK_MB=4096 /tmp/yo-self-rel check yo-self/codegen/codegen_c.yo` (a large
SUBGRAPH — the whole codegen + evaluator, less main's full graph) ALSO crashes rc=138,
0 "evaluator OK". So the deep recursion is NOT a single main.yo-only construct — it
triggers on any sufficiently large unified load and scales with graph/type count. Small
isolated files (`check ./yo-self` per-file, 227/227) are fine. → strongly favors a
combinatorial re-descent of shared self-referential types (missing memoization in a
type-traversal run per-module during the unified load) and/or genuinely-deep def-time
body-eval recursion across the full call graph, amplified by the giant
`TypeValue`-by-value frame cost. The fix is frame-size reduction (box TypeValue in hot
paths) + memoization/visited-guards on the type traversal, not more stack.

### UPDATE — rebuild-free diagnostics exhausted (both lldb directions blocked)

- `lldb bt` cannot unwind past frame #0 (the overflow faults at the prologue before
  the frame/FP chain is established).
- `lldb memory read -f A -c 8000 $sp` returns only ~21 entries — reading UP the stack
  from `$sp` immediately hits the guard page / unmapped region (the deep frames are in
  the exhausted area), so the repeating-return-address scan can't see the recursion.

So pinning the EXACT recursive function needs depth instrumentation, and a naive
global counter is unreliable here: the def-eval-wall unwinds frequently (trial-eval
swallow), and `unwind` skips a decrement-on-exit → the count leaks upward across many
shallow evals and gives false depth. A correct probe must save/restore depth across
BOTH normal return AND the unwind handler (e.g. in `_evaluate_expression_wrapper`
_expr.yo:898, the per-call exn handler restores `g_eval_depth = saved` before
`unwind`). With that, panic-at-N (on the descent) prints the recursive expr/construct.
Alternatively, address the SYMPTOM: shrink the per-frame cost by boxing/`*(TypeValue)`
in the hottest type helpers (e.g. `Option(TypeValue)` returns) so the same depth fits
— but TypeValue is pervasive, so that is a large, carefully-validated change.

## Why this matters

This is the gate for the whole Phase-6 fixpoint (stage-2 → stage-3 ≡ stage-2) and
Phase 7 (revive yo-self/tests under the stage-2 binary). Per the plan, the stage-2
compile is EXPECTED to surface a wave of executing-mode gaps; this startup crash is
the first one and must be cleared before the wave is even visible.
