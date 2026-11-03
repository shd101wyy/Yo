# A local borrow through a written `Rc` deref is rejected as a pointer dereference

**Severity:** S3 — in a safe file `x := &h.*.x` (and `&h.*`) on an `Rc`, an `Arc` or a cell handle is rejected with a message about raw pointers, while the auto-dereference spelling `x := &h.x` of the same place is accepted; the workaround is that spelling.

**Status:** fixed 2026-11-02 by decision 43 step 2's N1d (O9). Found 2026-10-24 while teaching the compiler V5's cell-handle
shape (`plans/VALUES_BY_DEFAULT.md` §3.5, `feat/v5-seed-predicates`): the
safe-file test of the borrow pin had to spell the borrow `&h.x`.

## Evidence

`issues/repros/2026-10-24-a-local-borrow-through-a-written-rc-deref-is-rejected-as-a-pointer-dereference.yo`,
`yo check` with a develop build (`c0cd51a30`):

```text
error: A local borrow cannot reach through a pointer dereference (`p.*`): the storage has no owner the borrow could keep alive. Iterate the collection with `for(&mut coll, x => ...)` to borrow an element, or copy the value out.
   --> issues/repros/2026-10-24-a-local-borrow-through-a-written-rc-deref-is-rejected-as-a-pointer-dereference.yo:10:11
   |
10 |   b := &h.*.x;
   |           ^
```

Line 8 of the repro, `a := &h.x`, passes. After evaluation both spellings are
the same tree: auto-dereference rewrites `h.x` to `h.*.x` in place
(`evaluate_property_access`).

## Root cause

`_evaluate_inout_local_binding` (`src/evaluator/exprs/initialization_assignment.yo`)
rejects every `*` hop of the place, outside an unsafe-capable file, on the AST
and before the place is evaluated, so it cannot tell a raw-pointer
dereference from the deref of a counted handle. For a handle the storage does
have an owner: the pin walk further down takes the handle the hop goes
through (`is_counted_handle_type`), which is what keeps `&h.x` sound.

## Fix direction

Judge a `*` hop after the place is evaluated, by its receiver's type: reject
it only when the receiver is not a counted handle (a raw pointer, a `Box`).
The spellings then agree. Not done in the V5 seed-predicate PR: decision 43's
N0 corpus records today's rejection for two of its rows
(`tests/origins/corpus.tsv`, `rc-handle-dropped` and `rc-handle-reassigned`,
which expect E0911 once decision 43's rules land), so the change belongs with
decision 43's N1 work, which re-records those rows.

## Test

No new test file: decision 43's corpus already pins this rejection.
`tests/origins/corpus.tsv` rows `rc-handle-dropped` and
`rc-handle-reassigned` (run by `tests/origins/model_corpus.test.yo`) expect
today's message ("A local borrow cannot reach through a pointer
dereference") and name E0911 as the verdict once N1 lands, so they fail the
moment the fix changes the diagnostic and are re-recorded with it.

## Fix (2026-11-02, decision 43 step 2, N1d)

`_evaluate_inout_local_binding` now judges each `*` hop after the place is
evaluated, by its receiver's type: the deref of a handle whose payload is
read-only through it (`handle_payload_is_read_only`: an `Rc`, an `Arc` or
a cell handle) is accepted, and the borrow is rooted at the handle, which
stays frozen while it lives (`plans/backlog/REFERENCES_AND_ORIGINS.md` O9).
A raw pointer or a unique `Box` deref keeps the old rejection, and a
`&mut` borrow through a handle is E0919. `&h.*.x` and `&h.x` now agree.
The capture form `{ x : &h.*.x }` follows the same rule.

Tests: `tests/borrow_spelling.test.yo` ("Escapable holds for a type without
origins, and a borrow reaches through a handle", and the frozen-handle
`comptime_expect_error` cases after it), `tests/closure_capture_list.test.yo`
("a `&` borrow through an `Rc`/`Arc` deref, never a `&mut` one"), and the
corpus rows `rc-handle-dropped` / `rc-handle-reassigned`, re-recorded to E0911.
