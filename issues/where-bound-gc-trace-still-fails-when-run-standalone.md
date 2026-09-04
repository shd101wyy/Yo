# The `where-bound` GC-trace regression test FAILS when run standalone — the suite's batching hides it

**Status: OPEN.** Found 2026-08-25 on `develop` at `12d226078`, while landing
the STD_API_AUDIT MapEntry unification (S2 chunk 3). **Not caused by that work
— it reproduces on unmodified `develop`.**

`tests/where_clause_fn_inference.test.yo` is the red-first regression test for
`issues/fixed/where-bound-intoiterator-gc-trace-abstract-key.md` (fixed
2026-08-24, `#249`). Run it by itself and it still fails, with the exact symptom
that issue says was fixed.

## Reproduce

```
$ git log --oneline -1
12d226078 std: S2 chunk 2 — the fs and net API renames ... (#273)

$ yo test tests/where_clause_fn_inference.test.yo --parallel 1
tests/.yo_selftest_batch_1_0.bin.c:2605:3: error: call to undeclared function
  'yo_id_4260_rtparam0_R_gs_yo_id_4135_gs_yo_id_6511_1923_1924_rtparam1_...__ret_unit'
... 3 such calls (2605, 2634, 2639), each a different raw-SomeT id pair
22 warnings and 3 errors generated.
yo: error: compile: C compiler failed (exit 1)
```

The full suite passes 2905/2905 — including this file. **The difference is batch
composition**: the runner packs many `.test.yo` files into one
`__yo_user_main` batch, and which types get instantiated together in a batch
decides whether the era-copy identities are minted. Alone, this file is batch
`1_0` and the trigger fires; inside the suite it lands in a batch where it does
not.

## Why the existing fix does not cover it

The caller is the GC traverse emitter:

```c
static void __yo_traverse___yo_t48(void* ptr, void (*visit)(void*)) {
  yo_id_4260_..._1923_1924_..._ret_unit(obj, (void*)visit);   // never declared
```

`src/codegen/functions/constructors.yo:343` already routes through
`get_trace_function_for_type`, and `#249` added the guard there
(`src/codegen/exprs/drop_dup.yo:118`): refuse to delegate to a spec that
`should_skip_function_codegen` will never emit. So in this configuration the
predicate and the emitter DISAGREE — `should_skip_function_codegen` reports the
spec as emittable, and the function emitter skips it anyway. The guard is
sound; its oracle is not.

The likely axis is `type_key` (`src/types/type_key.yo:190+`), which keys a
generic instantiation by `(constructor_func_id, type_arguments)`. For era-copy
phantoms the type arguments are raw SomeTs, so the trace registration a lookup
finds can be one minted by a different, hard-generic instantiation.

## Why this matters beyond the one test

**A regression test that cannot fail the suite is not a gate.** This one pins a
bug class the audit keeps brushing against — it is "face 3" of the era-copy
under-resolution family, whose root is explicitly still OPEN:

- `issues/iterator-chain-shared-stamp-cross-item-pollution.md` (face 2)
- `issues/varbound-combinator-receiver-impl-match.md` (face 1, flat_map residual)

Until the root is fixed, the batch-composition dependence means any future
change can silently re-trigger the C-compile failure and the suite will stay
green.

## A SECOND instance, in a different subsystem (2026-08-25)

This is not one odd test. `tests/fs/temp.test.yo` shows the same split on the
same `develop`:

```
$ yo test tests/fs/temp.test.yo --parallel 1
  ✗ TempDir Dispose removes the directory on drop      exit code 6
  ✗ TempFile Dispose removes the file on drop          exit code 6
  8 passed  2 failed                                   (rc=1)

$ yo test ./tests --exclude tests/internal --exclude tests/cli-cases
  2905 passed 2905 total                               (rc=0)
```

Both tests are inside the suite's scope — `tests/fs/` is not excluded — so the
suite runs them and they pass there. Two Dispose-on-drop assertions fail only
when the file is batched alone.

That makes the pattern general rather than a quirk of the era-copy family: the
runner's BATCH COMPOSITION changes program behaviour, so "the suite is green"
and "each test file is green" are different claims, and today only the first is
checked. Anything that depends on drop timing, type instantiation order, or
GC/RC interaction can differ between the two.

## Suggested handling

1. Make the failure visible: this file should be run in a batch where the
   trigger fires — either pinned as its own single-file case in CI, or with the
   two `__WbInto` instantiations kept in one batch by construction.
2. Fix the oracle: reconcile `should_skip_function_codegen` with what the
   function emitter actually does for hard-generic trace specs, so the `#249`
   guard fires in this configuration too.
3. The era-copy root remains the real fix (see the two sibling issues).

## Evidence that it is not the MapEntry unification

The unification (four identical `struct(key, value)` types — `Bucket`,
`BTreeEntry`, `OrderedMapEntry`, `Pair` — collapsed to one `MapEntry`) was
suspected first, because sharing one `constructor_func_id` collapses `type_key`
entries that used to differ. Two checks ruled it out:

- Reverting `btree_map` to its OWN local `MapEntry` constructor (a pure rename,
  no sharing) still fails identically.
- Unmodified `develop` fails identically — same `yo_id_4260`, same 3 calls.
