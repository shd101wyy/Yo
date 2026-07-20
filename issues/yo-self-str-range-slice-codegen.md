# yo-self: `v(range)` str/ArrayList slice codegen — a TWO-gap chain (flowability_comprehensive)

_2026-07-20. Investigated `tests/flowability_comprehensive.test.yo`
(`unexpected type name '__yo_str'` + cascading `use of undeclared identifier`).
NOT flipped — it needs TWO independent codegen fixes. Gap 1 (slice_copy dispatch)
was implemented + verified working, then REVERTED (flips nothing without Gap 2).
Gap 2 (comptime-range emission) is a separate, deeper evaluator issue. Both
precisely characterized below; the Gap-1 recipe is ready to re-apply._

## The failing construct

```rust
v := "hello world";           // str = fat pointer { const uint8_t* ptr; size_t len; }
w := v(usize(6) .. usize(11)); // range-window slice → a NEW str view {ptr+6, len 5}
```

`str` is a static immutable `(ptr,len)` view; slicing produces another view into
the same backing (O(1), no copy). The evaluator rewrites `v(range)` →
`v.slice_copy(range)` (`_try_rewrite_range_index_to_slice_copy`,
calls/function.yo:757) and evaluates THAT, reusing the original call id. TS
mutates `expr.func` in place so codegen sees the method call; yo-self can't
(value semantics), so it records the resolved method in the method-callee
side-table. Two codegen gaps then block it.

## Gap 1 — slice_copy dispatch for a NON-DOT value-call (IMPLEMENTED, verified, reverted)

Codegen's method-callee side-table (`lookup_method_callee_value`, keyed by the
call id — set at function.yo:3895/3898) IS populated with slice_copy, but BOTH
the collection (collection.yo) and emission (other_fn_call.yo) gate that lookup
on the callee being a `.method` DOT expr. The rewritten call's SOURCE callee is
the bare receiver `v` (an atom), so neither path fires → the value-call tail
emits `// Failed to transpile`. Same family as the forward_ref_impl_block fix.

FIX (verified to emit `yo_id_NNNN(v, <range>)` correctly, `==` not intercepted):

1. **collection.yo** — hoist the `lookup_method_callee_value(ast_expr_id(expr))`
   collection OUT of the `if(ast_expr_is_fn_call_of(callee, BF_DOT, 2))` block so
   it runs for EVERY FnCall (idempotent, has_function-guarded).
2. **other_fn_call.yo** (right after `func_ei :=`, ~line 1210) — add a branch:
   for a NON-dot callee with a recorded method-callee, emit `<mcn>(<runtime args
= recv, range>)`, mirroring the concrete dot-dispatch emission (1115-1200:
   `_c_func_name`, `_apply_ref_amp` via the method's param_is_ref, may-unwind +
   binding/unit/inline exits). Guard: `!ast_expr_is_fn_call_of(func_expr, BF_DOT,
2)` — array indexing does NOT record a method-callee (index-trait branch
   function.yo:3684 is separate from the recording at 3895), and operators are
   handled before this path, so the branch is specific to rewritten value-calls.

Reverted because it flips NOTHING alone: flowability's ranges are CONSTANT, so
they hit Gap 2 first. (It WOULD fix runtime-range slices `s(i..j)`, but those are
rare in the suite.)

## Gap 2 — COMPTIME (constant) range construction loses its ExprInfo (the real blocker)

Isolated repro (no slice_copy involved):

```rust
r := (usize(6) .. usize(11));   // s2: `__yo_t1 r = // Failed to transpile ...`
```

- **Runtime** range `i .. j` (variable) WORKS: emits `fn_..._u46__u46_((size_t)i,
(size_t)j)` — a call to the `..` operator function.
- **Constant** range `usize(6)..usize(11)` FAILS: `get_expr_info(range)` is None
  (generation.yo:417 fallback). It resolves to the COMPTIME `..` overload
  (`fn(comptime(start), comptime(end)) -> comptime Range`, e.g. std id_13623) and
  CTFEs to a comptime Range value — but the `..` node ends up with NO ExprInfo,
  so codegen can't emit the struct literal TS produces
  (`(Range){ .start = 6ULL, .end = 11ULL }`).

So the comptime-`..` result is not stored as the call node's ExprInfo (unlike
normal comptime-fn calls). Next-session entry: find where the comptime range
overload is evaluated (comptime_fn.yo / comptime_index_fns.yo / the `..` operator
path) and ensure it records `new_expr_info(env, Range)` with the comptime
StructVal on `ast_expr_id(the .. call)`, so codegen's comptime_value emitter
prints the `{start,end}` literal. Verify with the `r := (usize(6)..usize(11))`
repro (get_expr_info non-None, clang-clean) BEFORE the slice case.

## To flip flowability_comprehensive

Apply Gap-1 (recipe above) AND Gap-2 (comptime-range ExprInfo). All 3 slice sites
(w:52, ww:54, buf:64) are constant-range, so both are required. Full battery +
STRICT_FIXPOINT mandatory (touches codegen dispatch + comptime-value emission).
