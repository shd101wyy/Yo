# develop red: the FV job's z3 self-test leaks 40 bytes — only under the v0.2.44 seed's emit

**Status: OPEN** — filed 2026-09-26; develop's battery has been red on this
since the 16:52 run (every run since the release's SEED_VERSION bump to
v0.2.44). It blocks every merge in the repository, including the whole
DROP_LIBURING stack. Not caused by that stack: the red predates it (develop
has none of its commits) and the stack's PR batteries skip the FV job
(stacked reduced battery).

## Symptom (CI, `Formal verification (pinned Z3)`)

```
  ✗ real z3: harness self-test proves 1+1==2 and refutes 1+1==3 (YO_TEST_Z3=1)
    Memory leak detected:
    ==NNNN==ERROR: LeakSanitizer: detected memory leaks
    Direct leak of 40 byte(s) in 1 object(s) allocated from:
        #1 __yo_rc_alloc
        #2 __yo_new___yo_t_16987456896208270856
        #3 __yo_fs_13613462911825284746
```

Deterministic: two failed develop batteries (16:52, 19:32) and the same
failure inherited by any PR whose battery runs the FV job; a re-run of the
failed job reproduces.

## Reproduction matrix (2026-09-26)

| Compiler building the test | Solver | Result |
| --- | --- | --- |
| develop-built (36ec17b8c-era and #951 tip, local) | z3 4.16 via `YO_Z3_PATH` | **passes**, no leak |
| v0.2.44 seed (CI installs it after the release bump) | pinned z3 5.1.0 | **fails**, 40-byte leak |

The FV job compiles `tests/internal/verifier.test.yo` with the SEED, so the
emitted drop code is the seed's, not the tree's — the leak is a seed-emit
× current-tree interaction (the `__yo_fs_*` rc path), i.e. the same class
as the seed-lag table in `plans/DROP_LIBURING.md` §5 but in drop
accounting. Prime suspects: the capture-source change (#951) and anything
in the 15:32–16:52 window that shifted a `std/fs` value's rc shape under
the newer seed's emit.

## Fix direction

Reproduce with the actual matrix: install the v0.2.44 seed locally, run
`YO_TEST_Z3=1 yo test ./tests/internal/verifier.test.yo --test-name-pattern
"real z3"` with the pinned 5.1.0 (`yo verify std/collections/array_list.yo`
installs it), and diff the emitted batch C between the seed-built and
develop-built compilers around `__yo_fs_13613462911825284746`'s
allocation/drop pair. Whoever owns the evaluator's dup/drop accounting
(TYPE_SYSTEM_SOUNDNESS) is the natural owner.
