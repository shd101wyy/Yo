# A retyped `Rc` surfaces three cell-handle view gaps: the `dyn` auto-box, the `dyn` clone, and borrow marks on the weak count

**Severity:** S3 — no user program reaches the first and third gaps (a safe file cannot retype `Rc`), and the second needs a `pragma(Pragma.AllowUnsafe)` cell wrapper. Together they kept the v0.2.73 seed from lowering V5's `Rc`/`Arc` over `__yo_cell`, which moves V5 cells Generation B (the std retype) from v0.2.74 to v0.2.75.

**Status:** fixed in the compiler by V5 cells Generation A (`vbd/v5-gen-a-completion`). `tests/cell_handles.test.yo` covers gap 2 now. Gaps 1 and 3 are reachable only through the prelude's `Rc`/`Arc`, so their regression rows go live with cells Generation B (v0.2.75), which moves this doc to `issues/fixed/`.

## How it was found

`std/prelude.yo` was retyped to V5's shape (`plans/VALUES_BY_DEFAULT.md` §3.5, "Left to V5"; branch
`vbd/v5-cells-gen-b`):

```yo ignore
Rc :: (fn(comptime(V) : Type) -> comptime(Type))(newtype(_cell : __yo_cell(V)));
Arc :: (fn(comptime(V) : Type, where(V <: (Send, Sync))) -> comptime(Type))(newtype(_cell : __yo_atomic_cell(V)));
// Rc.new (and Arc.new, __yo_rc_cell, __yo_arc_cell):
cell := Rc(T)(__yo_cell(T)(value, alloc));
```

The probe programs and test files were then compiled against it with `--std-path`. `Rc.new`, `Rc.clone`,
`ref_count`, auto-dereference, `.*`, `downgrade`/`upgrade`, `try_unwrap`, `make_mut` and `Arc.new`/`Arc.clone`
all lower correctly. The v0.2.71 seed-predicates work (`feat/v5-seed-predicates`) taught every handle predicate
"old shape or view", and tested each one with test-local handles (`tests/fixtures/cell_handles.yo`). It missed
the three sites below: two can only be reached through the prelude's `Rc`/`Arc` (or a `Weak` of one), and the
third was never exercised.

## Gap 1: the `dyn` auto-box drops a view as the box type

Every `dyn(...)` of a value failed in the C compiler:

```
tmp/dyn2.out.c:2397:110: error: expected expression
 2397 |   __yo_t_9194311686767144431 __yo_v_f = /* Error: dyn() requires an object type (use rc() for value types) */;
```

A recognized `dyn(Rc.new(<closure>))` was rejected one step earlier:

```
error[E0613]: Cannot infer the type parameter `T` of `Rc` in `Rc.new(...)`: no argument binds it.
```

Reproducer (against the retyped std):

```yo
{ assert } :: import("std/assert");
main :: (fn() -> unit)({
  (f : Dyn(Fn(x : i32) -> i32)) = dyn((x : i32) => (x + i32(1)));
  assert(f(i32(1)) == i32(2), "dyn");
});
export(main);
```

Root cause: `_create_box_type_via` (`src/evaluator/values/dyn.yo`) evaluates the prelude's cell type constructor
over the payload type. It kept the result only if `is_reference_struct_type`, which is the old
`ref(struct((*) : V))` shape. Two failures followed:

- The auto-box built no box, so codegen's object-type guard refused the unboxed payload.
- The recognized `Rc.new` got no receiver type to preset, so static-argument inference had nothing to bind `T`
  with.

Fix: accept `cell_handle_view(bt).is_some()` too.

## Gap 2: a `Dyn(..., Clone)` over a view clones through the cell constructor without its scope

```
tests/.yo_selftest_batch_967865_1_0.bin.c:1371:119: error: too few arguments to function call, expected 2, have 1
  __yo_t_…* out = __yo_new___yo_t_…(clone_fn(box->_u42_));
```

`_emit_dyn_clone_function` (`src/codegen/functions/dyn.yo`) builds the fresh box with the box type's
constructor. A cell primitive's constructor takes the allocation scope first (`__yo_cell(V)(v, alloc)`,
`src/codegen/functions/constructors.yo`). Fix: pass the owner scope the function already computes
(`__yo_owner_scope`, the source's allocator, decision 12). Repro: the `S20: a Clone Dyn over a cell handle
clones into a fresh cell` row of `tests/cell_handles.test.yo`. It fails to compile before the fix, both with
the v0.2.73 seed and with a tree built without this fix.

## Gap 3: borrow marks land on a cell header whose bits are the weak count

Weak handles over the retyped `Rc` panicked when the last strong handle went:

```
panic: container operation while an interior reference (a 'ref' into an element/field) borrows from it
```

A cell header's `borrow_count` bits are its weak count (`_weak_count_primitives`,
`src/codegen/functions/gc_runtime.yo`). Codegen leaves out every borrow primitive for the `Rc`/`Arc` handle
(`is_counted_cell_type`). Under the view, though, the cell's own `___dispose` takes the cell primitive
(`__yo_cell(V)`) as `self`, which is a counted handle but not `is_counted_cell_type`. So it opened with
`__yo_borrow_assert_unborrowed(self)` and read the live `Weak` count as a borrow. The `ArcWeak` rows of
`tests/arc.test.yo` failed the same way.

Fix: `carries_no_borrow_marks` (`src/types/guards.yo`) is `is_counted_cell_type(t) || is_cell_primitive_type(t)`.
The five codegen sites that decide on a borrow mark now ask it: the method-entry asserts, the interior-reference
container, the inline borrow primitives, and the object-method test. A cell never reallocates, so an interior
reference into its payload needs no mark on it. The evaluator's read-only rule (E0919,
`handle_payload_is_read_only`) still asks `is_counted_cell_type` alone, because a bare cell's payload is a
mutable place (§3.5).

## Verification

- Generation A: `src/main.yo`'s C is compared byte for byte against develop's (the PR body has the result). A
  tree-built binary runs the dyn, handle, `Rc`/`Arc`/`Weak` and async test files over the retyped std; the
  results are in the PR body.
- Generation B: the `dyn(...)` rows of `tests/handle_constructors.test.yo` and `tests/dyn.test.yo` cover gap 1,
  and the `Weak`/`ArcWeak` rows of `tests/rc.test.yo` and `tests/arc.test.yo` cover gap 3, all against the
  shipped std.
