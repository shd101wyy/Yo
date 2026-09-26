# The verifier's real-Z3 harness self-test leaks 40 bytes (Linux CI, red on develop's tip)

Found 2026-09-26 while gating PR #951. **Open** — root cause not yet found.

## Verbatim error (ubuntu-latest, "Formal verification (pinned Z3)")

```
✗ real z3: harness self-test proves 1+1==2 and refutes 1+1==3 (YO_TEST_Z3=1)
  Memory leak detected:

  ==3394==ERROR: LeakSanitizer: detected memory leaks
  Direct leak of 40 byte(s) in 1 object(s) allocated from:
      #0 malloc
      #1 __yo_rc_alloc
      #2 __yo_new___yo_t_16987456896208270856
      #3 __yo_fs_13613462911825284746
      #4 yo_id_13897678033689681031000000
      #5 yo_id_3275064616313847687000000
```

(`tests/internal/verifier.test.yo`, the batch compiled by the job's stage-1.)

## What the run history says

| run | tree | seed | FV job |
| --- | --- | --- | --- |
| 36244344038 | `37045aa56` (#945, docs-only) | v0.2.43 | **success** |
| 36257033072 | `cc6c9108a` (release bump) — code identical to `37045aa56` | **v0.2.44** | fail |
| 36258899157 (PR #951) | `6af426bbc` + capture-val | v0.2.43 | fail |

The two failures changed different variables (one the seed, one the tree),
which means the leak is either nondeterministic (hash-iteration order has
precedent in this repo) or sits on a path both changes reach. It is NOT
caused by #951's capture-source refactor: that PR's emitted C is
byte-identical to develop's (`cmp`, 121,089,132 bytes).


## Root cause found (2026-09-27, same session)

`_verdict_to_json`'s result flows through `vi := list(i)`-shaped reads inside
`_stringify_into`'s Object arm; the underlying compiler bug is documented in
`issues/local-binding-of-an-indexed-read-never-releases-its-element.md`:
a `:=` binding of an indexed read of a value-type element with RC fields leaks
one reference per binding (the deferred dup is emitted, then discarded; the
binding takes the pre-dup temp and gets no scope-end drop). Fix belongs there;
this issue closes with it.

## Next steps

1. Reproduce locally with the pinned z3 (`Z3_VERSION :: "5.1.0"` in
   `src/verifier/z3.yo`) and `YO_TEST_Z3=1` on `tests/internal/verifier.test.yo`.
2. Name the frames with `YO_DEBUG_FN_ORIGIN=1` + the rewritten
   `scripts/bootstrap/fid_name_map.py`.
3. Loop the leaking operation (a per-iteration leak scales linearly) and fix
   the missing release.
