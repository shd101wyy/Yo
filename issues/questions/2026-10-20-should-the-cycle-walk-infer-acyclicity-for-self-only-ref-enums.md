# Should the cycle walk infer acyclicity for `Self`-only reference enums?

**Kind:** design question — an open decision, not a defect.

**Status:** open. Filed 2026-10-20 on `perf/acyclic-compiler-containers`
(stacked on #1486), which declares `impl(T, Acyclic())` on `AstExpr`,
`VcTerm` and `VcSort` (decision 9 of the 2026-10-20 schedule decisions).

## The question

`can_type_form_rc_cycle` (`src/types/utils.yo`) answers `true` for any
reference enum with a direct `Self` payload. `VcSort`
(`src/verifier/terms.yo`) has only `Self` payloads (`SeqS`, `FunS`,
`ArrS`) and holds no list or cell. The branch declares it `Acyclic`, which
needs `pragma(Pragma.AllowUnsafe)` and a `// SAFETY:` comment.
`tests/cycle_collector.test.yo` pins the same shape twice: `AcyTree` is
declared and reads `false`, and its undeclared twin `CycTree` reads `true`
and registers with the collector.

Should the walk infer what the declaration asserts? The rule would be: a
reference enum whose payloads are `Self`, plain data, or types that cannot
reach the enum through a written edge is not a cycle root.

## What holds today

Measured 2026-10-20 with #1486's tree binary:

- A `Self`-only reference enum CAN close a cycle in the shipped
  language, through a variant-field write. This bullet first said it
  could not, from probes that tried only rebinding and whole-value
  writes: `mut(s) := T.Leaf(1); s2 := s; s = T.Node(s2, s2);` rebinds `s`
  (`s2` still reads `Leaf`), `s.* = T.Node(s, s)` is rejected ("Failed to
  evaluate left-hand side of assignment"), and two module-level bindings
  `a :: T.Node(b, b); b :: T.Node(a, a);` are a "cyclic definition"
  error. The write those probes missed was found on the
  `docs/cycle-walk-holder-asymmetry` branch and re-measured here
  (2026-10-21, this branch's tree binary): with
  `X :: ref(enum(Leaf(n : i32), Node(l : Self, r : Self)))`,
  `t := X.Node(X.Leaf(1), X.Leaf(2)); t.l = t;` compiles, ten such cycles
  leave 10 objects tracked, and `Gc.collect()` reclaims all 10. So the
  walk's `true` for a `Self`-only enum is the correct answer for the
  language today, and the three declarations rest on their SAFETY
  audits (no variant-field write on a built node in `src/`), not on a
  language rule.
- The authoritative reference doc says the opposite.
  `plans/reference/REF_REFERENCE_SEMANTICS.md` §2.4: "a `ref(enum)` can be
  re-assigned to a different variant in place; all handles observe the
  change". It also says "Recursive construction ... allocate the handle,
  then set its recursive field(s) to the same handle". The build does
  neither, but the design text admits both, and either one closes a
  cycle through a `Self` payload.
- Decision 43 step 2 (the `&mut` rules) has not landed. If it admits a
  `&mut` binding into a reference enum's payload, the inferred answer
  becomes unsound without any change to the walk.
- The walk also feeds `Type.impls(T, Acyclic)` for a type with no
  declaration (`tests/ref_enum.test.yo`, "a ref enum with no RC cycle is
  Acyclic"). Inference would widen what the `Acyclic` bound of `iso()`,
  `Iso(T)`, `arc` and `RwLock` accepts, not only what the collector
  tracks.
- Only `VcSort` would benefit. `AstExpr` and `VcTerm` stay declared,
  because their `args : ArrayList(Self)` is a shared mutable cell today.
  Decision 21's 2026-10-18 amendment moves `VcSort` to `Box` children
  after V2b B6, and a `Box` tree is never tracked, so the inference would
  have no beneficiary once B6 lands.

## Options

1. **Infer now, for the narrow `Self`-only case.** This removes one
   unsafe declaration. It is unsound today: a variant-field write closes
   a cycle through a `Self` payload (see above), and REF_REFERENCE_SEMANTICS
   §2.4 admits more ways to close one. It flips the `CycTree` test and widens `Acyclic`.
2. **Keep the declarations; generalize later.** The precise rule is
   that a cycle needs at least one write after construction. The test file
   already uses this argument for a value enum with `Rc(Self)` children,
   and decision 46 makes an `Rc` payload read-only.
   plans/VALUES_BY_DEFAULT.md §3.12 already plans that narrowing as a
   follow-up of decision 46's Generation B: the tracking predicate becomes
   "reaches a `RefCell`/`Mutex`/`RwLock` whose payload reaches an `Rc`".
   It covers `Self`-only enums with no special case.

## Recommendation

Option 2. Do not add a `Self`-only special case to the walk. The
variant-field write measured above makes option 1 unsound as well as
implicit, so the recommendation is firmer than when it was filed.

- An inferred answer that depends on an invariant the authoritative doc
  contradicts is the implicit behavior Yo's "be explicit" principle
  rejects. A declaration is visible and unsafe-gated, carries its own
  SAFETY argument, and is re-audited when the rules around it change.
- The narrow rule would have one beneficiary today and none after V2b
  B6. The general rule in §3.12 is already scheduled, and it is the one
  worth building.
- When that narrowing lands, it needs three preconditions: §2.4 is amended
  to rebinding only (no in-place variant write, no handle-first recursive
  construction); decision 43 step 2 rules out writes into a reference
  enum's payload; and V2b Generation B makes `ArrayList` a unique-buffer
  value. Then the three declarations and both `AllowUnsafe` pragmas
  (`src/expr.yo` keeps its own for other reasons; `src/verifier/terms.yo`
  gained one for this) come out in the same PR, and the probe table in
  `issues/fixed/2026-10-18-a-linkedlist-of-managed-elements-forms-uncollected-cycles.md`
  is re-run to show the walk alone answers `false`.
