# Effect operations with contracts, so a body that performs an effect can be verified

**Kind:** design question — an open decision, not a defect. Filed 2026-10-14
from the F\* audit (`plans/backlog/FSTAR_ADOPTION_CANDIDATES.md` F11(b)),
whose plan parks the idea until SELF_VERIFICATION M4; this doc asks whether
it should come earlier.

## The question

Effects are outside the verifiable subset by design: a verified body may
not use an effect parameter, install a `ctl` handler, await, or call
through FFI, and that purity is what makes framing free
(`plans/backlog/FORMAL_VERIFICATION.md` §Purity and the effect frame rule).
The boundary is elegant and it is drawn exactly where user code lives.
Nearly every non-trivial Yo function takes `io` or `exn`; under
`Pragma.VerifyOrAssert` such a function is reported `outside-subset` and
nothing in it is proved, including the bounds and divisor obligations the
effect has nothing to do with. SELF_VERIFICATION's census counts the
consequence for the compiler (3,636 of 4,049 functions blocked at a
parameter); user programs that log, read files or throw are in the same
position. L2 (exceptions as exit paths) is the only planned step toward
effectful code, and it covers one effect.

F\* specifies effectful code through effect-indexed computation types and
user-defined effects; that needs its dependent core and is rejected. What
does not need it is the modular call rule Yo already has: a callee's
`requires` is proved at the call and its `ensures` assumed after it,
whatever the callee's body does.

## Recommendation

Let an effect **operation** carry contracts, and treat a perform site as a
contracted call:

1. A `ctl` operation in an effect record (or a bare `ctl`-typed parameter)
   may declare `requires(...)` / `ensures(...)` over its arguments, its
   result and ghost state (ghost fields of the effect record, which is
   F2 of the F\* audit). A perform site inside a verified body proves the
   `requires` and assumes the `ensures`; the body stays in the subset.
2. A handler is verified against the operation's contract the way an
   `impl` method is verified against its trait's (V6 task 1's variance
   rule): the handler assumes the operation's `requires` and proves its
   `ensures` on every `return(...)` path; an `unwind(...)` path is an
   abnormal exit like `panic`, with nothing to prove.
3. An operation with no contract is a subset error at the perform site, as
   a contract-less callee is today, with the message naming the operation.
4. Framing: an effect operation may modify nothing the caller can name
   (its only channel is the ghost state of its record), so the purity frame
   rule survives unchanged; the explicit frame clause question
   (`issues/questions/modifies-clause-for-callee-side-effects.md`) applies
   to ordinary callees only.
5. Order: after L2 (exceptions), before the heap model, because it needs
   no heap — it needs only ghost state on the effect record, and it is the
   difference between `VerifyOrAssert` verifying user code and verifying
   its pure leaves. Ask the SELF_VERIFICATION census how many
   `outside-subset` functions are blocked *only* by an effect parameter;
   that number is the trigger.
