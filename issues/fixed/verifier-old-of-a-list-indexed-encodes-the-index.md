# The verifier encoded `old(xs)(k)` as `k`

**Severity:** S1 — a wrong term. A list read through the two-state `old(xs)`
was encoded as the INDEX. A spec over it could be proved, or assumed, as a fact
about the index instead of the element.

**Status:** FIXED 2026-10-01 (`feat/verifier-lemmas`). It was found when std's
`push` contract first used the spelling, before any std or test code depended on
it.

## Symptom (measured)

`push`'s element contract `forall(k, (k < self.len()) ==> (self(k) == cond(...,
true => old(self)(k))))` produced the script line
`(= (select (List_bv32_mk_contents out) k) (ite (...) x k))`: the `old(self)(k)`
read had become `k`. With `i32` elements z3 rejected it (BitVec 32 vs 64).
With `u64` elements the sorts agree, and the read silently means "element `k`
equals `k`".

## Cause

`_expr_term` takes a call's head from the CALLEE's first token. For
`old(self)(k)` that is `old`, so the call was walked as `old(k)`, which is the
entry value of `k`.

## Fix

A call whose callee is itself `old(...)` walks the callee to its term. A list
term makes the call an index read: `select(contents, k)` with the
`index-in-bounds` obligation. Anything else is a subset error. Only an `old(...)`
callee takes this path; a method call `xs.m(...)` has a computed callee too, and
must not.

## Regression test

Every `dml_*` fixture that pushes in a loop (`dml_list_concat`,
`dml_list_zip_filter_reverse`, `dml_append_seq`, `dml_sorted_insert`) reads
through `old(self)(k)` in push's contract. They report solver-error without the
fix and ok with it.
