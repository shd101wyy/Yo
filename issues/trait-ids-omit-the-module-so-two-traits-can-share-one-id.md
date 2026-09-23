# Trait ids omit the module, so two traits at the same row/column share one id

**Status:** OPEN. Found 2026-09-16 while investigating
`a-two-line-comment-change-in-std-prelude-fails-check-std.md`. A COLLISION
EXISTS IN THE TREE TODAY.

## The defect

`src/evaluator/types/trait.yo:1062` mints a trait's identity with:

```rust
trait_id := stable_label_id(String.from("trait_"), decl_tok.module_path, decl_tok.row, decl_tok.column);
```

and `stable_label_id` (`src/utils.yo`) returns:

```rust
k := stable_occurrence_key(`${module_path}:${row.to_string()}:${column.to_string()}`);
`${prefix}r${row.to_string()}c${column.to_string()}_n${k.to_string()}`
```

**`module_path` never reaches the returned id.** It is used only to key the
occurrence counter `k`, and `k` is per-(path,row,column) — so two traits in
DIFFERENT modules at the same row and column each get `k = 0` and therefore the
byte-identical id `trait_r<row>c<col>_n0`.

Contrast `stable_position_id`, which structs and enums use
(`src/evaluator/types/struct.yo:87`, `src/evaluator/types/enum.yo:324`). It
embeds `_stable_id_module_stem(module_path)` AND carries a
`g_stable_id_owner` registry that appends `_x<suffix>` when a candidate is
already owned by a different source key. Traits have neither the module
component nor the disambiguation loop.

## It is not hypothetical — `std/` collides today

```
std/log.yo:117:1           Sink   :: trait(
std/async/stream.yo:117:1  Stream :: trait(
```

Both mint `trait_r117c1_n0`. Two unrelated traits, one id, in a tree where
`check ./std` is currently 175/175 green.

## What this does and does not explain

It does NOT explain the prelude defect in the sibling issue. That was tested:
shifting `std/prelude.yo`'s `Comptime` to row 46 makes it collide with
`std/crypto/digest.yo:46:1`'s `Digest`, but moving `Digest` off row 46 while
keeping the prelude shift leaves the failure exactly as it was (172/175, same
three sites). So the two are separate.

In fact the `Sink`/`Stream` collision is evidence AGAINST trait-id collision
being that bug's mechanism: a live collision is sitting in the tree right now
without producing a visible error, so a collision is evidently not sufficient
to break a trait bound.

## Why it still matters

"Currently latent" is not "harmless". The id is content-derived precisely so
emitted C names stay byte-identical across unrelated edits — that is the point
of `stable_*_id`, and it is load-bearing for the fixpoint gate. An id that two
traits share is a name two traits share. Whether that is benign depends
entirely on which consumers key on `trait_id`, and today it is one edit away
from changing: adding a line to `std/log.yo` above row 117 moves `Sink` off the
collision, and adding one to a third module can move some other trait onto it.

A latent defect that appears and disappears with unrelated line edits is also
exactly the kind that gets misattributed to whatever change happened to be in
flight when it surfaced.

## Fix shape

Give `stable_label_id` the module component `stable_position_id` already has,
or route trait ids through `stable_position_id` outright. The second is
preferable — it also brings the `g_stable_id_owner` disambiguation, so a
residual collision becomes `_x2` rather than a silent share.

**The gate is not `check ./std`.** Trait ids feed emitted C names, so this
needs the differential corpus and the fixpoint check: changing the id format
changes every derived C name, which is a byte-identity event by construction.
Expect to re-record goldens, and confirm the change is a pure renaming rather
than a structural one ([[yo-byte-identity-gate-for-additive-codegen-change]]).

## Addendum 2026-09-23: anonymous structs share the same id scheme (type-system audit)

MEASURED on a develop build `d455b6a67` (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 3). `stable_type_id`
(`src/utils.yo` ~309) is used for traits, CTFE instantiations, anonymous struct values
(`src/evaluator/values/anonymous_struct.yo` ~89) and unions, so the collision is not trait-only.
Two modules each export an anonymous record constant at the same row and column:

```rust
// m1.yo
{ String } :: import("std/string");
V :: { x : i32(7) };
export(V);
// m2.yo (V at the same row/col as in m1.yo)
{ String } :: import("std/string");
V :: { y : f64(2.5), z : true };
export(V);
```

Importing both as `V1`/`V2` gives `Type.eq(typeof(V1), typeof(V2)) = 1`. Adding one blank line
above `V` in `m2.yo` gives `eq=0`. (`Type.is_compatible_with` is 1 in both cases, which is the
separate anonymous-wildcard bug in
`issues/struct-compatibility-accepts-a-name-match-or-an-anonymous-wildcard.md`.)

Position-keyed ids also make C type names follow the source position: adding one comment line
above `P :: struct(...)` changed its C name from `__yo_t_2236567100777795219` to
`__yo_t_442740067331228635`, and moving the file into `sub/` changed it again. That invalidates
`.o` chunk caches and makes emitted-C diffs noisy.
