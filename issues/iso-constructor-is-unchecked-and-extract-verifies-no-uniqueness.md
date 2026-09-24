# `Iso(T)(v)` is an unchecked constructor and `extract()` verifies nothing, so `Iso` enforces no uniqueness at all

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-2).
**Status:** OPEN. **Memory-unsafe in safe code** (SIGSEGV, both with and without threads).
Companion of `issues/iso-checks-only-the-wrapper-refcount-not-the-interior.md` (the type-system
audit's finding, which measured the interior-aliasing race through the same constructor); this
record is about the two mechanisms underneath it, which are worse than that doc assumes.
**Measured:** yo 0.2.41 seed against the develop tree's `std`, macOS arm64.

## The documented model vs what is emitted

`docs/en-US/THREAD_SAFETY.md` §Iso, the SAFETY comment above `impl(generic(T), Iso(T), Send())`
in `std/prelude.yo` (~9455) and `plans/archive/THREAD_SAFETY.md` all rest on one sentence:
*"extract() atomically verifies rc == 1 before returning"*. The emitted extract
(`src/codegen/types/generation.yo` ~1660, pass 6) is:

```c
bool was_extracted = atomic_exchange(&iso->extracted, true);
if (was_extracted) { fprintf(stderr, "panic: Iso::extract() called on already-extracted Iso\n"); abort(); }
return iso->value;
```

There is no reference-count check of any kind, on the wrapper or on the inner value. The only
runtime uniqueness check in the whole design is `Isolation.can_isolate` (`rc(self) == 1`),
which is called by the `^` macro at CONSTRUCTION, and only `Box(T)` implements `Isolation`
(`grep -rn "Isolation(" std` → one impl). So:

1. `^v` works only for `Box(T)` and user types with a manual impl; `^xs` on an `ArrayList`
   fails to compile (`Type "…" does not implement trait "Isolation"`).
2. The raw constructor `Iso(T)(v)` is public and is what `docs/en-US/ISOLATED.md` teaches.
   Its evaluator (`src/evaluator/calls/iso.yo`, `evaluate_iso_value_call` ~280-380) checks
   three things ONLY when the argument is a named variable: the type cannot form RC cycles, the
   variable owns its RC value, and no other variable aliases it; then it marks the variable
   consumed. It never checks that `T` contains a reference type (the macro's first check), it
   never looks inside the value, and when the argument is not a variable
   (`Iso(Wrap)(Wrap(items : shared))`,
   `issues/repros/iso-literal-argument-skips-every-constructor-check.yo`, green) it checks
   nothing at all. There is no runtime check on either path.

## Repro 1 — aliased interior, consistent SIGSEGV

`issues/repros/iso-raw-constructor-aliased-interior-segfault.yo`:

```rust
Wrap :: ref(struct(items : ArrayList(i32)));
main :: (fn() -> unit)({
  shared := ArrayList(i32).new();
  w := Wrap(items : shared);
  iso := Iso(Wrap)(w);
  t := Thread(unit).spawn((io : Io) => {
    inner := iso.extract();
    inner.items.push(i32(1));
    eprintln(`child inner=${inner.items.len()}`);
    ()
  });
  shared.push(i32(2));
  t.join();
  eprintln(`after join shared=${shared.len()} w=${w.items.len()}`);
});
```

```
before spawn shared=0
parent after push shared=1
child inner=2
rc=139          (SIGSEGV, 5/5 runs, with and without MallocScribble=1)
```

The child's `inner` and the parent's `shared`/`w` are the same non-atomic objects on two
threads; the crash lands on the release path after the child's body returns. The peer's variant
(2 000 000 pushes from both sides) shows the contract failure instead; same root.

## Repro 2 — `Iso` of a scalar, SIGSEGV with no threads

`issues/repros/iso-of-a-scalar-segfaults-at-dispose.yo`:

```rust
main :: (fn() -> unit)({
  iso := Iso(i32)(i32(5));
  println(`made`);
});
```

rc=139. The dispose emitted for every Iso (pass 5) is `__yo_decr_rc((void*)iso->value)` when not
extracted; for a scalar that dereferences the integer. The `^` macro would have rejected this at
compile time ("Cannot isolate value type that does not contain Rc type"); the constructor does not.

## Why the design's argument does not hold even for the macro path

The macro's compile-time checks are about the VARIABLE (`Var.is_owning_the_rc_value`,
`Var.has_other_aliases`) and `can_isolate` is about the wrapper's own refcount. Neither looks
inside: `Box(Wrap)` where `Wrap.items` is aliased passes both. The archived plan's Phase H text
already lists this as risk 1 ("Hidden API-surface precondition") but treats it as a discipline
problem for `Iso`'s methods; it is a structural gap in the construction rule.

## Fix direction (decision recorded in `plans/PARALLELISM_SOUNDNESS.md`, Phase 2)

1. Make `Iso(T)(v)` non-constructible from safe code: the only entry is `^v` (or an `iso(v)`
   function), and `T` must contain a reference type (the macro's first check becomes the
   evaluator's, so repro 2 is a compile error).
2. Deep uniqueness at construction, at runtime: emit `__yo_iso_unique_<T>(value)` — a walk over
   the same field list the traversal/tracer functions use — that returns false if ANY reachable
   non-atomic object has `ref_count != 1` (atomic objects inside are shared by design and stop
   the walk). `^v` returns `.None` on failure, as today. Cost: O(reachable graph) once per
   hand-off, on the sending thread, where every reachable non-atomic refcount is stable (only
   this thread can hold them, by the Send rules).
3. `extract()` keeps the one-shot flag and ADDS the wrapper check the docs promise
   (`ref_count == 1`, atomic load), so a copied-and-not-yet-dropped `Iso` on the sending thread
   panics rather than handing out a second owner.
4. Rewrite `docs/{en-US,zh-CN}/ISOLATED.md` (still the TypeScript-era model: `Option(T)` results,
   `isOwningTheSameRcValueAs`, `printf`) and the `Iso` section of `THREAD_SAFETY.md` to the rule
   that lands; delete the "rc == 1 at extract" claim until (3) exists.

Tests: `tests/iso.test.yo` gains the interior-alias `.None` case, the scalar rejection, the raw
constructor rejection (`comptime_expect_error`), and a cross-thread hand-off of an
`ArrayList(String)` built on the child (`issues/repros/…` shape) that must stay green — that
shape works today and is the feature's whole point.
