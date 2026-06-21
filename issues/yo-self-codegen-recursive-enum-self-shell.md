# yo-self codegen: recursive-enum self-shell leaks into C type emission → "use of empty enum"

## Status: OPEN — discovered 2026-06-21 alongside the match-side self-shell fix

## Symptom

A recursive enum with a `Box(Self)` (or other self-referential) field, when
actually CODEGEN'd (C-compiled, not just `--emit-c`), emits a SEPARATE empty C
enum for the self-shell and references it from the `Box` field, failing C
compilation:

```c
typedef enum { } __yo_enum_yo_id_5729__self_shell_tag;   // EMPTY
typedef union { } __yo_enum_yo_id_5729__self_shell_data;
...
// a Box field of the enum references the empty shell -> clang:
//   error: use of empty enum
```

## Repro (TS passes; both pre/post match-fix yo-self binaries fail identically)

`scratchpad/recursive_enum_nested_match.yo`:

```rust
open(import("std/string"));
{ println } :: import("std/fmt");
Tree :: enum(Leaf, Node(child : Box(Self)));
classify :: (fn(t : Tree) -> String)(
  match(t, .Leaf => String.from("leaf"),
           .Node({ child }) => match(child.*, .Leaf => String.from("node-of-leaf"), .Node => String.from("node-of-node"))));
main :: (fn() -> unit)({
  println(classify(Tree.Leaf));
  println(classify(Tree.Node(child : box(Tree.Leaf))));
  println(classify(Tree.Node(child : box(Tree.Node(child : box(Tree.Leaf))))));
});
export(main);
```

TS: `leaf` / `node-of-leaf` / `node-of-node`. yo-self: `clang: use of empty enum`.

## Root cause

`evaluate_enum_type` (types/enum.yo) patches the recursive SELF-SHELL out of the
variant fields only ONE level deep (intentionally — a fully-recursive patch would
loop; deeper nesting is meant to resolve via the `register_enum_final` /
`resolve_enum_shell` registry at use sites). The EVALUATOR match path was fixed
to call `resolve_enum_shell` (see `issues/fixed/...self-shell...`, match.yo), but
CODEGEN's type machinery never resolves shells:

* `collect_type` (codegen/types/collection.yo) collects the empty shell as a
  distinct type (distinct `type_key` — the shell carries a `__self_shell` id) and
  emits an empty C enum;
* `type_key` / `_type_key_at` and `get_type_string` (codegen/utils/index.yo)
  compute the shell's C identity/name independently of the final, so a
  `Box(shell)` field references the empty shell rather than the final enum.

## Fix plan (deliberate — touches codegen's recursive type traversal)

Resolve self-shells to their registered finals throughout codegen's type
handling, at EVERY level (the shell is nested inside `Box(Self)`, so a top-level
resolve is not enough):

1. `collect_type`: resolve `type` at entry so it recurses into the FINAL's
   variants (not the empty shell's).
2. `_type_key_at` and `get_type_string`: resolve at each recursion step so
   `Box(shell)` and `Box(final)` map to the SAME C key/name and only the final
   enum is emitted.

CAVEAT: do NOT route this through the EVALUATOR's type identity. enum.yo
deliberately gave the shell a DISTINCT id because sharing the final's id
conflated `Option(shell)` with `Option(final)` in the CTFE cache key
(std/encoding/json.yo regression). The codegen `type_key`/`get_type_string`
(codegen/utils/index.yo) are separate from the evaluator's CTFE identity, so
resolving there is safe — keep the change codegen-local.

## Impact

Likely a real self-host FIXPOINT blocker: `yo-self/expr.yo`'s `AstExpr` is itself
a recursive enum with a `Box(Self)` field (`FnCall(func : Box(Self), …)`), so its
codegen would hit the same empty-enum emission once the unified compile runs.
`--emit-c` (no C compiler) does NOT surface it; only a real C compile does.
Add `recursive_enum_nested_match.yo` (held in scratchpad) to the corpus once
fixed — it is a clean differential repro (TS passes, yo-self fails).
