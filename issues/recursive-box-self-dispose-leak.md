# Recursive `Box(Self)` in enum: dispose function generated against partial `Self`, causing leaks

## Symptom

A simple recursive enum that uses `Box(Self)` for child nodes leaks every
inner Box allocation when dropped. Only the outermost Box is freed.

```rust
MyExpr :: enum(
  Lit(value : i32),
  Add(lhs : Box(Self), rhs : Box(Self)),
  Mul(lhs : Box(Self), rhs : Box(Self)),
  List(items : ArrayList(Self))
);

test "nested Box(Self) tree", {
  // (1+2) * (3+4)
  e := MyExpr.Mul(
    box(MyExpr.Add(box(MyExpr.Lit(i32(1))), box(MyExpr.Lit(i32(2))))),
    box(MyExpr.Add(box(MyExpr.Lit(i32(3))), box(MyExpr.Lit(i32(4)))))
  );
  // ...
};
// → AddressSanitizer: 160 byte(s) leaked in 4 allocation(s).
```

The 4 leaked allocations correspond to the 4 leaf Boxes (the inner Lit
boxes inside each Add). The 2 outer Add Boxes drop fine.

The deeply-nested 50-spine case leaks 98 allocations as expected (linear
in spine length).

## Root cause

When the codegen emits the destructor for `Box(MyExpr)`, the `Self`
substitution inside `Box(Self)` resolves to a **partial** enum
type — just the first variant `enum(Lit(value: i32))`, not the full
`MyExpr`. This is visible in the generated C:

```c
// Forward declaration shows the wrong inner type:
fn_yo1c2129e9_id_46092___drop(__yo_enum_yo77d18fd3_id_2* __yo_self);
//   (Box(enum(Lit(value: i32))))
//   fn(__yo_self : Box(enum(Lit(value: i32)))) -> unit
```

Because that partial enum has no RC-typed fields, the Box's dispose
function is emitted as a no-op:

```c
static inline void fn_yo1c2129e9_id_46053___dispose(...) {
  // EMPTY — should drop the inner MyExpr value
}
```

When the outer `MyExpr.Add` drop runs, it calls `__yo_decr_rc` on each
Box pointer. The Box RC reaches 0, but its empty dispose never drops the
inner `MyExpr`, so the inner Boxes inside `MyExpr.Add(lhs, rhs)` are
never decremented and leak.

This is the same family of bug as
`issues/recursive-derive-clone-codegen-vtable.md`: when generic impls
(here `___dispose` / `___drop` for `Box(T)`) are specialized for `T =
RecursiveEnum`, the generic impl body sees a stale/partial view of the
recursive type because the type isn't fully registered yet.

## Where to look

- `src/evaluator/values/impl.ts` — generic impl specialization;
  similar pre-registration mechanism (`currentlyRegisteringConcreteImpls`)
  was added for derive(Clone) but apparently doesn't reach the
  built-in dispose/drop generation path.
- `src/codegen/exprs/generation.ts` and the destructor synthesis path
  for `object` types — investigate where Self in field types is
  substituted when emitting Box's `___dispose`.
- The auto-generated `___drop` for the enum (`fn_yo77d18fd3_id_17___drop`)
  correctly references the full MyExpr type, so the asymmetry is between
  enum-level drop synthesis and Box's per-instance dispose synthesis.

## Tests

- `tests/recursive_enum.test.yo` — first and third tests pass
  (single-level Box and ArrayList(Self) which has its own iterating
  drop). Second and fourth tests are commented out pending this fix.

## Workarounds

None pleasant. `ArrayList(Self)` works because ArrayList's drop iterates
elements and the per-element drop is generated against the resolved
enum type, not via Box.

## Priority

**Blocker for the bootstrap port** — every AST-shaped data structure
in the evaluator/codegen will be a recursive enum with `Box(Self)`
fields. Must be fixed before serious self-hosting work can begin.
