# An E0601 between two recursive enums' lists prints both sides as `ArrayList(Self)`

**Severity:** S3 — the diagnostic for assigning one recursive enum's list to another's names the same type twice (`Expected: ArrayList(Self)` / `Given: ArrayList(Self)`), so it does not say which declarations disagree.

**Status:** open. Found 2026-10-20 while fixing
`issues/fixed/2026-10-17-two-recursive-enums-of-one-shape-share-their-arraylist-self-instantiation.md`,
whose fix made this rejection reachable (before it, the assignment was accepted).

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
A :: enum(Leaf(v : i32), Node(kids : ArrayList(Self)));
B :: enum(Leaf(v : i32), Node(kids : ArrayList(Self)));
main :: (fn() -> unit)({
  xs := ArrayList(B).new();
  (ys : ArrayList(A)) = xs;
});
export(main);
```

`yo check` (tree at `fix/recursive-enum-decl-identity`):

```
error[E0601]: Incompatible types:
- Expected: ArrayList(Self)
- Given   : ArrayList(Self)
```

## Root cause (suspected)

`ArrayList(A)` is served the instance minted while `A`'s own body was being
evaluated, whose type argument is the declaration's NAMELESS rendition (the
self-shell patched to the pre-final, name `""`); `type_to_string` renders a
nameless enum reached through `Self` as `Self`. The same holds for `B`.

## Fix direction

Render a nameless enum rendition by the name its declaration was later bound
to (the `Name :: enum(...)` binding stamps the name on the final only), e.g.
through the declaration identity table (`enum_decl_identity`,
`src/types/guards.yo`) mapped to the bound name.
