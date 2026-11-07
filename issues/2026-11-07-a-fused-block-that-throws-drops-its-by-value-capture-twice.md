# A fused block that throws drops its by-value capture twice

**Severity:** S1 — a double free in emitted code whenever the immediately awaited wrapper of a by-value parameter throws out of its fused block: the wrapper's argument is freed twice on the unwind path.

Found 2026-11-07 by the extra test written for `issues/fixed/2026-11-07-a-fused-await-reads-the-callers-match-binding-of-the-wrappers-name.md`. That PR's fix removed the wrong-variable read this test was written around, and the run then failed for THIS reason instead (before the fix it failed with the wrong thrown message; after it, with the double free), so the defect is reachable on its own, not only through a name collision.

## Reproducer

`issues/repros/2026-11-07-a-fused-block-that-throws-drops-its-by-value-capture-twice/fused-throw.test.yo` — appended to `tests/async/fusion.test.yo` it fails under the tree-built stage 1 of that PR's branch:

```text
✗ a throw in a fused block carries the wrapper's value and releases the arm's
  Test failed with exit code 256
  ERROR: AddressSanitizer: attempting double-free ... 3-byte region
```

The shape: `_throws_with_arm_binding(sink(name) : String, io)` is a fusable wrapper whose block awaits once and then throws `dyn(Boom(msg : name.clone()))`; the caller awaits it inside a `match` arm whose own binding is also live across the await. The double-freed region is the wrapper's argument (`"arg"`), so the site's capture is released twice on the throw's unwind: once by the escape path and once by the state machine's dispose (or the block's own drops), with the fix's filtered pending lists in between.

## Status

OPEN. Not fixed by the fused-await arm-scope PR (its five tests — the arm-binding shadow shapes, including the `sink` one that hangs `yo build test` — pass; this throw-path shape is a different release). The reproducer stays out of the suite until the fix lands, so the suite stays green. Candidates to look at first: the escape path of `emit_fused_await`'s block (`generate_deferred_drop_expressions` on the block body plus `_emit_fused_site_end_releases`), and the `escaped_result` handling of the unwound await inside a fused site.
