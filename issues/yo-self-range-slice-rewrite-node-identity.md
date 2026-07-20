# yo-self: String/Array range-slice `recv(a..b)` FTTs — rewrite/codegen node-identity mismatch

**Status:** ROOT-CAUSED (2026-07-20), fix is a hot-path eval change — deferred.
**File:** `tests/flowability_comprehensive.test.yo` (direct); `..` range-slice appears in
~11 test files (index, array, for_macro_borrow, async_await, closure_capture_rc_leak, …).
**Class:** AST-rewrite propagation to codegen (NOT Gap-6).

## Symptom

`v := "hello world"; w := v(usize(6) .. usize(11))` emits:

```c
__yo_str _file____User_temp_6544 = // Failed to transpile v(usize(6) .. usize(11));
__yo_str w = _file____User_temp_6544;        // <- next line: "unexpected type name '__yo_str'"
```

The FTT comment eats the statement's `;`, so every following line cascades into
`error: unexpected type name '...': expected expression`. Both `str` AND `String`
receivers FTT. TS compiles + runs both (`world world`).

## Root cause

`recv(a..b)` on a runtime receiver must become the method call `recv.slice_copy(a..b)`
(owned-return; the Index trait's `*(Output)` pointer contract can't express owned
returns — plans/SLICE_REWORK.md Part C). yo-self HAS the rewrite
(`_try_rewrite_range_index_to_slice_copy`, `function.yo:757`) and it works at EVAL time:

- Probe at the method lookup: `recv=String method=slice_copy found=1` and
  `recv=str method=slice_copy found=1` — the rewrite IS reached and DOES find the method.
- It builds `recv.slice_copy(a..b)` and `record_macro_expansion(id, rewritten)`.

**But codegen still FTTs the ORIGINAL `recv(a..b)`.** The macro_expansion side-table
(`g_macro_expansions : HashMap(ExprId, AstExpr)`, expr_info.yo:638) is keyed by expr id,
and the eval instance and the codegen instance have DIFFERENT ids:

```
PROBE-REC  id=56261   (record site, function.yo, after record_macro_expansion)
PROBE-FTT  id=56259 mx=N   (codegen FTT site, generation.yo:598 — lookup misses)
```

A consistent **+2 offset**: eval rewrites one node instance; codegen walks a different
(parser-original) instance that took a NON-rewrite arm, so its id never gets a
macro_expansion entry → `lookup_macro_expansion(id)` returns None → FTT.

Two coupled reasons the ids diverge:

1. **No in-place AST mutation.** TS does `expr.func = methodAccess` (function.ts:833) —
   mutates the SAME node object, so codegen sees the rewritten `func`. yo-self's
   `AstExpr` is a `ref(enum)` whose variant fields cannot be reassigned (grep confirms:
   NO yo-self code does `expr.func = …`; every AST rewrite goes through
   `record_macro_expansion`). The side-table is the only channel, and it fails when the
   eval-instance id ≠ codegen-instance id.
2. **The rewrite is arm-local.** It is only called from 2 evaluate_function_call arms
   (`function.yo:3672` UnknownVal fallthrough, `function.yo:3996` function-type-None).
   TS runs it PRE-DISPATCH (function.ts:768, before the callee-value branch), gated
   `!givenFunc && !methodExpr && !forMacroExpansion && functions.length==1 &&
args.length==1 && arg0 is `..`/`..=` && !recvHasComptimeSliceValue`. The
   codegen-visible instance takes some other arm and is never rewritten.

## Fix candidates (both are hot-path eval changes → full gate battery + fixpoint)

- **(a) Hoist the rewrite pre-dispatch** to mirror TS function.ts:768 (before the
  callee-value match), AND port the `recvHasComptimeSliceValue` guard (skip the rewrite
  when the receiver carries a comptime slice value, keeping comptime slicing on the
  comptime-fold path). Then whichever instance evaluate_function_call receives is
  rewritten. Verify the macro_expansion then lands on the codegen-visible id.
- **(b) Eliminate the intermediate AST clone** so the eval and codegen instances share
  one id (then the existing arm-local rewrite + side-table suffice). Find where the
  `w := recv(a..b)` RHS is cloned with fresh ids between parse and the rewrite (the +2).

The `alloc_global_expr_id()` (not `ast_expr_id(expr)`) for the rewritten OUTER node is
REQUIRED regardless: a same-id macro_expansion re-diverts to itself and recurses forever
in codegen (observed: rc=138 SIGBUS). The if-macro precedent (numeric_type.yo:451) uses a
fresh-id expansion node for exactly this reason.

## Validation (when attempted)

`src/tests/fixme.yo` repro:

```rust
open(import("std/string"));
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  v := "hello world"; w := v(usize(6) .. usize(11)); println(w);      // want: world
  s := String.from("hello world"); x := s(usize(6) .. usize(11)); println(x);  // want: world
});
export(main);
```

Then the full battery (corpus diff-test, `check ./std`, stage2/stage3 STRICT_FIXPOINT)

- flowability_comprehensive + the other `..` files + prior flips.

## UPDATE 2026-07-20 — candidate (a) HOIST is RULED OUT (probe)

Probe at `evaluate_function_call` entry (gated to range-index args), printing
`ast_expr_id(expr)`: only the EVAL instances enter it —

```
PROBE-EFC id=56261   (x2)   <- the instance the rewrite already fires on
PROBE-EFC id=56286   (x2)
```

The codegen-visible instances (56259 / 56284) **never reach `evaluate_function_call`**,
so hoisting the rewrite anywhere inside it cannot record a macro_expansion on the id
codegen looks up. Candidate (a) is dead.

⇒ The two instances are distinct nodes: the codegen node (56259) is created WITHOUT
going through `evaluate_function_call`, yet it carries ExprInfo (type `__yo_str`) — so its
ExprInfo is COPIED/materialized from the eval instance (56261) by some collection /
runtime-arg-materialization pass. The real fix is at THAT site (propagate the
macro_expansion when the node is duplicated, or reuse the eval instance's id), OR handle
range-index `recv(a..b)` directly in CODEGEN (emit the `slice_copy` dispatch there, using
the resolved method from the type/registry) so it never depends on the eval-time rewrite
reaching the codegen node. Both are deeper than a rewrite-placement change.
