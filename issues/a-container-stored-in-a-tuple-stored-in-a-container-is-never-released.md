# A container stored in a tuple stored in a container is never released — LeakSanitizer fails `tests/basic.test.yo`

**Severity:** S3 (downgraded from S1 — see "CI cross-check", resolved) — on Linux/WSL2 every `ArrayList(Tuple(i32, ArrayList(i32)))` that dies leaks its inner container (measured 48 bytes / 2 allocations per instance, scaling linearly) and `tests/basic.test.yo` is RED under the default sanitized test run; stock CI Linux does NOT reproduce it, so it is plausibly an LSan false positive local to WSL2's runtime/kernel. Still worth root-causing (every WSL2 developer sees a red basic suite), but it gates nothing.

**Found:** 2026-09-30, the `plans/reference/MATCH_PATTERN_MATCHING.md` closeout audit (a dynamic verification run of the match suite; the failing test contains no match code — the bug is orthogonal to the match work and predates it).

**Status:** OPEN. Reproduces identically with the released seed `yo 0.2.46` (installed binary) and with a tree-built stage-1 (from `2a24df8c1`), so it is NOT a regression from the 2026-09-30 tree — it ships in the current release's codegen.

## Verbatim

```
$ yo test tests/basic.test.yo --parallel 1
...
==PID==ERROR: LeakSanitizer: detected memory leaks
SUMMARY: AddressSanitizer: 180 byte(s) leaked in 10 allocation(s).
...
Test Summary: 52 passed, 1 failed, 53 total
```

Failing test: `a tuple element type inside a generic container declares its C
name in time` (`tests/basic.test.yo:2606`, added by #507, 2026-09-09). Isolated
rerun with `--test-name-pattern` reproduces; the full-file run reproduces; the
seed binary reproduces both ways too.

## Minimal reproducer

`issues/repros/arraylist-in-tuple-in-arraylist-never-released.yo`:

```rust
nested :: (fn() -> i32)({
  ys := ArrayList(Tuple(i32, ArrayList(i32))).new();
  inner := ArrayList(i32).new();
  inner.push(i32(7));
  ys.push((i32(1), inner));
  ys(usize(0)).1(usize(0))
});
```

```bash
yo compile issues/repros/arraylist-in-tuple-in-arraylist-never-released.yo \
  --std-path ./std --sanitize address -o /tmp/leak && /tmp/leak
# ==PID==ERROR: LeakSanitizer: detected memory leaks
# SUMMARY: AddressSanitizer: 48 byte(s) leaked in 2 allocation(s).
```

Calling `nested()` three times leaks 144 bytes / 6 allocations — exactly 3 ×
(48 B / 2 alloc): **the leak is per container instance, unbounded in a loop.**

## What it is and is not

| shape | verdict |
| --- | --- |
| `ArrayList(Tuple(String, String))`, pushes + index reads, scope death | **clean** (also clean with 2000 pushes) |
| a scoped `ArrayList(Tuple(String, String))` alive at `main`'s exit | clean (reachable at exit — LSan does not flag) |
| `ArrayList(Tuple(i32, ArrayList(i32)))` — one push, scope death | **leaks 48 B / 2 alloc, per instance** |

So the missing release is specific to a tuple ELEMENT that itself owns a
container: when the outer list dies, the tuple element's inner `ArrayList`
(buffer + header, by the 2-allocation signature) is never released. The
`Tuple(String, String)` case drops its elements fine, and a bare inner list
dropped directly is fine — it is the composition (container → tuple →
container) that loses the drop.

## Root-cause pointers (not yet root-caused)

The scope-end drop walk that decides which locals get a release must descend
into a tuple-typed element of a container element and release the container it
owns. Compare the AGENTS.md pitfalls on manufactured moves and drop emission
(`_optimize_dup_drop_pairs`, `emitted_deferred_drop_ids`,
`issues/fixed/a-local-stored-in-a-struct-field-is-dangling-after-the-container-dies.md`
for the mirror-image over-drop): any fix needs the dup/drop emit-diff gate plus
an over-drop canary (the over-drop direction is a use-after-free), and a
Dispose-counter regression test shaped like the reproducer above.

## CI cross-check (resolved 2026-09-30)

Measured on Linux/WSL2. PR #1049's battery (2026-09-30) ran the language
suite GREEN on both stock Linux legs — `test (ubuntu-latest)` and
`test (ubuntu-24.04-arm)`, `basic.test.yo` included — while the same test
stays red on this WSL2 box under two different binaries (the v0.2.46 seed
and a tree stage-1). Per this doc's own rule the finding is downgraded to
S3: most likely an LSan root-scanning false positive specific to the
WSL2/nix toolchain combination rather than a real unreachable leak. The
minimal reproducer still shows the signature for anyone digging further;
if a stock-Linux machine ever reproduces it, restore the S1 verdict.

## Fix sketch

Not fixed yet (filed during a docs-closeout audit; the fix belongs in its own
PR with the emit gates above). The red test already exists —
`tests/basic.test.yo`'s `a tuple element type inside a generic container
declares its C name in time` — so the red-first requirement is satisfied by
that test; the reproducer above is the minimal form.
