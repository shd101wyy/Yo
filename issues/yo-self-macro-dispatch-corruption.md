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
