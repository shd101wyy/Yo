# Go-to-definition has no target for members: `p.x`, `.Some`, `p.dist()`, `list.push`, `mod.f` all answer nothing

**Status:** FIXED 2026-09-08. Recorded as "left open" by
issues/fixed/lsp-member-and-label-atoms-resolve-to-same-named-locals.md (which
turned the previous WRONG target into no target). **Severity:** feature gap on
the most-used navigation.

## Why it was open

`TypeValue.Struct` / `EnumT` carry field labels and types but no declaration
tokens, and the attic's struct-field / enum-variant channels were never
ported. Adding token fields to the type variants would touch ~150 positional
construction/pattern sites and risk the fixpoint for a purely editor-facing
need.

## Fix

`src/lsp/definition.yo` gains a MEMBER channel that re-reads the declaring
module's AST instead of asking the type:

- **Owner type** of the access: the receiver's type (completion's
  `_receiver_at`: ExprInfo, TypeVal unwrap, env refinement, pointer deref)
  for `recv.member`; the access's own type for a prefix `.Variant`; the call's
  type for a struct-literal label `Point(x : …)`.
- **Field / variant**: the owner's head name — its written `name`, else the
  head of its `Ctor(...)` display name (`ArrayList(i32)` → `ArrayList`, the
  render-only table from issues/fixed/lsp-shows-internal-type-placeholders-to-users.md)
  — resolves through the env to the binding that declared it
  (`initialized_at_token`), whose module is parsed (`mm_module_source`, or the
  open document's own program) and whose `name :: value` subtree is searched
  for the `struct(...)`/`union(...)`/`newtype(...)` pair or the `enum(...)`
  variant.
- **Method**: the per-type registry (`get_type_trait_methods_for_type`, both
  the receiver and its pointer target) or the generic-impl registry (new
  `find_generic_impl_method_value` in `src/evaluator/values/impl.yo`, the same
  match rule the doc enumerator uses) yields the `FuncVal`; its body token
  pins the declaring module, and the `label : value` pair whose value subtree
  holds that position is the target. A synthesized method with no pair jumps
  to the body itself.
- **Module member** `mod.f`: `mod`'s `mod :: import("…")` binding gives the
  path, resolved like the evaluator resolves imports; the `f ::` binding in
  that module is the target.

Cross-file targets carry the wire encoding converted against the target
file's own lines.

## Verification

`tests/cli-cases/lsp-member-definition`: field (`p.x` → `struct(x : bool …)`),
inherent method (`p.sum` → the `sum :` pair in `impl(Point, …)`), variant
(`Color.Red` and the `.Red` match pattern → `enum(Red, …)`), label
(`Point(x : …)` → the field), generic-impl methods in std (`list.push`,
`list.len`, `opt.unwrap_or` → `std/collections/array_list.yo` /
`std/prelude.yo`, URIs normalized to `<REPO>` by the harness), and a module
member (`al.ArrayList` → the `ArrayList ::` binding).
