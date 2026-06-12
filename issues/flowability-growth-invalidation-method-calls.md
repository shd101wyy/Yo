# Flowability: mutating method calls invalidate live `ref` borrows (growth realloc UAF)

**Status: LARGELY FIXED 2026-06-12 — one residual below.** The same-scope
forms are closed in BOTH compilers by extending the borrow-invalidation
gate to call sites:

- **Method receivers / call arguments**: while a `ref` borrow lives, the
  source variable may not be used as a method receiver or call argument
  (`requireNotLiveBorrowSourceForCall`, enforced in evaluateFunctionCall;
  yo-self: calls/function.yo). Conservative by design — object reference
  semantics make mutation signature-invisible. Exemptions: compiler-
  synthesized uses (auto-generated `___drop`/`___dup`/`___dispose`) and
  the RHS subtree of a `ref(...) :=` binding (borrow-CREATING projections,
  so multiple live borrows from one source still work).
- **Alias creation**: `y := xs` from a borrowed source is rejected
  (initialization-assignment gate).
- **Pre-existing aliases**: borrow marks apply to the source's whole
  ALIAS GROUP (`collectAliasGroup` over `isOwningTheSameRcValueAs`
  roots), so `xs2 := xs; ref(r) := xs.project(0); xs2.push(...)` is
  rejected too.

Regression tests: tests/ref_borrow_invalidation.test.yo (4 negative
shapes incl. the alias-group case, 3 positives incl. unrelated-container
calls and multi-borrow). The original runtime repro (64 pushes →
gmalloc SIGSEGV) is now rejected at compile time.

## RESIDUAL (open): aliasing invisible across function boundaries

```rust
f :: (fn(xs : ArrayList(String), xs2 : ArrayList(String)) -> unit)({
  ref(r) := xs.project(usize(0));
  xs2.push(String.from("filler"));   // xs2 MAY be the same list as xs
  println(r);
});
// caller: f(list, list);
```

Inside `f`, parameters carry no alias information
(`isOwningTheSameRcValueAs: undefined` for params), so the alias-group
marking cannot see that `xs2` aliases `xs`. Closing this statically
requires either Rust-style exclusivity (reject `f(list, list)` at call
sites AND track reachability through fields/returns) or per-parameter
may-alias assumptions (freeze every same-type object parameter while a
borrow lives — likely too restrictive). A dynamic alternative: borrow
epochs / pinned buffers on RC collections. Design decision needed; the
same limitation exists for any handle reaching the object through struct
fields or returns.

---


## Symptom

The borrow-invalidation gate rejects REASSIGNING or MOVING a borrowed
source while a `ref` binding lives (closed 490c5d60 + 7f06fca7), but does
NOT constrain **mutating method calls** on it:

```rust
xs := ArrayList(String).new();
xs.push(String.from("element-zero"));
ref(r) := xs.project(usize(0));
xs.push(String.from("filler"));   // ACCEPTED — but push may realloc the buffer
println(r);                        // use-after-free of the old buffer
```

`check` accepts this; the compiled binary (64 pushes to force growth)
SIGSEGVs deterministically under libgmalloc (exit 139). Repro:
/tmp-style standalone in this issue; the shape is exactly
tests/ref_borrow_invalidation.test.yo's negative cases with `xs.push(...)`
substituted for `xs = ...`.

## Fix direction

Extend the same-scope borrow-invalidation gate: while a `ref` binding is
live, a method CALL with the borrowed source as receiver (or argument)
must be rejected unless the method is known non-invalidating. Options:

1. Conservative: reject ALL `ref(self)`/`self`-mutating method calls on a
   borrowed source while the borrow lives (read-only calls via plain
   `self : Self`-by-value receivers stay allowed... note object semantics
   make most receivers mutable — may need a method-effect annotation or
   allowlist).
2. Precise: an `invalidates`-style effect on methods that can free/move
   backing storage (push/reserve/insert/clear/...), enforced like the
   reassign gate (collectRefBorrowSources already computes the sources;
   the gate site is the method-call evaluation, reusing refBorrowedBy).

The enforcement plumbing exists (refBorrowedBy marks + scope-liveness in
src/evaluator/exprs/assignment.ts / expr.ts setExprAsConsumed); what is
missing is the METHOD-CALL check site. Mirror in yo-self alongside
(evaluator/utils.yo set_expr_as_consumed is still unwired there —
plans/BOOTSTRAPPING_CODEGEN.md landmine 3).

Documented as a known limitation in the flowability audit
(plans/FLOWABILITY*.md / memory); this issue makes it a tracked,
reproducible work item.
