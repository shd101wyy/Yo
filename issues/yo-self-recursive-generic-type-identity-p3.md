# yo-self P3 refinement: recursive generic type instances aren't canonicalized (linked_list root)

_2026-07-20. Deep root trace of the `tests/collections/linked_list.test.yo` C
failure (`initializing/passing/assigning '__yo_tN' with incompatible '__yo_tM'`).
Refines the P3 "create_specialized per-call type identity" framing: for the
COLLECTION cluster (linked_list, arc, imm__, sync/_, ordered*map) the failing
axis is RECURSIVE GENERIC TYPE-INSTANCE identity, not (only) method
specialization. NOT fixed — a careful equirecursive-canonicalization design is
required; documented here so the next P3 session starts from the exact root.*

## Minimal standalone repro (src/tests/fixme.yo)

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/collections/linked_list"));
main :: (fn(io : Io) -> unit)({
  list := LinkedList(i32).new();
  list.push_back(i32(10)); list.push_back(i32(20)); list.push_back(i32(30));
  a := list.get(usize(0)); b := list.insert(usize(1), i32(99)); c := list.remove(usize(1));
  sum := i32(0);
  for(list.iter(), (ptr) => { sum = (sum + ptr.*); });
  ()
});
export(main);
```

`s2 compile … --emit-c` then clang → e.g. `__yo_t14 x = self->tail;` where
`self->tail`'s C type is `__yo_t1` — incompatible.

## Exact root (traced in emitted C)

`Option(Node(i32))` is emitted as THREE distinct C structs with THREE eval ids:

- `__yo_t1` = enum **5186** — the Option in `Node`'s `next`/`prev` fields AND the
  `LinkedList` struct's `head`/`tail` fields (the C-emitted struct layout).
- `__yo_t12` = enum **4956**, `__yo_t14` = enum **4962** — the ExprInfo types of
  `self.head` / `self.tail` FIELD-ACCESS expressions inside methods.

`Node` (`struct_yo_id_5184`, ref-counted) has `next`/`prev : Option 5186`, so it
is structurally `Node → Option(Node) → Node* (ptr)` — a recursive cycle.

property_access is NOT at fault: it reads `base_ty.Struct.field_types[idx]`
directly (property_access.yo:1176), no re-substitution. So the divergence is
UPSTREAM — `self`'s `LinkedList(i32)` instance carries `head : Option 4962` while
the C-emitted `LinkedList(i32)` carries `head : Option 5186`. i.e. the SAME
generic instantiation `LinkedList(i32)` / `Option(Node(i32))` exists as multiple
eval-id instances across construction sites (each `substitute` builds fresh).

Neither canonicalization layer merges them:

1. **intern (`intern_type`, types/intern.yo):** the enum key is
   `E:${eid}{…structural…}` — it PREPENDS the eval id, and uses `E:${eid}` as the
   cycle-guard `visited` token. Two structurally-identical `Option(Node)` with
   different eids get DIFFERENT keys → NOT merged (deliberate under-dedup, "safe"
   per the header — but here it leaves the divergent instances alive).
2. **type_key (codegen identity, types/type_key.yo):** the enum structural sig
   (line 300-323, id-free) SHOULD merge them, but the recursion cycle guard
   (line 233) closes on the raw `eid`. `key(Option 4962)` recurses
   4962→Node5184→(next)Option5186→Node5184(cycle), while `key(Option 5186)`
   recurses 5186→Node5184→(next)Option5186(cycle) — the cycle closes at DIFFERENT
   structural depths because the Node's field is pinned to eid 5186. Divergent
   field_part → divergent sig → distinct C types.

## Why it's genuinely P3 (not a localized fix)

To merge them, `Option(Node(i32))` must be ONE instance (one eid) everywhere —
i.e. recursive generic instantiations must be canonicalized ("tie the knot").
The obvious lever is an eid-FREE cycle-detection token in the intern/type_key
recursion. But a NAME-only token wrong-merges `Option(i32)` vs `Option(String)`
(both `E:Option:None,Some`); distinguishing them needs the field types, which
reintroduce the recursion. A correct token is an EQUIRECURSIVE-TYPE canonical
form (regular-tree automaton / de Bruijn-style back-reference) — subtle, and its
wrong-merge surface is exactly what broke the 6 prior P3 attempts
(`wip/resolution-time-spec`) at self-compile scale. Must be a dedicated,
fully-gated arc; do NOT rush it (fixpoint is byte-identical-sensitive).

## The precise design constraint (why the obvious tokens fail)

The fix is a new eid-free cycle-detection token for type_key's enum guard (line 233) — the `g_enum_sig_keys` mechanism (type_key.yo:16-32) ALREADY dedups
structurally-identical enums; it only fails for RECURSIVE enums because the
cycle-close leaks the eid into the sig. A correct token must be simultaneously:

1. **eid-free** — so `Option(Node) @4962` and `@5186` produce ONE token (unify).
2. **injective** — so `Option(i32)` ≠ `Option(String)` (no wrong-merge → no
   malformed C / no self-compile-scale collapse, the attempt-#6 failure mode).
3. **recursion-safe** — bounded on the `Node ↔ Option(Node)` cycle.

The two ready-made functions each violate one:

- `type_to_string` (types/string.yo): the EnumT arm renders NAME ONLY (line 163
  → `"Option"`), dropping type args, so it is NOT injective for generic enums
  (`Option(i32)`≡`Option(String)`≡`"Option"`). Using it wrong-merges.
- `type_intern_key` (types/intern.yo): injective + recursion-safe, but its
  EnumT/Struct tokens are `E:${eid}` / `S:${sid}` — eid-DEPENDENT (violates 1).

An **id-based SHALLOW-field-tag** token (variant names + discriminants +
per-field one-level tag, where a named field renders `S:${id}`/`E:${id}` and a
primitive renders its tag) is SOUND (distinct types have distinct field ids ⇒
injective ⇒ no false-positive cycle ⇒ no wrong-merge) and COMPLETE whenever the
recursion passes through a STABLE-id type — which holds for linked collections
(the recursive knot goes through a `ref(struct)` Node whose id IS stable via the
shell mechanism; only the value-enum `Option` diverges). Risk: the shallow tag
must be injective across ALL ~25 TypeValue variants (a compound like
`Pointer(A)` rendered as a bare `"P"` WOULD wrong-merge `Pointer(A)` vs
`Pointer(B)` fields) — get every arm right or it's unsound.

## Suggested next-session entry point

Write `_enum_cycle_token(rs)` = variant names + discriminants + injective
one-level `_shallow_tag(field)` for every field (named→tag+id, primitive→tag,
Pointer/Array/Tuple/Func→tag + one-level shallow of children — NO bare markers).
Swap the enum guard (type*key.yo:233-238) to push/check this token instead of
`eid`; keep the `key := eid + field_part` full key (line 295) so
`_lookup_or_register_enum_sig` still merges by the now-eid-free sig. Leave the
STRUCT arm on ids (Node is stable; only touch it if the gate shows a value-struct
recursion needs it). Gate HARD: differential corpus (135/2/0) + `check ./std` +
stage2 clang + `s2 check std/env.yo` + STRICT_FIXPOINT + a targeted linked_list
& arc emit-c diff, BEFORE trusting it — a wrong-merge can pass the corpus yet
collapse self-compile. Expect the whole collection cluster (linked_list, arc,
imm*_, sync/_, ordered_map — ~12 files) to unblock at once IF sound + complete.
