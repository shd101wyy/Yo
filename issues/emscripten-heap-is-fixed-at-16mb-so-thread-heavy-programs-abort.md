# The emscripten heap is fixed at 16 MB and cannot grow, so a thread-heavy program aborts with `Aborted(OOM)`

**Found**: 2026-09-13, by `tests/spawn_blocking.test.yo`'s wake-inbox regression
test on PR #667 (`test-wasm32_emscripten`, run `34764386998`). **Status**: OPEN
— documented, not fixed; the test was scaled down on this target instead, and
that is a mitigation rather than a fix.

## Symptom

A test that creates 400 short-lived threads (200 rounds of two concurrent
`spawn_blocking` calls) aborts under `wasm32-unknown-emscripten`:

```
✗ repeated pairs of spawn_blocking do not corrupt the wake inbox
  Test failed with exit code 256
Aborted(OOM)
```

**It is marginal, not deterministic**, which is the part that matters: the same
command on the same test passed locally on the same target while CI aborted.
A test at that size would be a coin flip on this leg forever.

## Why

The emitted emscripten module fixes the heap and forbids growth:

```js
var INITIAL_MEMORY = 16777216;
wasmMemory = new WebAssembly.Memory({
  initial: INITIAL_MEMORY / 65536,
  maximum: INITIAL_MEMORY / 65536,   // == initial: the heap CANNOT grow
  shared: true,
});
...
var abortOnCannotGrowMemory = requestedSize => { abort("OOM"); };
```

Every pthread reserves its stack out of that 16 MB, and emscripten's pthread
pool starts at four workers and allocates more on demand. A program that spawns
a few hundred short-lived threads therefore runs out of heap, and the failure
arrives as a bare `Aborted(OOM)` with no indication that the heap is the limit
or that it was never allowed to grow.

Standalone WASI is NOT affected: it has no threads at all, so `spawn_blocking`
runs the closure inline and costs no stacks
(`issues/spawn-blocking-degrades-to-inline-on-a-threadless-target.md`).

## What was done instead

`tests/spawn_blocking.test.yo` scales its round count on
`Platform.Emscripten` (24 rounds rather than 200). The native count is
unchanged, and the native count is the one that gates the bug the test exists
for — it was measured against the broken compiler at 12 → 1/6, 40 → 3/8,
200 → 7/10.

That keeps the suite honest about the platform's limit rather than pretending
400 threads work there. It does not make them work.

## The real fix, if wanted

Let the heap grow: `maximum` well above `initial` plus `-sALLOW_MEMORY_GROWTH`,
or size `INITIAL_MEMORY` from a flag. Both are changes to the wasm build
configuration in the codegen, with their own performance trade-off (a growable
heap costs a bounds reload on every access in some emscripten configurations),
so this is a deliberate decision rather than an obvious win — which is why it is
filed rather than slipped into an unrelated PR.

A cheaper intermediate: make the abort say what happened. `abortOnCannotGrowMemory`
currently aborts with the bare string `"OOM"`; it knows `requestedSize` and the
current heap size, and could say that the heap is fixed at N bytes and cannot
grow.
