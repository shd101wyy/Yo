# No `volatile`, so an optimizer barrier needs inline asm — and wasm has none

**Kind:** design question — an open decision, not a defect. Moved from `issues/` root in the 2026-09-28 severity triage.

**Status:** OPEN — missing capability, not a defect
**Found:** 2026-09-08, implementing `black_box`.

## What is missing

Yo has no way to mark a load or store `volatile`. The only optimizer barrier
available is inline `asm` with a `"memory"` clobber, and the wasm targets have
no inline assembly at all.

## Measured, not assumed

`std/testing/bench.yo`'s `black_box` needs to stop the optimizer deleting a
benchmark body whose result is discarded. Three candidates, 20 000 calls to a
2 000-iteration loop, `--optimize 2`, this tree:

| implementation | time |
| --- | --- |
| none (`_r := work(i);`) | 1 000 ns — loop deleted outright |
| store the value's address into a module-level global | **0 ns — also deleted** |
| empty `asm` with the address in a register + `"memory"` clobber | 63 275 000 ns |

The global-store version fails because the store to a never-read global is
itself dead; without `volatile` there is no way to say otherwise. So the asm
barrier is the only mechanism that works.

## Consequence

`black_box` is comptime-gated to non-wasm targets and is a NO-OP on
`wasi`/`emscripten`, which is stated plainly in its doc comment: an
elision-sensitive microbenchmark on wasm measures nothing. Verified by
cross-emit that the `asm` really is eliminated there (`grep -c '__asm__'` on a
`--target wasm32-wasip1` emission is 0, and 1 natively), so the wasm CI legs
are unaffected.

## What would fix it

A `volatile` qualifier, or a `read_volatile`/`write_volatile` pair of
builtins — Rust's pre-`asm!` `black_box` was written over exactly those. A
single `__yo_black_box` builtin lowering to the right thing per target would
also do, and would remove the need for `Pragma.AllowUnsafe` in a benchmark.

---

## Recommendation (agent triage, 2026-09-28 — awaiting maintainer verdict)

Add the `__yo_black_box` builtin with per-target lowering — the `asm` +
`"memory"` clobber natively, and on wasm an opaque non-inlined call the
optimizer cannot see through — and route `std/testing/bench.yo`'s `black_box`
through it. That also removes `Pragma.AllowUnsafe` from ordinary benchmark
code, the win the doc names. Defer a general `volatile` qualifier and a
`read_volatile`/`write_volatile` pair: they grow the language surface and this
is the only consumer on record; revisit when a second use case appears. Note
the seed gate applies — a new `__yo_*` builtin needs one release before `std`
can call it.
