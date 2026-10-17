# Two recursive enums of one shape share their `ArrayList(Self)` instantiation

**Severity:** S2 — two distinct recursive enums with the same variant names and field types get ONE `ArrayList(Self)` type: `ArrayList(B)` is accepted where `ArrayList(A)` is expected, an element of `B`'s list dispatches as an `A`, and a valid program that gives the two different `Eq` impls emits C that does not compile; renaming one variant works around it.

> Found 2026-10-17 while gating
> `issues/fixed/2026-10-15-yo-fix-over-several-files-applies-one-files-generic-impls-to-anothers-same-named-type.md`.
> Once that fix let `tests/impl.test.yo` evaluate in a directory run, its `MrE`
> (`enum(Leaf(v : i32), Node(kids : ArrayList(Self)))`) took over the
> elements of `tests/lazy_toplevel_bindings.test.yo`'s `Tree`, which has the
> same shape, and that file reported `E0610: No matching call found for
> operator "!=" with receiver type "MrE"` under
> `yo fix ./tests --migrate mutable-globals`. Reproduces on the v0.2.63 seed.

## Reproducer

An invalid program that is accepted (one file, `yo check`):

```yo
{ ArrayList } :: import("std/collections/array_list");
A :: enum(Leaf(v : i32), Node(kids : ArrayList(Self)));
B :: enum(Leaf(v : i32), Node(kids : ArrayList(Self)));
main :: (fn() -> unit)({
  xs := ArrayList(B).new();
  xs.push(B.Leaf(v : i32(1)));
  (ys : ArrayList(A)) = xs;   // accepted; should be E0601
  _n := match(B.Node(kids : ys), .Node(k) => k.len(), _ => usize(0));
});
export(main);
```

With non-recursive enums of one shape, or with `(a : A) = b`, the same
assignment is correctly rejected (E0601). With a different variant name
(`Branch` for `Node`) the two lists are distinct.

A valid program that does not compile: give `A` an `Eq` impl (`==` always
`true`) and `B` a structural one whose helper reads list elements
(`a(i) != b(i)` over `&ArrayList(B)`), then compare two `B.Node`s:
`yo compile` fails in the C compiler with 7 `incompatible pointer types`
errors (v0.2.63 and the tree). Renaming `B.Node` to `B.Branch` compiles and
prints the correct `false`.

Across files, the same shape is what the directory run hit: two files, each
declaring one of the enums with its own `Eq` impl and a list-reading helper
placed before the impl, check clean one at a time; `yo check .` over both
fails the second with E0610 naming the first file's enum.

## Root cause (suspected)

`src/types/type_key.yo` deduplicates enums by STRUCTURAL signature
(`g_enum_sig_keys`, `_lookup_or_register_enum_sig`): variant names,
discriminants and field-type keys, deliberately without the id, first
registration wins. It exists so that one generic enum instantiation reached
along two paths (`Option(i32)` from `ArrayList.get()` and from an iterator's
`next()`) gets one C type (`issues/fixed/yo-self-iterator-option-identity.md`).
The evaluator's specialization signature uses the same key
(`compute_compile_time_signature`, `src/evaluator/calls/helper.yo`), so two
distinct DECLARATIONS of one shape also collapse: `ArrayList(B)` specializes
as `ArrayList(A)`, and its element type is `A`.

## Fix direction

Key the structural dedup on the declaration too: two instantiations of one
generic enum constructor (or one declaration reached through two eval ids)
may merge, two different declarations may not. The declaration-stable enum id
(`stable_position_id("enum_decl_", ...)`, `src/evaluator/types/enum.yo`) or
`type_decl_module` plus the declaration position are candidates for the extra
key component. Any change here needs the C-type-identity cases the dedup was
added for to stay merged.
