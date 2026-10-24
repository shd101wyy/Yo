# A generic struct naming its own constructor in a field crashes the evaluator

**Severity:** S2 — `Link :: (fn(comptime(T) : Type) -> comptime(Type))(struct(value : T, next : Option(*Link(T))))` kills `yo check` and `yo compile` with SIGSEGV (rc 139) and no diagnostic; the workaround is `?*Self` (which has its own defect, see below) or `?*void`.

**Status:** open. Found 2026-10-24 while implementing P6
(`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` D23). Reproduces identically
with the v0.2.68 seed and a develop build of `f1cfa553d`.

## Reproducer

`issues/repros/2026-10-24-a-generic-struct-naming-its-own-constructor-in-a-field-crashes-the-evaluator.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
Link :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(
    value : T,
    next : Option(*Link(T))
  )
);
main :: (fn() -> unit)({
  (x : Option(*Link(i32))) = .None;
  println(&x.is_some());
});
export(main);
```

`yo check` and `yo compile` both exit 139 with no output past the module
banner. With `next : Option(*Self)` the same program prints `false`.

## Likely cause (hypothesis, not confirmed)

Evaluating `Link(i32)` evaluates its field types, which call `Link(i32)`
again before the first call has produced (or memoized) a result; the CTFE
call has no in-progress placeholder for a type constructor applied to its own
arguments, so the recursion is unbounded and the evaluator's stack overflows.
The `src/evaluator/calls/comptime_fn.yo` header describes an in-progress
temp cache for recursive calls ("a recursive call hits the in-progress temp
cache and must return a placeholder"); this path apparently misses it.

Whether a generic struct may name its own constructor at all is a language
question; Rust accepts the equivalent (`next: Option<*mut Link<T>>`). Either
way the evaluator must not crash: the minimum fix is a diagnostic pointing at
`Self`, the full fix resolves the recursive application through a raw pointer
to the instantiation's own shell, exactly as `Self` does.

Related: the `?*Self` spelling of the same node is accepted here but then
hides every generic impl on a generic holder of the node
(`issues/2026-10-24-a-generic-struct-naming-itself-through-a-raw-pointer-hides-the-impls-of-a-generic-holder.md`),
which is why `std/collections/linked_list.yo` types its links `?*void`.
