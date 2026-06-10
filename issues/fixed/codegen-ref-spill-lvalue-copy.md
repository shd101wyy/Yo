# codegen: ref-arg spill copied addressable lvalues — iterator combinators advanced a copy

**Status: FIXED** (this commit). Found by PR #73 CI (ubuntu) + local suite; root
cause pinned by `git bisect run` to `abce0781`.

## Symptom

`tests/iterator_combinators.test.yo`: 9 of 19 tests hung (60 s SIGTERM) or
SIGABRT'd; `tests/iter_filter_closure.test.yo`: 2 of 3. Minimal repro
(`my_range(0,100).take(3)` + manual `next()` loop) printed `got 0, got 0,
got 0` — the inner iterator never advanced.

## Root cause

`abce0781` fixed `&(binary_expr)` → "cannot take address of rvalue" by
spilling any `ref`-argument C code that is not a **bare identifier** to a
temp:

```c
__yo_struct_… __yo_ref_spill_2 = (*self)._inner;
… fn_…_next(&__yo_ref_spill_2);          // mutates the COPY
```

But `(*self)._inner` (the Take combinator's inner-iterator field), `a.b`,
`p->f`, `arr[i]` are addressable **lvalues** — `&((*self)._inner)` is valid C
and points at caller-visible storage. Spilling them hands the callee a copy,
so `next(ref(self))` advanced the copy and the real iterator state never
changed: infinite loops (SIGTERM) and downstream aborts.

## Fix

`isAddressableCExpr` (other-fn-call.ts): a chain scanner accepting
identifier-or-parenthesized-deref heads followed by `.f` / `->f` / `[…]`
tails (plus bare `*…` derefs); only genuine rvalues (binary exprs, calls,
casts, literals) are spilled. The original `&(binary_expr)` fix is preserved
(those still spill — an rvalue has no caller-observable storage, so copy
semantics are correct there).

## Coverage

`tests/iterator_combinators.test.yo` (19/19) + `tests/iter_filter_closure.test.yo`
(3/3) exercise the exact regression paths and ran red→green on the fix.

## Lessons

- A "make the C compile" codegen fix can silently change SEMANTICS (compile
  error → wrong behavior is worse). For `ref`/pointer args the question is
  not just "is `&` valid" but "does the pointer alias the caller's storage".
- `git bisect run` with a fast single-test predicate
  (`--test-name-pattern "iter.take limits the iterator"`, 3 ms SIGABRT) pinned
  the commit across a 310-commit range in ~9 automated steps.

## yo-self

Not applicable yet — `other-fn-call.ts` is unported (BOOTSTRAPPING_CODEGEN.md
Phase 2). The fixed version is what will be ported.
