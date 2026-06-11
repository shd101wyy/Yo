# Flowability: mutating method calls invalidate live `ref` borrows (growth realloc UAF)

**Status: OPEN** — verified live 2026-06-12. The LAST known soundness hole
in safe (non-pragma) Yo code.

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
