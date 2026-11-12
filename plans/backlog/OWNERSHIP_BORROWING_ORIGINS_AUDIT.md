# Ownership, borrowing and origins: the 2026-11-11 audit

**Status: RECORD of an audit, with open follow-ups (2026-11-12).** An independent audit of Yo's ownership, borrowing
and origin design (`VALUES_BY_DEFAULT.md` decisions 18–50, `REFERENCES_AND_ORIGINS.md` O1–O10,
`BORROW_CHECKER_COMPLETENESS.md`) and of the checker built from it, on develop `64f33c710` (two days before the
v0.2.77 cut). It changes no code. It files the issues listed in §3, corrects `REFERENCES_AND_ORIGINS.md` in place
(§4), and carries a patch for the documents other lanes own (§5). Each finding closes with its issue; this file is
done when §3's open column is empty and §5 and §6 are applied.

## 1. Scope and method

The question was whether the design is sound, complete and correct, and whether the compiler enforces it.

- **Design reading.** The three design documents, the reference model (`tests/origins/model.yo`), the corpus
  (`tests/origins/corpus.tsv`, 112 rows) and the must-reject directory (`tests/origins/unsound/`) were read against
  each other, rule by rule.
- **Adversarial probing.** Ten probing agents, one per area — calls, patterns and control flow, generics and
  traits, ownership and moves, iteration and collections, holders, cells and handles, closures, async and effects,
  and the boundary (globals, threads, the unsafe gate) — wrote about 1,600 small programs in safe Yo. Each was run
  through `yo check`; an accepted program was compiled with `--sanitize address --allocator system` and run with
  `detect_stack_use_after_return=1` (and LeakSanitizer; ThreadSanitizer for the thread probes). A finding is a
  program a maintainer can run in one command; none rests on a reading of the source alone.
- **Three compilers.** The develop tip `64f33c710`, develop thirteen commits earlier (`cd99fc50c`), and the
  published seed v0.2.76, which classifies each finding as pre-existing or new since the last release.
- **Root causes** were then read in `src/evaluator/` for each finding before its issue was written.

Not covered: guard elision under `Pragma.Verify` / `assumed()` (needs the solver), C callbacks holding borrows,
programs inside `Pragma.AllowUnsafe` files (std's own bodies were read only where a safe caller reached a defect
through them), and performance.

## 2. Verdict

**The design is sound in substance. The built checker is not complete, and the plan's own completeness gate is the
piece that is missing.**

- **Design.** No accepted-and-unsafe program needed a rule the design lacks. Every one is a place where the
  compiler does not compute an origin the rules assign, does not run a check the rules state, or treats an access
  as weaker than its declared mode. `REFERENCES_AND_ORIGINS.md` was one sentence short in six places (§4); two of
  them (an argument's value is a loan the call holds; a `&mut` argument is exclusive whatever the callee does) had
  let an unsound reading into decision 28's two-phase extension, into `BORROW_CHECKER_COMPLETENESS.md` P9 and into
  the model, and from there into the compiler (A1). The four mechanisms of O3 — substitution, loan against access,
  subset coercion with invariance under `&mut`, last-use liveness — stand; nothing found calls for regions,
  variance beyond O3-3, or lifetime subtyping.
- **Checker.** §3 lists 55 accepted-and-unsafe shapes (52 of them S1: a use-after-free, a double free, a
  data race, or a miscompile reachable from safe code), 7 compiler failures and 11 wrong rejections or
  diagnostics. Eight are new since v0.2.76 and matter to the cut — A1, A6's `for(&mut …)` form, A7, A8's `Dyn`
  form, A9 with A49, A28 (with B4 and C11, the same new parameter type), A30's by-value form and A31's guard form;
  the rest reproduce on the published release. The release coordinator ruled on each during the audit (cut gates:
  A1, A6, A7, A8, A9, A28, A31; the others are known issues for v0.2.77).
- **Why the plan did not catch them.** `BORROW_CHECKER_COMPLETENESS.md` defines "done" as five gates. Three are in
  place and green — the corpus (G-A), the must-reject directory (G-B), the landed O-1…O-5 — and they pin exactly
  the shapes someone thought of. The two that find shapes nobody thought of are not: G-E, the totality audit
  ("an expression of an origin-carrying type with no origin set is a compiler error"; "every access calls
  `access`"), is O-6 and has not landed; G-D, the generator, has a grammar (roots × holders × creation sites ×
  sinks) that contains none of §9's clusters 1, 2, 5, 7 or 8. More than half of §3 is mechanically one of G-E's
  two failures: an origin never computed for a value position (a block tail, an arm value, a call result built
  from a field lend, a capture), or an access that never reaches the loan table at its declared mode (a `&mut`
  lend judged a read, a capture-list entry, `consume`, an implicit capture move).
- **What is solid.** §7. Direct forms of every rule are enforced; the holes are at the joints: wrappers, value
  positions, modes behind an indirection, and control-flow joins.

**Recommendation.** Land O-6 with G-E as specified before adding accepted surface (P1, P2, P4, N2c, N2d): each of
those multiplies the positions of §9's clusters. Fix by cluster, not by finding (§9 gives the order). Extend G-D's
grammar with the audit's axes and keep the probe corpus as its seed (§6).

## 3. Findings

Columns: **Since** — `pre` = v0.2.76 gives the same verdict; `new` = introduced after v0.2.76; `n/a` = not
expressible on v0.2.76. **Where** — the issue document (under `issues/`, reproducers under `issues/repros/` with the same
basename), or the fix lane that owns it. Severity is `issues/README.md`'s scale.

### 3.1 Accepted and unsafe

| Id | Finding | Sev | Since | Where |
| --- | --- | --- | --- | --- |
| A1 | A value that carries a `&` loan of `x` (a named reference, an `Option(&T)`, a holder) is accepted beside `&mut x` in one call: decision 28's two-phase extension (P9) treats the loan as ended at its "last use", the argument | S1 | new | fix lane `fix/p9-holder-arg` (no document; reproducers `…-holder-first.yo` of A2) |
| A2 | Two call results that each carry a `&mut` loan of one place are accepted as arguments of one call | S1 | pre | `issues/2026-11-11-two-call-results-carrying-a-mut-loan-of-one-place-are-accepted-as-arguments-of-one-call.md` |
| A3 | A `match` arm binding over a reference bound from a call result does not keep the root frozen | S1 | pre | `issues/2026-11-11-a-match-arm-binding-over-a-reference-bound-from-a-call-result-does-not-keep-the-root-frozen.md` |
| A4 | A method call (`x.m(..)` and UFCS) skips `lend_through`: a method of a generic container or of `impl(generic(p : Origin), H(p), …)` stores a shorter-lived reference into its receiver | S1 | pre | fix lane o6-method-lend (its document is on that branch) |
| A5 | A composite call result built over another call's reference result does not freeze the borrowed place | S1 | pre | `issues/2026-11-11-a-composite-call-result-built-over-another-calls-reference-result-does-not-freeze-the-borrowed-place.md` |
| A6 | A `&mut` argument is an exclusive access only when the callee's body writes it | S1 | new (the `for(&mut …)` form, #1876); pre (the rest) | `issues/fixed/2026-11-11-a-mut-argument-is-an-exclusive-access-only-when-the-callees-body-writes-it.md` (the bodyless half: `issues/2026-11-12-a-mut-argument-to-a-callee-that-neither-writes-nor-lends-it-is-a-read.md`) |
| A7 | A reference typed over the `static` origin accepts any reference and freezes nothing | S1 | new | `issues/fixed/2026-11-11-a-reference-typed-over-the-static-origin-accepts-any-reference-and-freezes-nothing.md` |
| A8 | An impl whose result origin is wider than its trait's is accepted, and `Dyn` callers trust the trait | S1 | new (the `Dyn` form); pre (generic callers, parameters) | `issues/fixed/2026-11-11-an-impl-whose-result-origin-is-wider-than-its-traits-is-accepted-and-dyn-callers-trust-the-trait.md` |
| A9 | A `{ p }` capture of a reference parameter carries no origin, so the closure escapes its argument | S1 | new (#1891); fixed by #1905 | `issues/fixed/2026-11-11-a-capture-of-a-reference-parameter-carries-no-origin-so-the-closure-escapes-its-argument.md` |
| A10 | A composite result that holds a reference into a by-value parameter is accepted | S1 | pre | `issues/2026-11-11-a-composite-result-that-holds-a-reference-into-a-by-value-parameter-is-accepted.md` |
| A11 | A store through a `&mut` returned by a call does not grow the flow set of the place it borrows | S1 | pre | `issues/2026-11-11-a-store-through-a-mut-returned-by-a-call-does-not-grow-the-flow-set-of-the-place-it-borrows.md` |
| A12 | A block or arm value computes its origin after its own locals are gone, so a holder over them carries none | S1 | pre | `issues/2026-11-11-a-block-or-arm-value-computes-its-origin-after-its-own-locals-are-gone-so-a-holder-over-them-carries-none.md` |
| A13 | The `consume` builtin moves a place that a live `&` loan points into | S1 | pre | `issues/2026-11-11-the-consume-builtin-moves-a-place-that-a-live-loan-points-into.md` |
| A14 | The item `next()` returns from a temporary cursor carries no loan of the collection | S1 | pre (a user cursor); n/a (std's borrowed cursors are new) | `issues/2026-11-11-the-item-next-returns-from-a-temporary-cursor-carries-no-loan-of-the-collection.md` |
| A15 | A `Box` sub-pattern of a `&mut` match records no loan, so the arm can replace the box under its binding | S1 | pre | `issues/2026-11-11-a-box-sub-pattern-of-a-mut-match-records-no-loan-so-the-arm-can-replace-the-box-under-its-binding.md` |
| A16 | A call argument naming a match arm binding that shadows a local passes the outer local in C | S1 | pre | `issues/2026-11-11-a-call-argument-naming-a-match-arm-binding-that-shadows-a-local-passes-the-outer-local-in-c.md` |
| A17 | A tuple literal that lends a place and moves or relends it gets no decision-28 overlap check | S1 | pre | `issues/2026-11-11-a-tuple-literal-that-lends-a-place-and-moves-or-relends-it-gets-no-decision-28-overlap-check.md` |
| A18 | A reference slot assigned in every arm of a branch keeps only the last arm's loan | S1 | pre | `issues/2026-11-11-a-reference-slot-assigned-in-every-arm-of-a-branch-keeps-only-the-last-arms-loan.md` |
| A19a | A reference to a per-iteration local stored in an outer slot survives into the next iteration | S1 | pre | `issues/2026-11-11-a-reference-to-a-per-iteration-local-stored-in-an-outer-slot-survives-into-the-next-iteration.md` |
| A19b | A write that precedes a lend in a loop body is not checked against the loan the back edge carries | S1 | pre | `issues/2026-11-11-a-write-that-precedes-a-lend-in-a-loop-body-is-not-checked-against-the-loan-the-back-edge-carries.md` |
| A20 | A capture that reborrows through a reference binding does not freeze what the binding borrows | S1 | pre | `issues/2026-11-11-a-capture-that-reborrows-through-a-reference-binding-does-not-freeze-what-the-binding-borrows.md` |
| A21 | A reference to an owned match arm binding stored in an outer slot outlives the arm | S1 | pre | `issues/2026-11-11-a-reference-to-an-owned-match-arm-binding-stored-in-an-outer-slot-outlives-the-arm.md` |
| A22 | A reference into a match's temporary scrutinee escapes the statement through the arm value | S1 | pre | `issues/2026-11-11-a-reference-into-a-matchs-temporary-scrutinee-escapes-the-statement-through-the-arm-value.md` |
| A23 | A temporary reached through a handle's `.*` or an inner projection call is no root of the holder it feeds | S1 | pre | `issues/2026-11-11-a-temporary-reached-through-a-handle-deref-or-an-inner-projection-call-is-no-root-of-its-holder.md` |
| A24 | A `&mut` nested inside a by-value argument does not make its origin invariant, so a call widens it | S1 | pre | `issues/2026-11-11-a-mut-nested-inside-a-by-value-argument-does-not-make-its-origin-invariant-so-a-call-widens-it.md` |
| A25 | A store through a local `&mut` borrow of a holder does not widen the holder's flow set | S1 | pre | `issues/2026-11-11-a-store-through-a-local-mut-borrow-of-a-holder-does-not-widen-the-holders-flow-set.md` |
| A26 | A `&mut` reference field read by value is copied, so two holders share one exclusive borrow | S1 | pre | `issues/2026-11-11-a-mut-reference-field-read-by-value-is-copied-so-two-holders-share-one-exclusive-borrow.md` |
| A27 | A lend of a holder's own field stored into the holder is recorded as the holder's earlier loans | S1 | pre | `issues/2026-11-11-a-lend-of-a-holders-own-field-stored-into-the-holder-is-recorded-as-the-holders-earlier-loans.md` |
| A28 | A `&mut` lend of a reference binding to a spelled-origin parameter does not widen the binding's flow set | S1 | new (the parameter type landed with P3, #1841) | `issues/fixed/2026-11-11-a-mut-lend-of-a-reference-binding-to-a-spelled-origin-parameter-does-not-widen-the-bindings-flow-set.md` |
| A29 | A holder type named in a signature without its origin gets no rigid origin | S1 | pre | `issues/2026-11-11-a-holder-type-named-in-a-signature-without-its-origin-gets-no-rigid-origin.md` |
| A30 | A projection may return a reference into a local or by-value `Box`, `Rc` or `Arc` handle | S1 | pre (a local `Box`); new (a by-value `Rc`) | `issues/fixed/2026-11-11-a-projection-may-return-a-reference-into-a-local-or-by-value-box-rc-or-arc-handle.md` |
| A31 | A `&` read through a holder's `&mut` field does not keep the holder frozen | S1 | pre (a plain holder); new (a guard type: v0.2.76 rejects it); both forms fixed by #1906 | `issues/fixed/2026-11-11-a-read-through-a-holders-mut-field-does-not-keep-the-holder-frozen.md` |
| A32 | A `&mut` lend of a place that a live closure's `&` capture borrows is accepted | S1 | pre | `issues/2026-11-11-a-mut-lend-of-a-place-that-a-live-closures-capture-borrows-is-accepted.md` |
| A33 | A capture-list `&mut` entry is accepted while a local `&` loan of the same place is live | S1 | pre | `issues/2026-11-11-a-capture-list-mut-entry-is-accepted-while-a-local-loan-of-the-same-place-is-live.md` |
| A34 | An implicit capture that moves a place is accepted while a loan of that place is live | S1 | pre | `issues/2026-11-11-an-implicit-capture-that-moves-a-place-is-accepted-while-a-loan-of-that-place-is-live.md` |
| A35 | An `FnMut` closure's by-value state can store a per-call reference parameter or a body local | S1 | pre | `issues/2026-11-11-an-fnmut-closures-by-value-state-can-store-a-per-call-reference-parameter-or-a-body-local.md` |
| A36 | A value moved inside a match guard is never recorded as moved | S1 | pre | `issues/2026-11-11-a-value-moved-inside-a-match-guard-is-never-recorded-as-moved.md` |
| A37 | A move in a `while` condition escapes the loop move rules | S1 | pre | `issues/2026-11-11-a-move-in-a-while-condition-escapes-the-loop-move-rules.md` |
| A38 | Assigning a non-`Copy` local to itself drops the value it keeps | S1 | pre | `issues/2026-11-11-assigning-a-non-copy-local-to-itself-drops-the-value-it-keeps.md` |
| A39 | A tuple or array literal on the left of an assignment is accepted and assigns nothing | S1 | pre | `issues/2026-11-11-a-tuple-or-array-literal-on-the-left-of-an-assignment-is-accepted-and-assigns-nothing.md` |
| A40 | An untyped module-level binding may carry an origin, so a global holds a reference to a dead local | S1 | pre | `issues/2026-11-11-an-untyped-module-level-binding-may-carry-an-origin-so-a-global-holds-a-reference-to-a-dead-local.md` |
| A41 | The D1 thread reach walk does not see `Drop`, so a value dropped on another thread races on a global | S1 | pre | `issues/2026-11-11-the-d1-thread-reach-walk-does-not-see-drop-so-a-value-dropped-on-another-thread-races-on-a-global.md` |
| A42 | The D1 thread reach walk trusts every std body, including the user impls a std generic calls | S1 | pre | `issues/2026-11-11-the-d1-thread-reach-walk-trusts-every-std-body-including-the-user-impls-a-std-generic-calls.md` |
| A43 | Safe code reads `MaybeUninit`'s public `value` field before anything was written | S1 | pre | `issues/2026-11-11-safe-code-reads-maybeuninits-public-value-field-before-anything-was-written.md` |
| A44 | A `Drop` running inside the live range of a `mut(G)` lend is not a call for decision 18 rule 3 | S2 | pre | `issues/2026-11-11-a-drop-running-inside-the-live-range-of-a-mutg-lend-is-not-a-call-for-decision-18-rule-3.md` |
| A45 | A temporary argument leaks when a later argument returns, continues or unwinds | S2 | pre | `issues/2026-11-11-a-temporary-argument-leaks-when-a-later-argument-returns-continues-or-unwinds.md` |
| A46 | An `Fn` closure that writes a capture releases the old value twice also through a `&mut self` method | S1 | pre | `issues/2026-11-11-an-fn-closure-that-writes-a-capture-releases-the-old-value-twice-also-through-a-mut-self-method.md` |
| A47 | An `Fn` closure can call an `FnMut` closure through a `&` capture | S2 | pre | `issues/2026-11-11-an-fn-closure-can-call-an-fnmut-closure-through-a-capture.md` |
| A48 | A function whose composite result is wider than a slot's spelled result origin is accepted at the slot | S1 | pre | `issues/2026-11-11-a-function-whose-composite-result-is-wider-than-a-slots-spelled-result-origin-is-accepted-at-the-slot.md` |
| A49 | A `{ s }` capture of a reference parameter in a returned `io.async` points at the callee's parameter copy | S1 | new (#1891); fixed by #1905 | `issues/fixed/2026-11-11-a-capture-of-a-reference-parameter-in-a-returned-io-async-points-at-the-callees-parameter-copy.md` |
| A50 | A body may store a reference to its own by-value capture through a `&mut` capture | S1 | pre | `issues/2026-11-11-a-body-may-store-a-reference-to-its-own-by-value-capture-through-a-mut-capture.md` |
| A51 | A future made over a by-value origin-carrying parameter does not freeze the caller's argument | S1 | pre | `issues/2026-11-11-a-future-made-over-a-by-value-origin-carrying-parameter-does-not-freeze-the-callers-argument.md` |
| A52 | A borrow of a by-value parameter of a generic body freezes nothing | S1 | pre | `issues/2026-11-11-a-borrow-of-a-by-value-parameter-of-a-generic-body-freezes-nothing.md` |
| A53 | A temporary lent before an await in a later operand is read from a dead C local after the resume | S1 | pre | `issues/2026-11-11-a-temporary-lent-before-an-await-in-a-later-operand-is-read-from-a-dead-c-local-after-the-resume.md` |
| A54 | A string interpolation containing an await evaluates to an empty string and leaks its pieces | S1 | pre | `issues/2026-11-11-a-string-interpolation-containing-an-await-evaluates-to-an-empty-string-and-leaks-its-pieces.md` |

### 3.2 Compiler failures

| Id | Finding | Sev | Since | Where |
| --- | --- | --- | --- | --- |
| B1 | A self-recursive generic function crashes the checker with unbounded specialization | S1 | pre | `issues/2026-11-11-a-self-recursive-generic-function-crashes-the-checker-with-unbounded-specialization.md` |
| B2 | A trait-qualified call passes check and emits the trait's type name as a C value | S2 | pre | `issues/2026-11-11-a-trait-qualified-call-passes-check-and-emits-the-traits-type-name-as-a-c-value.md` |
| B3 | A `where`-generic body forwarding a reference to an origin-generic impl passes its address | S2 | pre | `issues/2026-11-11-a-where-generic-body-forwarding-a-reference-to-an-origin-generic-impl-passes-its-address.md` |
| B4 | A struct with a `&mut &T` field passes check and its C names an undeclared type | S2 | new (P3) | `issues/2026-11-11-a-struct-with-a-mut-ref-ref-field-passes-check-and-its-c-names-an-undeclared-type.md` |
| B5 | A lend of a module-level constant in a constructor field emits the address of a literal | S2 | pre | `issues/2026-11-11-a-lend-of-a-module-level-constant-in-a-constructor-field-emits-the-address-of-a-literal.md` |
| B6 | `RefCell.with(&mut pick)` with `pick :: (fn(v : &String) -> &String)(v)` passes check and the C does not compile | S2 | pre | the R3 family: add the row to `issues/fixed/2026-11-06-a-generic-result-at-t-reference-is-lowered-as-a-projection.md`'s tests |
| B7 | A closure that returns an `io.async` future passes check and the C does not compile (`void *` initialized with a struct) | S2 | pre | already open: `issues/an-impl-fn-local-returning-a-future-is-declared-as-a-void-pointer.md` (the closure-capture form is one more row for it) |

### 3.3 Wrongly rejected, and diagnostics

| Id | Finding | Sev | Since | Where |
| --- | --- | --- | --- | --- |
| C1 | A composite holding a shared reference is not `Copy` although the reference is | S2 | pre | `issues/2026-11-11-a-composite-holding-a-shared-reference-is-not-copy-although-the-reference-is.md` |
| C2 | std `mem.replace` and `Option.take` reject a value that carries an origin, inside std | S2 | pre | `issues/2026-11-11-std-mem-replace-and-option-take-reject-a-value-that-carries-an-origin-inside-std.md` |
| C3 | A `match` over a reference-returning call is rejected as a copy of a move-only value | S2 | pre | `issues/2026-11-11-a-match-over-a-reference-returning-call-is-rejected-as-a-copy-of-a-move-only-value.md` |
| C4 | Decision 18 rule 3 rejects a call while a local borrows an unmarked module-level binding | S2 | pre | `issues/2026-11-11-decision-18-rule-3-rejects-a-call-while-a-local-borrows-an-unmarked-module-level-binding.md` |
| C5 | An `FnMut` closure cannot write its own non-Copy state through a `&mut self` method | S2 | pre | `issues/2026-11-11-an-fnmut-closure-cannot-write-its-own-non-copy-state-through-a-mut-self-method.md` |
| C6 | A reference-field write is rejected as a read of the reference | S2 | pre | `issues/2026-11-11-a-reference-field-write-is-rejected-as-a-read-of-the-reference.md` |
| C7 | A reference carried in by a by-value parameter cannot be returned | S2 | n/a (the spelling is new) | `issues/2026-11-11-a-reference-carried-in-by-a-by-value-parameter-cannot-be-returned.md` |
| C8 | Borrow and ownership diagnostics name the wrong place, mode or rule | S3 | pre | `issues/2026-11-11-borrow-and-ownership-diagnostics-name-the-wrong-place-mode-or-rule.md` |
| C9 | A borrowing future bound with a spelled type is rejected as second-class | S3 | pre | `issues/2026-11-11-a-borrowing-future-bound-with-a-spelled-type-is-rejected-as-second-class.md` |
| C10 | A non-generic `Impl(Future(...))` parameter rejects a borrowing future operand | S3 | pre | `issues/2026-11-11-a-non-generic-impl-future-parameter-rejects-a-borrowing-future-operand.md` |
| C11 | A `&mut` binding of a reference cannot be passed bare to a `&mut` reference-to-a-reference parameter | S2 | new (P3) | `issues/2026-11-11-a-mut-binding-of-a-reference-cannot-be-passed-bare-to-a-mut-reference-to-a-reference-parameter.md` |

The diagnostics that name the wrong place, rule or mode are rolled up in one document (C8): they do not change a
verdict, and they share causes with the findings above (a method name printed as the place, a `&` capture called a
`match` binding, "its storage ends with the call" for a caller's place).

## 4. Design corrections

Corrections to `REFERENCES_AND_ORIGINS.md` were made in place, dated 2026-11-11, and are summarized in its §7
"Found by the 2026-11-11 audit". The rest are proposed in §5 because their documents belong to lanes in flight.

| Id | Statement as written | What is wrong | Corrected |
| --- | --- | --- | --- |
| D1 | Decision 28 "Extended 2026-11-07 (P9)"; `BORROW_CHECKER_COMPLETENESS.md` §7 P9: "a `&` loan whose last use lies inside a later argument of the same call does not conflict with the activation … Rust's two-phase, exactly" | Not Rust's rule and not sound: the later argument may BE the loan (a named reference, an `Option(&T)`, a holder). Rust's two-phase accepts `v.push(v.len())` because `v.len()` is a `usize` | O3 step 2, in place: the loan has ended at activation only if the argument's value does not carry its origin. §5 for decision 28 and P9 |
| D2 | O3 step 2: "two arguments of one call conflict by … by-name place overlap between a `&mut` or moved argument and any other argument" | Says nothing of an argument VALUE that carries an origin: a call result, a named holder, an inline constructor | O3 step 2, in place: an argument's value is a loan the call holds from its evaluation until the call returns |
| D3 | `BORROW_CHECKER_COMPLETENESS.md` §2: a loan's holder is "a binding or a hidden statement temporary" | An argument slot is neither as built, so nested lends are invisible to `access` | §5: argument values are hidden statement temporaries whose range is the call |
| D4 | R-DEREF: "`&r.*` is a reborrow: `origin_of(r)` ∪ `{(r, &)}` when `r` is reached through a `&` path and holds `&mut`, else `origin_of(r)`" | The `else` omits the loan on the binding `r` itself for a reborrow of a local `&mut` binding (the checker does register it; the text is behind the code) | §5 |
| D5 | `VALUES_BY_DEFAULT.md` decision 43: "an `Rc`/`Arc` payload stays `Escapable` because the collector runs drops at an unbounded later time"; "no variance" | The collector was deleted (decision 48 W6b) and O9 was amended on 2026-11-03; O3-3 is a variance rule | §5 |
| D6 | O3-3: an origin is invariant under "a `RefCell` payload" | Names one interior-mutable cell; `Mutex`, `RwLock`, `OnceCell` and the atomics write through `&self` as well | O3-3, in place; the open point is `issues/questions/2026-11-11-how-the-checker-knows-a-type-is-interior-mutable.md` |
| D7 | The model's `eval_call` | Checks a `&mut` argument's activation against loans live AFTER the call only (shares A1); its pairwise E0910 fires only for reference-typed arguments and compares two reference values, which O3 step 2 forbids | §6 |
| D8 | O2: an elided origin is fresh "per `&` token WRITTEN in the signature" | A nominal holder named with its origin elided (`h : H`) writes no `&` token, so its hidden parameter was unconstrained (A29) | O2, in place: fresh and rigid per occurrence of the type name |
| D9 | O9: "A borrow INTO a `RefCell`'s payload goes through its guard and carries the guard's place" | std's `RefCell` has no guards (`with`, `with_mut`, `replace`, `replace_with`, `take`, `into_inner`). A guard API would rest on the reborrow union, which is not enforced through a holder's `&mut` field (A31) | O9 and §5 "Shared cells", in place |
| D10 | The return rule; R-LEND; R-TEMP | Do not say that a `.*` on an OWNING handle (`Box`, `Rc`, `Arc`) is a field step: two checker walks treat every `.*` as "wherever the pointer points" (A30, A23) | The return rule, in place; §5 for R-LEND and R-TEMP |
| D11 | O7 "Closures"; R-CLOSURE-LIT | Cover `&` and `&mut` entries; a by-value entry whose type holds a reference has no stated origin, and an `FnMut` body's write to it is unchecked (A35, A50) | O7, in place; §5 for R-CLOSURE-LIT and O-3 |
| D12 | O7: "an impl may instantiate narrower (subset), never wider"; §5 route 5: "every impl was checked against them" | True of the design, not stated per position: composite results, parameters (invariant), and a named function at a slot (A8, A48) | O7 and §5 route 5, in place |
| D13 | `plans/reference/PARALLELISM_RULES.md` D1: "a body defined in a pragma'd file is the audited base and is not descended into" | No clause for the two ways user code runs inside such a body: drop glue of a moved value, and trait-bound callbacks of a generic std body (A41, A42). `docs/*/THREAD_SAFETY.md` said "Known Holes: None known" | Both documents, in place (a dated known-gap note); the rule change is the fix's |
| D14 | R-GLOBAL / P12: "a lend of an unmarked module-level binding carries ∅" | A `::` scalar constant has no runtime storage to lend (B5); decision 18 rule 3 is applied to unmarked `:=` globals contrary to decision 47 (C4); the origin check on a module-level binding runs on the typed form only (A40) | §5 |
| D15 | Corpus row `loop-join-push` | Rejected today by the container wall, not by the loop join it is named for | §6: its `Option(&T)`-slot twin |
| D16 | Decision 18 rule 3: a `&` of a `mut(G)` global is ended by "any call or `await`" | A `Drop` that runs inside the live range is a call the rule does not count (A44) | §5 |
| D17 | O8 "As built": a result future's origins map "to the arguments that call lent" | Too narrow: an origin parameter substituted through a by-value argument, and a captured reference parameter, are origins of the future too (A49, A51). Whether a future's result may name the future's own origin (`Future(&(T, p), p)`) is unstated | O8, in place; the open point is in `REFERENCES_AND_ORIGINS.md` §7 |
| D18 | `docs/en-US/ALGEBRAIC_EFFECTS.md`: `unwind` "exits the frame that installed the handler … Frames in between, including async tasks, are unwound through" | False across `io.spawn`: the raise aborts the task and the installer continues. A `Drop` impl may perform an unwinding operation, and a second unwind silently replaces the first's value; the design is silent | §5 (the page belongs to the docs lane); position in `REFERENCES_AND_ORIGINS.md` §7 |
| D19 | `docs/*/MEMORY_SAFETY.md`, `FLOWABILITY.md`, `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md` | Described references as second-class and ownership as reference counting with implicit duplication | In place, both languages: the reference paragraph rewritten, dated status notes, a "known holes" entry. Cheatsheet lines: §5 |
| D20 | Decision 17 (explicit copies) | A counted cell that is not spelled `Rc` (`OnceCell`; `Box(Dyn)` under the S1 alias) is copied by `c := b` while a borrow of `b` lives, as a count-bumping copy | Noted; belongs with decision 49 S1's `Box(Dyn)` work, no issue filed |

## 5. Patch for documents owned by other lanes (apply after the v0.2.77 cut)

The coordinator asked that these files not be edited before the cut. Each item is the text to change and the
replacement.

**`plans/VALUES_BY_DEFAULT.md`**

1. Decision 28, "Extended 2026-11-07 (VERDICTS-31 P9; v0.2.77)". Append: "**Corrected 2026-11-11 (audit D1):** the
   loan has ended at the activation only if the later argument's VALUE does not carry the loan's origin. `r := &xs;
   xs.push(i32(r.len()))` is accepted because `r.len()` is an integer; `f(&mut xs, r)`, `f(&mut xs, first(&xs))`
   and `f(&mut xs, h)` with `h` holding `&xs(0)` are E0910, in either argument order. An argument's value is a loan
   the call holds until it returns (`REFERENCES_AND_ORIGINS.md` O3 step 2)."
2. Decision 43, the sentence "an `Rc`/`Arc` payload stays `Escapable` because the collector runs drops at an
   unbounded later time": replace the reason with "(the bound is kept until origin propagation through counted
   cells lands; the collector that was its first reason is deleted, decision 48 W6b; O9)". In the same paragraph,
   "No region variables, no outlives, no variance, no HRTB": replace "no variance" with "no variance lattice
   beyond O3-3's invariance under a `&mut` pointee or an interior-mutable cell".
3. Decision 18 rule 3. Append: "A `Drop` that runs inside the live range — a scope-end drop, the drop of a
   reassigned value, a temporary's drop — counts as a call (audit A44)."
4. Decision 28 or 33, wherever a `&mut` argument's mode is stated. Add: "A `&mut` argument is an exclusive access
   at the call's activation whatever the callee's body does; the mutation summary feeds D3 and the runtime asserts
   only (audit A6)."
5. §0.2 and §3.4 disagree on `Box(T)` (explicit copy against move-only iff `T` is): keep §3.4's statement.

**`plans/backlog/BORROW_CHECKER_COMPLETENESS.md`**

1. §2, the loan definition: "a binding or a hidden statement temporary" → "a binding, a hidden statement
   temporary, or an argument slot of a call in evaluation (its range is from the argument's evaluation to the
   call's return)".
2. §3 R-DEREF: after "else `origin_of(r)`" add "∪ `{(r, mode)}` when `r` is a local `&mut` binding (the reborrow
   holds `r`)".
3. §3 R-LEND and R-TEMP: add "the root of a place is found through `.*` on an owning handle (`Box`, `Rc`, `Arc`):
   `&b.*.x` is rooted at `b`; a temporary operand reached through such a `.*` or through an inner projection call
   (`mkv(mkx().get())`) is a hidden statement local".
4. §3 R-CLOSURE-LIT: add "a by-value entry whose type holds a reference has its origins fixed at the literal from
   its initializer; a body write to the entry is a store through `&mut self`". O-3: "a by-value capture is storage
   the closure or state machine owns and counts as a body-local root for a store through a `&mut` capture".
5. §3 R-GLOBAL and §7 P12: add "a lend of a `::` constant that has no runtime storage is rejected in every
   position, a constructor field and a call argument included, or the constant is materialized as a static; rule
   3 applies to `mut(G)` bindings only; the module-level origin check (E0909) runs on `:=` and typed bindings
   alike".
6. §7 P9: replace "a `&` loan whose last use lies inside a later argument of the same call does not conflict with
   the activation (its range ends before it) … Rust's two-phase, exactly" with VBD item 1's sentence. §11's
   landing note for P9: add the correction's date.
7. §6 G-D: add the axes of §6 below to the generator's grammar. §6 G-E: note that the totality check must cover
   block, arm and `cond` VALUES, capture-list entries and argument slots, the positions where the audit found
   origins missing.

**Documents of the S1g doc set and the docs lane**

- `.github/skills/yo-syntax/syntax-cheatsheet.md`: line 155 ("a `&mut T` field makes the holder move-only unless
  it declares `derive(..., Copy, Clone)`") — a `&mut`-holding type can never be `Copy` or `Clone`, and deriving
  either must be rejected (A26); lines 147, 510 and 512 describe copies of owning values that are now moves.
- `docs/*/ALGEBRAIC_EFFECTS.md`: the `unwind` paragraph (D18), and "pointers and references to `ctl` types are
  rejected" (a `&Raise` parameter is accepted).
- `tests/move_only.test.yo:111`: the test's name describes the old copy rule.

## 6. Rows for the corpus, the model, the must-reject directory and the generator

- **Reproducer pairs.** Every S1 finding of §3.1 has a negative program and a positive control under
  `issues/repros/`. They move to `tests/origins/unsound/` with their fixes, not before, so gate G-B stays green.
- **Corpus rows** (`tests/origins/corpus.tsv`), each with the positive control named beside it:
  `call-results-over-one-mut-place` (E0910) / `swap-get2-mut-pair` (accept);
  `holder-arg-beside-mut-lend`, both orders (E0910) / `two-phase-len` (accept);
  `mut-lend-readonly-callee-while-shared`, through a direct, a `Dyn` and a function-value call (E0911);
  `for-mut-walk-while-shared` (E0911);
  `byvalue-slot-arg-widens` (E0923) beside `store-widen-named-holder`;
  `nominal-holder-elided-stash` (E0923);
  `return-local-box-deref`, `return-option-of-byvalue-param` (E0912);
  `static-ref-from-local` (E0923) / the string-literal control;
  `impl-elided-composite-wider-than-trait` (rejected at the impl), `fn-value-wider-result-at-slot` (E0923);
  `block-tail-holder-over-block-local` (E0911);
  `loop-join-option-slot`, the twin of `loop-join-push` that does not depend on the container wall (E0911);
  `match-on-reference-binding-then-write-root` (E0911);
  `capture-ref-param-returned-dyn` (E0909) / `async-captures-ref-param` given a `main` and RUN (the row is
  check-only today, and its program crashes: A49).
- **The model** (`tests/origins/model.yo`): `eval_call` implements O3 step 2 as now written — argument values are
  loans; a `&mut` or moved argument's activation is checked against every other argument value's loans; no
  value-to-value comparison (the pairwise `.Ref` check goes).
- **Run the positive rows.** A corpus row that is only `export(probe)` proves the checker's verdict, not the
  program. A49 was a positive row that crashes when run. Positive rows should carry a `main` and run under ASan in
  the corpus job.
- **Generator axes (G-D).** Beyond roots × holders × creation sites × sinks: the ARGUMENT position of each value
  (by-name lend, bare named reference, holder, nested call result, inline constructor) beside a `&mut` or moved
  argument; the CALLEE form (direct, method, UFCS, function value, function-pointer parameter, `Impl(Fn)`,
  `Dyn(Fn)`, `Dyn(Trait)`, generic bound, effect operation); the VALUE position (block tail, `cond` arm, `match`
  arm, guard, loop condition, argument, capture-list entry, by-value capture); and the JOIN (every-arm assignment,
  loop back edge, early exit). The audit's probe programs, about 1,600 files with their verdicts, are the seed
  corpus; they live outside the tree (`tmp/probes/` of the audit worktree) until a home under `tests/origins/` is
  decided.

## 7. What held

Shapes that were attacked and are enforced on develop `64f33c710` (each line stands for a family of probes; the
codes are what the compiler answers).

- **Moves and drops.** A second use of a moved value is E0901 in every direct position; no partial moves out of a
  place; moves in loop bodies need no drop flags and are E0907 when unsound; drops run exactly once on the tested
  paths — early returns, `break`/`continue`, unwinds through `for(&mut …)` and through closures with `&mut`
  captures, and across `await` (conditional move, reassignment, loop, match payload, early return, throw) — with
  the exceptions §3 lists: a move in a guard or a loop condition (A36, A37), `x = x` (A38), and a temporary
  argument when a later argument exits (A45).
- **Markers and modes.** A write without a `mut` marker is E0917; a write through `&` is E0908; a write through an
  `Rc`/`Arc` payload is E0919; `Rc.get_mut`/`make_mut` conflict with a live borrow (E0911); `Fn`/`FnMut` closures
  cannot move a capture out (E0913).
- **Local loans.** A write, move or `&mut` lend of a place under a live `&`, and any access under a live `&mut`,
  are E0911 for direct forms across variables, fields, reborrow chains and projection results; liveness ends at
  last use; lend-then-write inside a loop is caught around the back edge.
- **Calls.** By-name overlap between a `&mut` or moved argument and another argument is E0910; a result reference
  freezes its argument roots (E0911), the union for an elided result; a result naming a local is E0912; a spelled
  origin that the body exceeds is E0923; rigid origins in generic bodies hold (a body that types only under its
  first caller's origins is rejected; the suspected "first caller leaks into the memo" did not reproduce).
- **Holders.** A struct, tuple, `Option` or enum payload holding a reference freezes its roots like the reference;
  a holder with a user `Drop` is live to its scope end (E0911 in about a dozen wrappers); a self-referential field
  write (`a.y = &a.x`) is rejected when the holder holds no other loan (A27 is the case where it does).
- **Borrowed `match` and `for`.** A write to the scrutinee or the walked collection under an arm or element binding
  is E0911 across `ArrayList`, `HashMap`, `Deque`, `BTreeMap`, `OrderedMap`, `HashSet` and `PriorityQueue`; guards,
  or-patterns and arm-result joins hold when the scrutinee is spelled `&place` (a reference BINDING as the
  scrutinee is A3); bound cursors freeze their collection.
- **Handles and cells.** O9's handle-origin rule holds across fields, containers and captures (E0911/E0910/E0909);
  `Escapable` holds for `Rc`/`Arc` payloads, `dyn(...)`, spawns and thread captures (E0909); `Rc(RefCell)`
  re-entrancy is a clean runtime panic; `get2_mut(k, k)` is a contract panic.
- **Closures and async.** A `&`/`&mut` capture freezes its place for the closure's life for direct writes
  (E0910/E0911); a store of a parameter into a `&mut` capture is E0923; a borrowing future freezes what it borrows
  until awaited, cannot be returned over a local (E0912), stored in an `Option` or spawned (E0909); `select` over
  overlapping `&mut` operands is E0910; a body-local borrow across an `await` is tracked. The by-value-capture
  holes present thirteen commits before the tip are fixed on it (#1891).
- **Effects.** A handler cannot capture the installer's bindings; an operation's reference result freezes its
  arguments (E0911); a handler storing the operation's parameter into another is E0923.
- **Boundary.** `Send`/`Sync` derivation rejects about fifteen capture shapes; D1's and D3's direct forms are
  rejected; decision 18 rule 3 holds for a call, an operator, a closure call, a `Dyn` call, an effect operation, a
  guard, an `await` and a loop back edge (E0911); the unsafe gate holds — `__yo_*` builtins, raw pointers, casts,
  integer-to-pointer, libc, `extern`, inline assembly, `c_include`, a manual `Send` and `addr_of` are all rejected
  in a safe file; bounds and overflow trap cleanly at `-O1` and `-O2`.

## 8. As built: walls and scheduled gaps confirmed

These are rejections the plan schedules; none is a finding.

- **N2c / N2d not landed.** Every container or cell over a reference or a holder is rejected ("carries an origin
  inside a container or a cell", E0909): `ArrayList(&T)`, `RefCell(Option(&T))`, `Box(&T)`, `Rc(H)`. No way past
  the wall was found. O3-3 through a `&RefCell(&T)` is therefore unreachable from safe code today, and
  `Dyn(Trait, p)` cannot be spelled in a body.
- **P1, P2, P4, P8b, P10, P12 not landed.** `&x` is not an expression (a block tail, a tuple component, `r := k`);
  `y := &xs(i)` "needs a place"; a closure borrowing a local cannot be returned; `&&T` cannot be spelled as a type
  (`&&` lexes as the logical operator).
- **R3** (a generic result at `T := &U` lowered as a projection) still rejects `Option(&T).unwrap()` and adapters
  over reference-item cursors; `RefCell.with(&mut pick)` at `R := &String` passes check and fails in C, and belongs
  in R3's tests (B6).
- **In flight when the audit ran, or opened from it:** A1 (lane `fix/p9-holder-arg`), A4 (a method call skips
  `lend_through`, lane o6-method-lend), the call-result origin-naming half of lane o6 (it closes the field and
  element forms of A5; the nested-call form remains), A7 and A8 (lane v57a), A6 (lane v57b), A9 and A49 (lane
  `fix/capture-param-origin`), A28 (lane `vbd/o6-mut-ref-ref-writeback`), A31's guard form (lane
  `fix/a31-holder-freeze`).
- **A residual the tree admits.** `f(&h.xs, h2)` below a `ref` object reads a stale copy after a reallocation
  (a use-after-free in safe code): `issues/fixed/2026-10-31-a-ref-root-place-lent-mut-and-shared-to-one-call-reads-a-stale-copy.md`
  records it as closing "structurally at V5 part B". It reproduces on the tip; the open document that tracks the
  family is `issues/2026-10-23-a-move-only-element-borrowed-for-a-call-is-freed-when-an-argument-clears-its-container-through-another-handle.md`
  (a sibling handle that clears; this form pushes and reallocates), which should list it.

## 9. Root-cause clusters and a fix order

The findings are few causes seen from many positions. Fixing by cluster closes the neighbours no probe reached.

1. **An argument's value is not a loan** (A1, A2, with their wider families). `_call_lends` sees top-level `&x`
   markers only. One change: every origin-carrying argument value is bound as a hidden temporary for the call, and
   activation runs `access` against the others.
2. **An access reaches the loan table weaker than its mode, or not at all** (A6, A13, A20, A32, A33, A34, A47). Each
   site has its own idea of "is this a write": the mutation mask, the capture-freeze check, the capture-list
   evaluator, the `consume` builtin. One change: a `&mut` lend, a move and a capture are `access(place, mode)` with
   the declared mode, from one helper.
3. **A value position computes no origin** (A3, A5, A10, A12, A14, A15, A17, A21, A22). Block and arm values,
   composite call results over a field lend, sub-patterns under a `Box`, a scrutinee that is a reference binding
   or a temporary. This is G-E's first check; landing it turns each into a compiler error at the node instead of a
   silent empty set.
4. **A flow join keeps one branch** (A11, A18, A19a, A19b, A25, A27). Every-arm assignment, the loop back edge, a store
   through a local or returned `&mut`. `bind`'s "join over reaching definitions, including the loop back edge" is
   specified and only partly built.
5. **A signature is trusted without its check** (A4, A7, A8, A24, A28, A29, A48). `static`, an impl against its
   trait, a function value against its slot, a nominal holder's elided origin, invariance under a by-value
   wrapper, a method's `lend_through`. All are `lend_through` / `return_check` applied at one more position.
6. **Rooting through an owning handle, and the reborrow union** (A23, A30, A31). Two walks treat every `.*` as a
   raw-pointer step.
7. **Captures** (A9, A35, A49, A50, A51, A52). A captured reference parameter, a by-value entry holding a
   reference, a by-value origin-carrying parameter of a future's maker, a by-value parameter of a generic body.
8. **Ownership in control positions and in codegen** (A16, A26, A36, A37, A38, A39, A45, A46, A53, A54). Moves
   inside a guard or a loop condition, `x = x`, a tuple on the left of `=`, a `&mut` field copied out, a shadowing
   binding's C name, a closure record passed by value, a temporary argument on an early exit, a borrowed temporary
   and a string interpolation across an `await`. These need no origin machinery; they are the cheapest S1s to
   close.
9. **The boundary** (A40–A44). Module-level `:=` bindings, the D1 reach walk against drop glue and callbacks, a
   public `MaybeUninit` field.

Order: cluster 8 first (small, independent, no design dependency), then 1 and 2 (they carry the release's
regressions and the widest families), then 5, then G-E / O-6 for 3, then 4, 6, 7 and 9.
