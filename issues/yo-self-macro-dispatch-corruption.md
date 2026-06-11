# yo-self: macro-call dispatch intermittently corrupts the heap

## Status

Macro DISPATCH (executing `if`/`try`/prelude macro bodies via
`evaluate_comptime_fn_call` and evaluating the expansion) is implemented in
`yo-self/evaluator/calls/function.yo`'s FuncVal arm but **gated off** behind
`MACRO_DISPATCH_ENABLED :: false` — with it on, heavy checks crash
intermittently (~20-60%) with `EXC_BREAKPOINT` inside system-malloc
freelist code at unrelated allocation sites (exit 133). The def-eval
propagation experiment patch flips the constant on (and tolerates the
flakiness by re-running).

Reproducer (with the constant flipped): `yo-self-bin check
yo-self/evaluator/exprs/open.yo` — 4.6s, ~50% crash rate. With dispatch
off: 10/10 stable. Macro REGISTRATION (the quoted-param/unquote-return
registry) stays on and is harmless.

## What was ruled out / fixed along the way

1. `continue` in the FuncVal-arm arg loop → restructured to if/else
   (fixed one crash cluster: tests/imm_threading, std/sys/bufio/buf_writer
   — 13/13 after).
2. Unquote splice sharing the env-bound ExprVal's AST → cloned
   (`builtins/quote.yo`) — reduced the rate, didn't eliminate.
3. Template sharing (expansions sharing the macro body's quoted template
   nodes) → template cloned per expansion — further reduction only.
4. Expansion sharing the CTFE result's tree → cloned — reduction only.
5. ExprInfo-table id aliasing (derived Clone keeps ids; gensym minted ALL
   atoms with id 0): added `clone_expr_fresh_ids` (the faithful TS
   `cloneExpr` mirror — TS clones create fresh objects = fresh `$` slots)
   and a shared `alloc_global_expr_id()`; gensym now mints real ids; trial
   dry-runs and all macro-path clones use fresh ids. These are correct and
   kept, but the crash rate did NOT go to zero (one measurement got worse,
   though rates between 20-60% are within run-to-run noise).

## What we know about the residual bug

- Corrupting WRITE is upstream of the detection point (always an innocent
  `ArrayList.new/with_capacity` inside the evaluator's own utility code).
- Macros OFF → 0 crashes across 13+ heavy runs. Macros ON → intermittent.
- ASan unusable on this machine (Nix clang vs Xcode ASan runtime mismatch;
  `--sanitize address` prints "Skipping sanitizer"); guard-malloc produced
  no report.
- Open question (also relevant to the TS C-emitter): does `Box.*`
  deref-copy / enum copy RETAIN interior Rc children? If not, every
  rebuild-from-deref in the expansion pipeline under-retains, and the
  observed behavior (more sharing → more crashes, clones reduce but reorder
  the problem) fits.

## Suggested attack (next session)

1. Build the TS-side minimal model first: a small `.yo` program whose
   compiled C runs a quote/unquote expansion pipeline in a loop (template
   - splice + expansion drop). The two simple repros tried (continue+String
     loop; enum+Box clone/copy loop) did NOT reproduce — the corruption needs
     the deref-copy + rebuild + drop pattern of `process_unquotes_in_expr`.
2. Inspect the EMITTED C for `process_unquotes_in_expr`'s rebuild: check
   whether `func_box.*` / `eb.*` copies emit `___dup` for Rc-owning
   children and whether the source temp's drop releases them.
3. Fix in `src/codegen` (likely the deref-copy/enum-copy retain rule or
   the temp-drop emission), add the repro to `tests/`, then flip
   `MACRO_DISPATCH_ENABLED` on permanently.

## UPDATE (2026-06-11): crash no longer reproduces — blocker is now FUNCTIONAL

With `MACRO_DISPATCH_ENABLED :: true` rebuilt post-slice-rework, the
reproducer (`yo-self-bin check yo-self/evaluator/exprs/open.yo`) ran
**0 crashes / 20 runs** (was ~50%). The related continue-in-while
corruption also no longer reproduces (0/52 on its original protocol —
issues/fixed/codegen-continue-in-while-heap-corruption.md).

However the check now FAILS functionally with dispatch on:

```
Error: Variable "comptime_str" not found.
Error: Variable "Option" not found.
```

i.e. executing macro bodies evaluates code in contexts where prelude /
builtin identifiers fail to resolve. Re-enabling dispatch is now blocked
on debugging these macro-execution environment gaps (part of the
executing-mode evaluation tail), not on heap corruption.

## UPDATE (2026-06-11, session 2): functional errors FIXED; corruption root-cause LOCALIZED

**Functional errors are gone.** After the yo-self type-model alignment
(TypeValue.Str, Slice deletion, slice_copy rewrite — commit 49f51b35), a
dispatch-ON build passes: the macro probes, the historical reproducer
(`check yo-self/evaluator/exprs/open.yo`), and 2 of 3 full
`check ./std` sweeps (153/153 when it completes).

**The residual intermittent SIGTRAP (~1/3 of full sweeps) is now
localized.** Under guard pages (`DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib`)
the crash is DETERMINISTIC (3/3 on `check std/string/string.yo`) with this
use-site stack (crash report, faultingThread):

```
__yo_incr_rc
← HashMap(usize, ExprInfo)._find_bucket   (the bucket deref-copy's ___dup)
← HashMap.set
← expr_info_table_set
← evaluate_identifier_and_operator
```

i.e. an OCCUPIED slot of the ExprInfo table holds a STALE pointer — the
stored ExprInfo object was freed while still in the table. The map is the
DETECTOR, not the culprit: something over-releases an ExprInfo it shares
with the table. **Crucially, the gmalloc crash reproduces with dispatch
OFF too** — the latent over-release exists in the committed configuration;
dispatch merely adds allocation churn that turns it into visible SIGTRAPs.

Ruled out this session (balanced dup/drop verified in emitted C +
clean gmalloc runs of standalone models): HashMap.set overwrite path,
set+get+remove+resize+mutate-through-get loops with object values.

**What's needed to finish:** alloc/free/use stacks (ASan). Blockers and
the prepared path:
- Single-TU ASan compile of the 27 MB generated C OOMs clang's frontend
  on a 16 GB machine (Nix clang 21 and Apple CLT clang 17 both
  Killed: 9, with/without -g, with callback instrumentation).
- lldb attach is blocked (Developer Mode disabled; needs sudo
  `DevToolsSecurity -enable`).
- A chunked-ASan pipeline was built (split the generated C at top-level
  function boundaries into ~6 TUs, de-static cross-chunk symbols, compile
  each with ASan, link): chunks compile cleanly in parallel; remaining
  work is mechanical linkage hygiene — keep prefix-defined static-inline
  helpers consistent, extern-declare body-level globals AFTER their
  typedefs (or keep the async runtime region whole in chunk 0), and use
  depth-tracked function boundaries (a mid-function flush-left `) {` once
  produced a silent mis-split). `-Dinline=` avoids C99
  inline-without-extern-def symbol loss.
- Alternative: run the ASan build on a >32 GB machine, or enable
  Developer Mode and walk the gmalloc fault in lldb (`malloc_history`
  needs MallocStackLogging=1).

Repro commands:
```
# deterministic use-site fault (dispatch off or on):
DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib YO_MAIN_STACK_MB=4096 \
  /tmp/yo-self-bin check std/string/string.yo   # SIGSEGV, crash report has the stack
# intermittent SIGTRAP at scale (dispatch on):
YO_MAIN_STACK_MB=4096 <dispatch-on-bin> check ./std   # ~1/3 of runs
```
