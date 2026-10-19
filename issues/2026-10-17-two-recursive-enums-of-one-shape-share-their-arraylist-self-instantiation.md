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
  (ys : ArrayList(A)) = xs; // accepted; should be E0601
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

## Attempted 2026-10-18 (not landed; two measured dead ends)

Two half-fixes were built and measured; each breaks std, and the failure
mode of BOTH is the same underlying gap:

1. **Dedup keyed by a decl part derived from the id string**
   (`_enum_decl_part`: the `enum_decl_…` id verbatim, the `enum_…_n<k>`
   CTFE id with its occurrence counters stripped). `check ./std` stays
   green (172/172) but the SAME declaration reached once through its
   module-level id and once through a CTFE-minted id keys APART:
   `ArrayList(RecA)` built directly and the `ArrayList(Self)` inside
   `RecA`'s own `Node` variant got two C structs, and the doc's own
   "valid program does not compile" symptom reproduces BETWEEN THE TWO
   RENDITIONS OF ONE LIST (`initialization of '__yo_t_1388…*' from
   incompatible pointer type '__yo_t_1571…*'` at the `Node.kids`
   initializer).
2. **A compatibility rejection on differing decl parts** (the assignment
   acceptance): even scoped to empty-named renditions and same-family ids,
   std/allocator.yo's `Allocator.same` (`self.ctx == other.ctx`) goes
   E0605 — legitimate same-type comparisons cross the id families too.

The missing primitive is one DECLARATION IDENTITY that both id families
resolve to: the module-level `enum_decl_<stem>_<anchor>` and the CTFE
`enum_<module>_<anchor>_n<k>` spell one declaration's anchor differently, so
any string derivation from the ids splits renditions that must merge. The
promising direction is upstream of the ids: stamp the DECLARATION's
`stable_position_id` into every instantiation minted from that declaration
(evaluator/types/enum.yo id minting, the ctfe_depth split), and key both the
sig dedup and any nominal compat rule on THAT. Measured with tree builds
v2-v6 under `~/Workspace/Yo-wt/vbd-logs/evalgen-v66/build-i2-v*.log` and
`verify-i2-v*.log`.
