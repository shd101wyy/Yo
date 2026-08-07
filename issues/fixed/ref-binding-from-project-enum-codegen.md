# Codegen bug: `ref(name) := arr.project(i)` mis-codegens (and clones) for ENUM elements

## ✅ FIXED (TS evaluator)

Root cause was in the **evaluator**, not the C emitter:
`src/evaluator/exprs/initialization-assignment.ts` called
`setExprAsNeedsToCallDup(rhs, ...)` **unconditionally** for every `name := rhs`,
including the `ref(name) := rhs` borrow case. That attached a deferred dup to the
RHS, so codegen emitted `T value = __dup(*ptr); T* name = value;` — deref + clone
the pointee into a value, then assign it to the pointer-typed (`isRef`) binding:
invalid C for enum/struct elements, and a spurious clone even when it compiled.
Scalars escaped only because they are never dup-requiring.

**Fix:** gate the dup on `!isRefBinding` — a `ref(name) :=` binding aliases the
ref-yielding RHS (a `T*`) rather than owning it, so no clone must be inserted:

```ts
if (!isRefBinding) {
  setExprAsNeedsToCallDup(rhs, { ...context });
}
```

**Verified:** the minimal enum repro EXIT 1 (C compile error) → compiles + runs
EXIT 0; the binding now emits `T* child = <project_ptr>;` directly (no
deref/`__dup`). Added regression test "Phase B — ref(name) := project borrows
ArrayList enum element (no clone)" to `tests/ref_binding.test.yo` (reads through
the ref AND mutates in place, proving borrow-not-clone). Targeted ref/iterator/
indexable/for set: 14/16 pass (the 2 failures — `iterator_combinators`, `index`
— are pre-existing, confirmed identical on baseline HEAD). Full suite: 519 pass;
all 62 failures are the known-broken `yo-self/tests/` unit tests + the
pre-existing `iterator_combinators` timeouts — no new `tests/` regressions.

**yo-self port: N/A.** This is an evaluator fix (`initialization-assignment.ts`);
yo-self's `initialization_assignment.yo` does not yet port the ref-binding dup
path, so there is no counterpart to change (1-to-1 preserved by absence).

This also **unblocks the faithful non-cloning AST traversal** the ref/slice
flowability cluster needs (`fn(ref(e) : AstExpr)` recursing via `project`), since
`AstExpr` is an enum — see plans/archive/EVALUATOR_PORT_REVIEW.md.

## Summary

A `ref`-binding whose RHS is a `ref(T)`-returning call — e.g.
`ref(child) := kids.project(i)` where `kids : ArrayList(Tree)` and `Tree` is an
**enum** — generates **invalid C**: it derefs+`__dup`s the pointee into a value
and then assigns that value to a pointer-typed binding.

Generated C (element type `__yo_enum_id_3` = `Tree`):

```c
__yo_enum_id_3* _t40588 = project(...);                 // project() returns a pointer (ref(T)) — correct
__yo_enum_id_3  _t40589 = __dup((*_t40588));            // BUG: deref + dup → a VALUE (a clone!)
_t40589;
__yo_enum_id_3* child   = _t40589;                       // BUG: VALUE assigned to POINTER → C error
```

clang error:

```
error: initializing '__yo_enum_id_3 *' with an expression of incompatible type
'__yo_enum_id_3'; take the address with &
```

Two problems in one:

1. **Type mismatch** — `child` is declared as a pointer (`ref`-binding ⇒ pointer)
   but is assigned the deref'd VALUE.
2. **Spurious `__dup`** — a `ref`-binding must bind the pointer directly; it
   should NOT deref+dup the pointee. The `__dup` is a clone, which also defeats
   the whole point of `project` (borrow without copy).

## Scope

- Reproduces with the regular TS compiler (`./yo-cli compile`), so it's a bug in
  `src/codegen` (the init-assignment ref-binding emitter), not yo-self-specific.
- **Element type matters:** `ref(r) := arr.project(i)` WORKS for scalar elements
  (`tests/indexable_runtime.test.yo` passes with `i32`/`u8`), but FAILS for an
  enum element. The codegen path for ref-binding-from-ref-returning-call is wrong
  when the bound type is an enum (and likely other non-trivial value types).

## Minimal repro

```rust
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
Tree :: enum(Leaf(v : i32), Node(kids : ArrayList(Self)));
f :: (fn(ref(t) : Tree) -> bool)(
  match(t,
    .Leaf(v) => (v == i32(0)),
    .Node(kids) => {
      ref(child) := kids.project(usize(0));   // <-- mis-codegens for enum element
      match(child,.Leaf(cv) => (cv == i32(0)),.Node(_) => false)
    }
  )
);
```

## Why it matters here

This blocks building a **non-cloning AST traversal** (the foundational primitive
the ref/slice-flowability gates need — see plans/archive/EVALUATOR_PORT_REVIEW.md), since
`AstExpr` is an enum and a borrowing traversal would do
`ref(child) := args.project(i)` on `ArrayList(AstExpr)`. Both failure modes hurt:
it doesn't compile, and even the intended codegen would `__dup` (clone) per node.

## Fix

In `src/codegen` (and the yo-self port `yo-self/codegen`), the init-assignment
emitter for `ref(name) := <ref(T)-returning expr>` must **bind the returned
pointer directly** (no deref, no `__dup`) regardless of whether `T` is a scalar,
struct, or enum. The scalar path apparently already does this; generalise it to
enum/aggregate element types.
