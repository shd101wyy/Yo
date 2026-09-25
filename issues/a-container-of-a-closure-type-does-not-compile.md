# A container of a closure type (`ArrayList(typeof(k))`) does not compile

**Found:** 2026-09-25, writing the rule-D9 canary for `^` over a list of closures.
**Status:** OPEN. **Class:** valid code rejected (evaluator on the seed, codegen on the tree).

## Repro

`issues/repros/a-container-of-a-closure-type-does-not-compile.yo`: a closure
`(k : Impl(Fn() -> unit)) = (() => { println("ran"); })`, then
`ks := ArrayList(typeof(k)).new(); ks.push(k)`, then get and call.

- **v0.2.42 seed:**
  `error[E0610]: No matching call found with arguments: (base.add)(i)` in
  `std/collections/array_list.yo:915` (the GC tracer's `tracer.visit(base.add(i))`).
- **Tree (`ps/phase6-runtime` `f620b2ba9`+):** `yo check` passes, and clang rejects the emitted C
  with `incompatible pointer types passing '__yo_t_412997039185314103 *' to parameter of type
  '__yo_t_12592645716561581271 *'` at the tracer, the element store and `get`: two C types for
  `ArrayList(<k's Impl SomeT>)`.

## Mechanism

Not yet read. The shape matches P-26's family
(`issues/fixed/arc-of-a-capture-free-closure-emits-two-arc-typedefs.md`): a generic
instantiation over a closure's `Impl` SomeT is reached through two type-key paths. Here the
element type in `ArrayList`'s field types and methods is not the instantiation's type argument.

## Impact on the parallelism rules

None on soundness. `^` over such a list is rejected at `check` when a closure in it reaches a
thread-affine global (rule D9, `tests/parallelism_soundness.test.yo`). The D9 canary's sixth
route (`^` over a list of clean closures, run on a thread) waits on this fix.
