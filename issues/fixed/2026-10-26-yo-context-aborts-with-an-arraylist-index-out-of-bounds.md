# `yo context` aborts with an ArrayList index out of bounds

**Severity:** S2 — every `yo context` invocation that builds or reads the
context index aborts (`ArrayList: index out of bounds`, exit 134), so the
language-pack command and `yo context <name>` / `--search` / `--list` are
unusable on develop; the `context-*` and `cache-gc*` cli-cases go
GOLDEN-DIFF on it. The v0.2.70 seed runs the same commands clean.

## Symptom

```text
$ yo context --search Point        # any query; --list and <name> too
ArrayList: index out of bounds (at file://<REPO>/std/collections/array_list.yo:1043:9)
$ echo $?
134
```

Measured with a develop-built binary at `fdab9d551` (#1624) from an empty
directory with a pristine `HOME` (no cache to corrupt), for `--search`,
`--list` and a bare `<name>` lookup. The seed (v0.2.70, `/home/yiyiwang/.local/bin/yo`)
answers the same query with hits and exit 0.

## Root cause

Not yet localized. The panic is the bounds-checked `ArrayList.index`
(`std/collections/array_list.yo:1043`, the `__yo_panic("ArrayList: index out
of bounds")` arm), reached from the context-index build or read path
(`src/context_command.yo` / `src/doc/context_index.yo`). Regression window:
after the v0.2.70 tag (`4a6b4a1dc`, which includes #1591) and at or before
`fdab9d551`. The last change to both files in that window is #1616 (VBD
B4-1a, the explicit-copy sweep of the CLI and build files — 32 lines changed
in `context_command.yo`); #1622 (B7b, consuming iteration — `split`/`lines`
take their receiver by value) also changed the shapes those files iterate.
A failing test: the cli-cases `context-search`, `context-search-miss`,
`context-not-found`, `cache-gc`, `cache-gc-context` (each GOLDEN-DIFF with
rc=134 where the golden expects rc 0/1) — they pass again once this is fixed.

## Reproducer

```bash
mkdir -p /tmp/ctxprobe && cd /tmp/ctxprobe
HOME=/tmp/ctxprobe <tree-binary>/yo context --search Point; echo $?
# ArrayList: index out of bounds ... ; 134   (seed: hits, 0)
```

## Fix

Open — needs the offending `xs(i)` read localized (a debug build or a
bisect between `4a6b4a1dc` and `fdab9d551` settles the PR). Found during the
B6-c tests-half gate run; not caused by it (the branch changes only
`tests/*.test.yo`, and the binary that aborts was built from unmodified
develop before any edit).

## Fixed (2026-10-26, `fix(develop)` #1633)

b4-1a's hand edits (#1616) had moved the loop-counter increment above the
surviving `corpora(ci)` / `entries(i)` reads in `_load_world`
(src/context_command.yo) and `_sweep_dir` (src/fetch.yo); #1633 restores
read-then-increment (the explicit-copy spelling stays). The companion doc
with the `yo cache gc` side is
`issues/fixed/2026-10-26-yo-context-and-cache-gc-abort-after-b4-1a-hand-edits-index-past-the-last-entry.md`.
The cli-cases context-search / context-search-miss / context-not-found /
cache-gc / cache-gc-context pass again.
