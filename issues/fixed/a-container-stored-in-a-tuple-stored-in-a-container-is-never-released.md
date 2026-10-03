# A container stored in a tuple stored in a container is never released — LeakSanitizer fails `tests/basic.test.yo`

**Severity:** S3 (downgraded from S1 — see "CI cross-check", resolved) — on Linux/WSL2 every `ArrayList(Tuple(i32, ArrayList(i32)))` that dies leaks its inner container (measured 48 bytes / 2 allocations per instance, scaling linearly) and `tests/basic.test.yo` is RED under the default sanitized test run; stock CI Linux does NOT reproduce it, so it is plausibly an LSan false positive local to WSL2's runtime/kernel. Still worth root-causing (every WSL2 developer sees a red basic suite), but it gates nothing.

**Found:** 2026-09-30, the `plans/reference/MATCH_PATTERN_MATCHING.md` closeout audit (a dynamic verification run of the match suite; the failing test contains no match code — the bug is orthogonal to the match work and predates it).

**Status:** FIXED 2026-10-03 — see "Fixed" below. (Before that: OPEN. Reproduced identically with the released seed `yo 0.2.46` (installed binary) and with a tree-built stage-1 (from `2a24df8c1`), so it was NOT a regression from the 2026-09-30 tree — it shipped in the current release's codegen.)

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

## Fixed

Root-caused 2026-10-03 and fixed on branch `s3/batch-2-fixes` — and the
"plausibly an LSan false positive local to WSL2" theory above is disproven:
the retention is physical on stock Windows tooling too (the exact nested shape
looped 200k times exhausts a `--allocator fixed --heap-size 4M` region while
the flat and direct-push controls recycle, ~70–105 B retained per iteration),
and the emitted C is platform-independent, so the missing release is not
platform-specific either. Why the stock-Linux CI legs of 2026-09-30 reported
green is not established here; with the release physically absent from the
emitted C, the S1-restore condition ("a stock machine reproduces it") is met
on the evidence above, and the fix below removes the leak outright. The real
defect was wider than the doc's sketch: a TUPLE LITERAL passed straight to a
call (never bound to a name) owned a +1 per RC-typed element that nothing ever
released — the callee's store dups each RC field itself (std assignment
semantics, `std/collections/array_list.yo`'s "dst.\* = src.\* dups"), so the
balancing release is the CALLER's drop of the tuple value, which a named
binding and a call-result temp both get but an anonymous tuple literal never
did: `evaluate_tuple_value`'s `attach_temp_variable_to_expr` was a no-op stub
(the "Phase 3 stub" comment), unlike the array-literal path
(`src/evaluator/values/array.yo`). The scope-end drop walk descending into
tuple elements — the doc's original sketch — was already implemented and
correct. The dup/drop pair optimizer's cancellation (`ys.push((i32(1), inner))`
cancelling `inner`'s element dup against its scope-end drop) was sound in
itself: it moves `inner`'s reference into the tuple, and the fix gives that
moved reference its release. Fix: `src/evaluator/values/tuple.yo` now attaches
an owning result temp to every runtime (not fully comptime-known) tuple
literal, exactly like `evaluate_array_value` — every transfer position
(binding, begin tail/return, `own` argument, arm value) consumes the temp so
the value still moves; only the anonymous-call-argument position keeps the
temp's scope-end field-drop, which is the missing release. Codegen side:
`src/codegen/exprs/tuple_fn.yo`'s temp branch now stores the temp to its
state-machine slot (`_store_temp_var_to_state_machine_if_needed`), the same
rule as every other temp-declaring site, so a tuple literal inside an
`io.async` loop body does not leak through an unassigned slot. Tests: five
Dispose-counter cases in `tests/rc.test.yo` ("a local moved into a tuple
argument of a call …", "a fresh constructor inside a tuple argument …", "one
local pushed in two tuple arguments …", "a tuple argument nested inside
another tuple argument …", plus the named-binding control) — four red before
the fix, all five green after, with exact-count assertions as the over-drop
canary; verified additionally by the emit-diff gate (the only C change on the
probe corpus is the tuple temp declaration plus its balancing field decrs — no
incr/decr lost anywhere), the fixed-heap loop oracles (sync 200k and an
`io.async` body looping across awaits, both rc=0 on 4 MB), the full
`tests/rc.test.yo` (68), `tests/basic.test.yo` (57), `tests/async_await.test.yo`
(262), `tests/collections/array_list.test.yo` (129), match_tuples, the three
drop-focused files, fn/type_soundness/unit_as_value_type/comptime/derive/dyn,
and `yo check ./src` 278/278 with the rebuilt binary.
