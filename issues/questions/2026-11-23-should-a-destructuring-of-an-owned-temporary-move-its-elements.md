# Should a destructuring of an owned temporary move its elements?

**Kind:** design question — an open decision, not a defect.

**Status:** DECIDED, not yet implemented. Raised 2026-11-23 by the fix of
`issues/fixed/2026-11-22-a-mut-name-destructured-from-a-call-result-is-released-twice.md`.
The coordinator's VERDICTS-76 Q2 (2026-11-22) already settles it: a destructuring of an owned
source CONSUMES it, which is the "move" option below. It is scheduled for v0.2.81
(`plans/handover/VBD_RELEASE_SCHEDULE.md` §4). Until then, v0.2.80 ships the E0901 of that fix
as the interim rule. The doc stays here until the v0.2.81 PR implements the verdict and moves it.

## The question

A destructuring borrows (`plans/reference/RC_OWNERSHIP_IMPLEMENTATION.md` item 8): in
`(a, b) := f()` each name is a copy of its element, and the call's temporary keeps owning both
elements and releases them at scope end. Since that fix, a `mut(name)` element that holds an RC
cell or an owned buffer is E0901, as a `&` match's `mut(name)` binding is (VERDICTS-28 Q2), so

```yo ignore
(mut(w), s) := pair(e);   // E0901 when w : Rc(Node)
```

is rejected, where Rust accepts `let (mut w, s) = pair(e);` by moving the parts out of the
temporary. A by-value `match` of the same temporary already does what Rust does: it consumes the
scrutinee and its arm's bindings own the parts (decision 26), so
`match(pair(e), (mut(w), s) => …)` is accepted and balanced.

Should a destructuring whose right-hand side is an owned temporary consume it the same way?

## Options

1. **Keep the borrow (today).** One rule for every destructuring, whatever its source. The
   cost is the two spellings above (`(w0, s) := pair(e); mut(w) := w0.clone();`, or the `match`).
   The tree has no such site: `src/` and `std/` bind no `mut` element with drops, and the one the
   VERDICTS-73 F2 lane wrote was rewritten before it landed.
2. **A destructuring of a temporary consumes it.** The names own their elements, the elements no
   name binds are dropped at the end of the statement (Rust's temporary rule), and the E0901
   applies only to a destructuring of a place (a named local, a field), which stays a borrow
   because there are no partial moves. This reuses the consuming match's per-part ownership
   (its hidden bindings for unbound parts) at the destructuring site. It changes the emitted
   drops of every destructuring of a call result in `src/` (per-name drops instead of the
   temporary's).

## Recommendation

Option 1 for now: it is sound, explicit at the use site (the copy is spelled `.clone()`), and
matches how a `&` match treats the same binding. Revisit option 2 only if real code needs a
`mut` owned part out of a temporary often enough that the `match` spelling reads as a workaround.
