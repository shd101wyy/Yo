# yo-self: recursive value-enum `Box(Self)` member — `box(...)` returns unsubstituted `Box(V)` (OPEN)

The last failing corpus fixture: `tests/codegen-bootstrap/recursive_enum_nested_match.yo`.
The self-compiled binary emits 2 "Failed to transpile" markers and prints only
`leaf` (TS prints `leaf / node-of-leaf / node-of-node`). NOT a regression — fails
identically on every binary this session.

## Precise root cause (instrumented)

Constructing `Tree.Node(child : box(Tree.Leaf))` where
`Tree :: enum(Leaf, Node(child : Box(Self)))` throws (swallowed at def-time, hence
the markers). The swallowed error:

```
Type mismatch for type member "child":
Expected: Box(<enum:enum_yo_id_5798__self_shell>)
Got:      Box(V)
```

Instrumenting the member-type check in `evaluator/calls/type.yo` (the `[MEMCHK]`
probe) shows two member checks while building `Tree.Node(child: box(Tree.Leaf))`:

| member                                           | expected (field type)         | arg type | compat    |
| ------------------------------------------------ | ----------------------------- | -------- | --------- |
| `*` (box's `(*):V` field, inner `Box(V)(value)`) | `<enum:...__self_shell>`      | `Tree`   | **true**  |
| `child` (the `Tree.Node` field)                  | `Box(<enum:...__self_shell>)` | `Box(V)` | **false** |

Two compounding problems:

1. **`box(Tree.Leaf)` returns the UNSUBSTITUTED `Box(V)`** (V = box's forall param).
   `box :: (fn(forall(V), own(value):V) -> Box(V))`. Normally `box(5)` → `Box(i32)`,
   but here the call's return type stays `Box(V)`. The trigger is the conflicting
   `V` inference: the arg `Tree.Leaf` gives `V = Tree`, while the expected type
   `Box(<self_shell>)` gives `V = self_shell`; the conflict leaves `V` unbound, so
   the return type isn't substituted.
2. The **field type `Box(Self)` keeps the unresolved self-shell** (`Box(<...__self_shell>)`).

## Why it's hard (architectural divergence)

TS represents a recursive type reference as a `SomeType` tagged
`recursiveTypeRef` (`src/types/definitions.ts:221`, `creators.ts:918`) that
resolves LAZILY — so `Box(Self)`'s `Self` and `box(x)`'s `V` both reconcile to the
final `Tree`. yo-self diverged: it uses an **empty-variant `__self_shell` EnumT
with a DISTINCT id** (`types/creators.yo` comment). `resolve_enum_shell` only
resolves a TOP-LEVEL EnumT shell, so the shell NESTED inside `Box`'s
type-argument/field never resolves.

## Attempted fix (reverted)

Added `resolve_enum_shells_deep` (recurse Struct type-args + field-types, Pointer
pointees; resolve nested shells) and applied it to `member_element.ty` in
`type.yo`. It resolved the TOP-LEVEL shell (the `*` member's expected became
`<enum:5798>`) but **did NOT resolve the shell nested inside `Box`** for the
`child` member — `member_ty_resolved` stayed `Box(<...__self_shell>)`. The member
type reaches `type.yo` as a tag the resolver's `.Struct`/`.Pointer`/`.EnumT` cases
did not match (tag not yet pinned — the probe to dump it had a match-arity error
and was not re-run). Reverted to avoid shipping a non-working half-fix.

## Next step when picked up

1. Pin the actual TypeValue tag of the `child` field type `Box(Self)` as seen in
   `type.yo` (it renders as `Box(<enum:..._self_shell>)` but is NOT resolved by a
   `.Struct`/`.Pointer` walk — likely an unevaluated `TypeAppT`/thunk, or a
   ref-struct whose `(*)` field carries `V` while `type_arguments` carries the
   shell and `type_to_string` renders from a third source).
2. Either (a) deep-resolve that representation so the field type is `Box(<final>)`
   AND verify that a clean (conflict-free) expected type lets `box`'s forall `V`
   substitute, or (b) back-patch recursive-enum variant field types to the final
   enum at finalization (the faithful analogue of TS's lazy `recursiveTypeRef`),
   reusing/extending `_patch_self_shell` (creators.yo).
3. Confirm the `box(...) -> Box(V)` forall-substitution path resolves once the
   arg/expected `V` conflict is gone.

Off the immediate P1 critical path (this exact shape — a VALUE recursive enum
matched two levels deep via `Box(Self)` — is rare; yo-self's own recursive ASTs
are `ref(enum)`), but a genuine correctness gap worth closing for full corpus.
