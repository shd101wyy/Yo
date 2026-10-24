# Verifier: the call-site frame keeps a list unchanged across a callee that grows it through a RefCell global

**Severity:** S1 — `yo verify --strict` reports `ok` (and a verify-mode `yo compile` erases the runtime check) for an `ensures` that is false at runtime, when a callee reaches the caller's `ArrayList` through a handle stored in a `RefCell` global.

- **Status:** fixed (filed and fixed 2026-10-23; found while checking a design-review claim that the verifier is unsound with interior mutability).
- **Component:** `src/verifier/vc.yo`, the call-site frame (`_callee_call_term`).
- **Measured with:** seed `yo 0.2.68` and a tree build of `60d97bbd7`; both report `ok`.

## Reproducer

`tests/spec/fixtures/negative/frame_interior_mutation.yo` (verify mode) and
its runtime-mode callee `tests/spec/fixtures/negative/frame_interior_mutation_stash.yo`:

```yo ignore
// stash (no pragma): `remember` stores a second handle to the list
// (ArrayList is a reference type) in a RefCell global; `poke` grows it.
(STASH : RefCell(ArrayList(ArrayList(i32)))) = RefCell(ArrayList(ArrayList(i32))).new(ArrayList(ArrayList(i32)).new());
poke :: (fn(ensures(true)) -> unit)({
  STASH.with_mut(s => {
    match(s.get(usize(0)), .Some(l) => { l.push(i32(7)); }, .None => ());
  });
});

// fixture (pragma(Pragma.Verify))
probe :: (fn(xs : ArrayList(i32), requires(xs.len() == usize(0)), ensures(r == usize(0))) -> (r : usize))({
  poke();
  xs.len()
});
```

```text
$ yo verify tests/spec/fixtures/negative/frame_interior_mutation.yo --strict
  ok       fn@tests/spec/fixtures/negative/frame_interior_mutation.yo:15 [verify] — 1 obligation(s) proved
verify: 1 ok, 0 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error ...
rc=0
$ yo compile issues/repros/2026-10-23-the-call-site-frame-misses-a-list-reached-through-a-refcell-global.yo -o repro && ./repro
  ok       fn@...:15 [verify] — 1 obligation(s) proved
1
rc=0
```

`issues/repros/2026-10-23-the-call-site-frame-misses-a-list-reached-through-a-refcell-global.yo`
is a verify-mode entry with the same `probe` and a `main` that calls
`remember(xs)` then `probe(xs)`. The proof erases the `ensures` assert, so
the binary prints `1` for a function proved to return `0`. A runtime-mode
entry that imports the fixture keeps the assert and aborts with
`ensures failed: r == usize(0)`.

## Root cause

The call-site frame decides which caller names a call may change from the
callee's contract alone:

- `src/verifier/vc.yo:6365-6415` (`_callee_call_term`, "R1 slice 2 — the
  MUTATION model") rebinds a list-typed argument only when it is a bare name
  passed to the call AND the callee's contract mentions `old(<param>)`.
  Every other name keeps its pre-call term; the comment at
  `src/verifier/vc.yo:4167-4169` states the assumption ("every other name is
  unchanged by the call").
- `ArrayList` is a reference type, and decision 46's `RefCell` (and `Rc`,
  globals) can hold a second handle to a list the caller has as a parameter.
  A callee can then change the caller's list without receiving it, and no
  contract can say so: `poke` has no parameter for an `old(...)` clause to
  name, and its `ensures(true)` is true. The aliasing guard of
  `issues/fixed/verifier-list-model-ignores-aliasing.md`
  (`src/verifier/vc.yo:6972-7010`) only covers a body that itself mutates a
  list; `probe` mutates nothing.
- `poke` is trusted because its file is in runtime mode
  (`docs/en-US/FORMAL_VERIFICATION.md` §modular: "A function in a
  `runtime`-mode file still carries usable contracts at verified call
  sites"). Its `ensures` is checked at run time. The implicit frame is
  checked nowhere. Verifying `poke`'s own file reports it as a
  `subset-error`, because `with_mut` is an uncontracted call, so a
  `--strict` run over the whole directory fails. Verifying only the caller's
  file, which is the documented modular workflow, reports a clean `ok`.

## What is sound (the review claim as stated)

A verified function cannot take or read a cell. A `&RefCell(i32)`,
`Rc(RefCell(i32))`, `&AtomicI32` or `&S` (a struct with a `RefCell` field)
parameter is `subset-error: parameter outside the integer/bool/array subset`
(`src/verifier/vc.yo:6863`). `G.with(...)`, `G.with_mut(...)`,
`A.load(...)` and `A.fetch_add(...)` on globals are `subset-error: call to a
callee without contracts`. Reading the cell through a wrapper fn is
`outside-subset`. The cell's contents are never a modeled term. The hole
needs a modeled reference value, which today means an `ArrayList`, reachable
through the cell.

## Related

- `issues/questions/modifies-clause-for-callee-side-effects.md`: "no
  `old(p)` means unchanged" for `assumed()` contracts. The same convention
  covers runtime-mode callees, and it cannot be met for state that is not a
  parameter. A runtime-mode callee that pushes onto its own list parameter
  under `ensures(true)` is proved unchanged the same way, without any cell.
- `issues/fixed/verifier-list-model-ignores-aliasing.md`: the per-name list
  model and its body-local aliasing guard.

## Fix

The call site now asks whether the callee's **frame** is checked before it
keeps the caller's state across the call (`_callee_frame_open`,
`src/verifier/vc.yo`).

- Closed (today's rule applies): a `ghost_fn` (erased at runtime); an
  `assumed()` contract, which the author vouches is the whole truth,
  frame included; and a function whose body THIS run verifies in `verify`
  mode (its task is in the batch, so a failure there fails the run) and
  that calls no contracted callee whose frame is open. Such a body cannot
  read a global (the walk rejects one), its list parameters are checked
  against `old(...)`, and an uncontracted callee fails its walk unless it
  is spec-transparent. A call is its only route to other state.
  The classification scans the callee's body through the batch's task
  table (`register_frame_tasks`, called by the driver beside the
  recursion-clique prepass). It follows calls transitively, and a call
  cycle answers "closed" provisionally without being memoized.
- Open: a `runtime`-mode or `verify+` callee, a verify-mode callee that
  calls one (the transitive variant), and a verify-mode callee this run
  does not verify (an imported file outside the targets), whatever its
  pragma says.

At an open callee, every list argument is bound to a fresh post-call term
while the ensures are assumed, with `old(p)` reading the pre-call term.
After the call, every name in scope whose value can hold a list is rebound
to a fresh constant: lists, value enums and fixed arrays holding one, and
generic parameters (`_frame_havoc_lists`). The sort comes from the bound
term's structure (`_vc_term_sort`): a constant's declared sort, a
constructor's datatype, a field projection's accessor sort (recorded when
`_note_enum_datatype` declares the enum), an `ite`'s branches. A call to an open callee inside
another callee's contract clause, where the callee's labels shadow the
caller's names, is a subset error. A spec-transparent attempt that makes
such a call is not transparent. Loops and `cond`/`match` merges see the
same effect through the `#frame` mark of `_call_written_names`.

The related variant is covered by the same rule. A runtime-mode callee
that pushes onto its own list parameter under `ensures(true)` is an open
frame, so its list argument is rebound and the caller learns nothing about
it beyond the ensures (`tests/spec/fixtures/negative/frame_runtime_param_mutation.yo`).
`assumed()` contracts keep the "no `old(p)` means unchanged" convention;
see the update in `issues/questions/modifies-clause-for-callee-side-effects.md`.

Three more S1s found during triage and the fix are fixed in the same
change:

- `issues/fixed/2026-10-23-a-mut-ref-argument-keeps-its-pre-call-value-at-a-call-site.md`
- `issues/fixed/2026-10-23-a-loop-or-branch-misses-a-list-a-free-function-call-changes.md`
- `issues/fixed/2026-10-23-a-write-in-one-match-arm-holds-on-every-path.md`

### Review findings (2026-10-23)

A review of the first version of this fix found three holes, all fixed
here:

1. The `match` arm merge (`issues/fixed/2026-10-23-a-write-in-one-match-arm-holds-on-every-path.md`)
   exposed a pre-existing hole: the walk ignored an early `return(lit)`.
   Filed and fixed as
   `issues/fixed/2026-10-23-the-verifier-walk-ignores-an-early-return.md`.
   Two more pre-existing S1s in the same branch rules turned up while
   fixing it:
   `issues/fixed/2026-10-23-a-break-in-a-match-arm-ends-the-walk-of-the-enclosing-block.md`
   and
   `issues/fixed/2026-10-23-a-dead-cond-arm-assumes-its-guard-false-after-the-cond.md`.
2. A list bound by a pattern (an `Option` payload) is a projection term,
   which the havoc's shape-based sort guess (`_havoc_binding_sort`) took
   for a bool, so it was never rebound after `poke()`. The havoc now reads
   the term's sort from its structure
   (`tests/spec/fixtures/negative/frame_pattern_bound_list.yo`).
3. A verify-mode callee in an imported file was closed whenever its body's
   types were at hand, which is the case under `yo compile`. Its shared
   table keeps every module's types, but `yo compile` verifies only the
   targets. The issue's own reproducer, with the stash file marked
   `pragma(Pragma.Verify)`, still printed 1. A callee is closed now only
   if its task is in the batch
   (`tests/spec/fixtures/negative/frame_unverified_import{,_stash}.yo`).

### Measured effect

Each `std/spec`, `std/collections`, `tests/spec/*.test.yo`,
`tests/spec/fixtures/valid` and `tests/spec/fixtures/elision` path, plus
every `tests/spec/fixtures/negative/*.yo` and `tests/spec/fixtures/valid/*.yo`
file, was verified with `yo verify --format json` by the develop binary and
by the fixed one. No existing function changed outcome. `std/collections`
stays at 9 assumed, 1 ok and 3 outside-subset, `std/spec` reports nothing,
and `fixtures/elision` stays at 20 ok, 16 outside-subset and 1
subset-error. In `fixtures/valid` the only change is the new
`inout_call_old.yo` going from subset-error to ok (145 ok before, 146
after). The six new negative fixtures go from `ok` to `refuted`, and
`yo compile` of the repro now stops at the refuted `probe`.

The review fixes were measured the same way against the first version of
this fix: no existing function changed outcome, and the counts above are
unchanged. On develop the five new fixtures report `ok` for every false
claim except `r_match` in `early_return_in_branch.yo`, which develop
refutes only because of the arm-write leak fixed above. With the fix, `frame_pattern_bound_list.yo`,
`frame_unverified_import.yo`, `match_arm_break.yo`'s `acc_stays_zero` and
`cond_dead_arm_overlap.yo`'s `overlap` are refuted, and both functions in
`early_return_in_branch.yo` are subset errors. `yo compile` of the review's
`pragma(Pragma.Verify)` stash variant now stops at the refuted `probe`.

## Test

The fixture pair above, the related variant
`tests/spec/fixtures/negative/frame_runtime_param_mutation{,_grow}.yo` and
the transitive variant `tests/spec/fixtures/negative/frame_transitive.yo`.
`tests/internal/verifier_list_len.test.yo` pins all three, and the review's
two frame holes (`frame_pattern_bound_list.yo`,
`frame_unverified_import{,_stash}.yo`, the latter loaded with a shared
table as `yo compile` uses). The first test
is the block this doc asked for, and it reported `ok` before the fix:

```yo ignore
test("a callee that reaches a caller's list through a RefCell global does not leave it framed", {
  if(!_have_z3(), {
    return(());
  });
  reports := _load_reports(String.from("./tests/spec/fixtures/negative/frame_interior_mutation.yo"), io, true);
  assert(_count_outcome(&reports, String.from("ok")) == usize(0), `probe must not verify, got: [${_reports_dump(&reports)}]`);
});
```
