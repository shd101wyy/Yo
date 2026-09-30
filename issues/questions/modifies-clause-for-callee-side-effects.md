# Which arguments may a callee mutate? The verifier infers it from `old(...)` in the contract

**Kind:** design question — an open decision, not a defect. Filed 2026-09-30
by R1 slice 2 of `plans/backlog/ATS_STYLE_INDEXED_TYPES.md`.

## The question

Dafny has `modifies`; Yo's contracts have no clause that says which
arguments a callee changes. Two kinds of argument can change under a call:
an `inout` parameter, and a reference-semantics value (an `ArrayList`
handle: `push` writes through `self`). The verifier's call-site rule since
R1 slice 2 (`_callee_call_term`, `src/verifier/vc.yo`) is:

> A named argument bound to a modeled list is rebound to a fresh term after
> the call **iff** the callee's `requires`/`ensures` mention `old(<param>)`
> for that parameter; the callee's ensures then relate the new term to the
> old one, and `old(<param>...)` inside those ensures reads the pre-call
> term (`ctx.call_pre`).

A contract that never writes `old(p)` therefore promises `p` unchanged. That
is the right reading for `assumed()` std specs (they are written to be the
whole truth) and for `inout` integers (the two-state fixture already
assumes it), but it is a convention, not a checked fact: a callee whose
BODY mutates `p` while its ensures says nothing about `old(p)` is verified
at its own body (the body walk sees the mutation through push's contract),
yet callers keep their pre-call knowledge of `p` — unsound if that callee
is `assumed()` and the author forgot the clause.

## Recommendation

Keep the "old mentions modifies" rule for now and make the gap loud rather
than add syntax:

1. When a **walked** (non-assumed) body mutates a list-typed parameter
   (its havoc set contains the parameter name) and no contract clause
   mentions `old(<param>)`, report a subset error naming the parameter
   ("the body mutates `xs` but the contract does not relate it to
   `old(xs)`"). The verifier already computes both facts.
2. For `assumed()` bodies nothing can be checked; the std annotation
   review is the gate (every mutator in `std/collections/array_list.yo`
   already writes its `old(self.len())` clause).
3. Revisit a real `modifies(...)` clause only if (1) turns out to reject
   idiomatic code — it also needs the verifier's heap model (open question
   1 of `FORMAL_VERIFICATION.md`) to mean anything for aliased handles.
