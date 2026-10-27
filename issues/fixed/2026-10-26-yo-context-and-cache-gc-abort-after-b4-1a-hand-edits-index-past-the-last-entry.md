# `yo context` and `yo cache gc` abort (rc 134) — b4-1a hand edits moved loop increments above remaining index reads

**Severity:** S2 — every `yo context` query and every `yo cache gc` on a cache with a non-empty `context/` directory hard-aborts with `ArrayList: index out of bounds` (rc 134); on the CI sandbox the same crash surfaced as `yo: error: is a directory`, turning 14 cli-case goldens red (12 `context-*`, `cache-gc`, `cache-gc-context`) in the develop battery on af67fdf59.

## Symptom

Battery 40261184520, job "Self-hosted `test` subcommand (yo-self tier-1 gates)":

```
GOLDEN-DIFF cache-gc           (rc=134; rc(golden=0,run=134) stdout tree home)
GOLDEN-DIFF cache-gc-context   (rc=1;   rc(golden=0,run=1)   stdout tree)
GOLDEN-DIFF context-ambiguous  (rc=134; ...)
... (all context-* cases)
  > yo: error: is a directory
```

Locally (tree binary at af67fdf59, gcc build):

```
$ yo context --list --path src      # in tests/cli-cases/context-list/fixture
ArrayList: index out of bounds (at file://…/std/collections/array_list.yo:1007:9)   rc=134

$ yo cache gc                       # YO_CACHE_DIR over tests/cli-cases/cache-gc-context/fixture
ArrayList: index out of bounds (at file://…/std/collections/array_list.yo:1007:9)   rc=134
```

The seed (v0.2.70) passes both, including with the tree's std (`--std-path ./std`): the
regression is in the tree's src, not std.

## Root cause

#1616's explicit-copy sweep (b4-1a) hand edits removed the `x := xs(i)` element locals from
two loops, and in both the loop-counter increment ended up ABOVE a surviving `xs(i)` read, so
the last iteration reads `xs(len)` — the panicking index.

`src/context_command.yo`, `_load_world` — the corpora loop indexed at the already-incremented
`ci`, so the argument to `context_index_ensure` faults before any index is built (which is why
no `Building the context index …` line appears):

```yo ignore
while(ci < corpora.len(), {
  ci = (ci + usize(1));                                        // moved up by the hand edit
  key := context_index_ensure(&corpora(ci).root, …, &corpora(ci).prefix, io, exn);
  // corpora.len() == 1 on every plain query → corpora(1) → out of bounds
```

`src/fetch.yo`, `_sweep_dir` — `entries(i).name` was read before the increment but
`entries(i).file_type` after it:

```yo ignore
while(i < entries.len(), {
  name := entries(i).name.clone();
  i = (i + usize(1));                                          // between the two reads
  …
  is_dir := match(entries(i).file_type, .Directory => true, _ => false);   // entries(len)
```

Every `yo cache gc` whose `context/` (or swept store/mirror/index) directory is non-empty
panics on its last entry. The CI `cache-gc-context` variant failed earlier in the flow
(`context_tree_key` under the harness's `YO_STD`) and printed the OS error text instead; both
shapes are the same two broken loops surfacing at different depths.

## Fix

Restore the read-then-increment order (keeping the b4-1a explicit-copy spelling — no
element copy is reintroduced):

- `_load_world`: index `corpora(ci)` for the `context_index_ensure` call, then increment.
- `_sweep_dir`: read `entries(i).name` and `entries(i).file_type` before the increment.

## Verification

- `yo context --list --path src` in the `context-list` fixture: rc 0, module listing matches
  the golden (checked through `scripts/cli-diff-test.sh` — the same harness CI uses).
- `yo cache gc` over the `cache-gc-context` fixture: rc 0, `removed … 1 context index(es)`,
  matching the golden.
- Full `scripts/cli-diff-test.sh` against the tree binary: 0 GOLDEN-DIFF.
- `check ./src` and `check ./std` pass with the tree binary.

The existing cli-case goldens (`context-*`, `cache-gc`, `cache-gc-context`) are the regression
tests: they failed before the fix and pass after.
