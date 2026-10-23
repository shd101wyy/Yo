# Verifier: the call-site frame keeps a list unchanged across a callee that grows it through a RefCell global

**Severity:** S1 — `yo verify --strict` reports `ok` (and a verify-mode `yo compile` erases the runtime check) for an `ensures` that is false at runtime, when a callee reaches the caller's `ArrayList` through a handle stored in a `RefCell` global.

- **Status:** open (filed 2026-10-23; found while checking a design-review claim that the verifier is unsound with interior mutability).
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

## Test

The fixture pair above. After the fix, add this to
`tests/internal/verifier_list_len.test.yo` (it fails today: the outcome is
`ok`):

```yo ignore
test("a callee that reaches a caller's list through a RefCell global does not leave it framed", {
  if(!_have_z3(), {
    return(());
  });
  reports := _load_reports(String.from("./tests/spec/fixtures/negative/frame_interior_mutation.yo"), io, true);
  assert(_count_outcome(&reports, String.from("ok")) == usize(0), `probe must not verify, got: [${_reports_dump(&reports)}]`);
});
```
