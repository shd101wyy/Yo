# `std/imm` exports nine internal node types nothing can use — dead surface about to be frozen stable

**Status: OPEN.** Severity: **api-lie / dead public surface**. Found 2026-09-04
during the std-API-audit re-measurement of the `std/imm` row, at v0.2.24.

`std/imm/map.yo`, `std/imm/sorted_map.yo` and `std/imm/list.yo` export nine
names that are the private guts of their data structures: HAMT nodes, red-black
tree nodes, a cons cell, and two helper result records. Nothing outside the
module that defines each one references any of them — not `src/`, not the rest
of `std/`, not `tests/`, not `vendor/`. They appear in no public method
signature. They are exported anyway, and under the current stability rule they
are **stable API** the moment the family is frozen.

## The nine names

| name | exported at | referenced outside its own module? |
| --- | --- | --- |
| `MapNode` | `std/imm/map.yo:1003` | no |
| `MapBranch` | `std/imm/map.yo:1003` | no |
| `MapLeaf` | `std/imm/map.yo:1003` | no |
| `MapCollision` | `std/imm/map.yo:1003` | no |
| `InsertResult` | `std/imm/map.yo:1003` | no |
| `RemoveResult` | `std/imm/map.yo:1003` | no |
| `RBNode` | `std/imm/sorted_map.yo:659` | no |
| `Color` | `std/imm/sorted_map.yo:660` | no |
| `ListNode` | `std/imm/list.yo:287-290` | no |

Measured by enumerating every `import` of a `std/imm` module anywhere in the
tree:

```
$ grep -rn --include='*.yo' 'import("[^"]*std/imm/\|import("\.\./imm/\|import("\./imm/' . | grep -v '^./std/imm/'
tests/imm_threading.test.yo:11:{ Vec, PopResult } :: import("std/imm/vec");
tests/imm_threading.test.yo:12:{ List } :: import("std/imm/list");
tests/imm_threading.test.yo:13:{ Map } :: import("std/imm/map");
tests/imm_threading.test.yo:14:{ Set } :: import("std/imm/set");
tests/imm_threading.test.yo:15:{ SortedMap } :: import("std/imm/sorted_map");
tests/imm_threading.test.yo:16:{ SortedSet } :: import("std/imm/sorted_set");
tests/imm_threading.test.yo:17:{ ImmString } :: import("std/imm/string");
tests/imm_vec.test.yo:3:{ Vec, PopResult } :: import("../std/imm/vec");
tests/imm_vec.test.yo:5:{ ImmString } :: import("../std/imm/string");
tests/imm_sorted_set.test.yo:4:{ SortedSet } :: import("std/imm/sorted_set");
tests/imm_sorted_set.test.yo:5:{ List } :: import("std/imm/list");
tests/imm_map.test.yo:2:{ Map, MapEntry } :: import("std/imm/map");
tests/imm_map.test.yo:3:{ List } :: import("std/imm/list");
tests/imm_map.test.yo:4:{ ImmString } :: import("std/imm/string");
tests/imm_sorted_map.test.yo:3:{ SortedMap } :: import("std/imm/sorted_map");
tests/imm_sorted_map.test.yo:4:{ List } :: import("std/imm/list");
tests/imm_list.test.yo:4:{ List } :: import("std/imm/list");
tests/imm_set.test.yo:4:{ Set } :: import("std/imm/set");
tests/hash.test.yo:12:{ ImmString } :: import("std/imm/string");
tests/imm_string.test.yo:3:{ ImmString } :: import("std/imm/string");
tests/codegen-bootstrap/comptime_param_value_spec.yo:4:{ Map } :: import("std/imm/map");
tests/codegen-bootstrap/imm_map_entries_shell.yo:2:{ Map, MapEntry } :: import("std/imm/map");
tests/codegen-bootstrap/imm_map_entries_shell.yo:3:{ List } :: import("std/imm/list");
issues/repros/imm-map-wasm32-unwrap-none.yo:6:{ Map } :: import("std/imm/map");
issues/repros/imm-map-unspecialized-comptime-helper.yo:20:{ Map } :: import("std/imm/map");
issues/repros/gap6-imm-list-flagship.yo:4:{ List } :: import("std/imm/list");
issues/repros/closure-arg-abandons-enclosing-begin.yo:35:{ List } :: import("std/imm/list");
```

The whole imported surface is `Vec`, `PopResult`, `List`, `Map`, `MapEntry`,
`Set`, `SortedMap`, `SortedSet`, `ImmString`. None of the nine appears.

## They are not reachable through the public API either

Every public method of `Map` (`std/imm/map.yo:870-980`) returns `Self`,
`Option(V)`, `usize`, `bool`, `List(K)`, `List(V)`, `List(MapEntry(K, V))` or
`Map(K, U)`. `InsertResult` and `RemoveResult` are produced only by the private
`_node_insert` / `_node_remove` helpers (`:388-465`, `:517-605`) and consumed
only inside the module; `MapNode` / `MapBranch` / `MapLeaf` / `MapCollision`
appear only in those helpers and in `Map`'s private `_root` field (`:154`).
`RBNode` and `Color` are the same story in `std/imm/sorted_map.yo`; `ListNode`
is `List`'s private `_head` cell (`std/imm/list.yo:46`).

So a user cannot obtain a value of any of these types from the public API, and
cannot do anything with the exported names except spell them in an annotation
that nothing produces.

Contrast `PopResult` (`std/imm/vec.yo:483`), which IS legitimately public:
`Vec.pop` returns it, and `tests/imm_vec.test.yo:3` / `tests/imm_threading.test.yo:11`
import it for exactly that reason. `ImmStringChars` / `ImmStringCharIndices`
(`std/imm/string.yo:861`) are the same legitimate class — `chars()` and
`char_indices()` return them (`:650-656`) — even though nothing imports them by
name today.

## Why this matters now

`.github/instructions/yo-design.instructions.md:156`:

> Dead surface is not "stable": an export with no consumer and no test is
> deleted BEFORE it is frozen (the §6 rule), never marked stable by default.
> Freezing an export no test exercises is how a broken API becomes permanent
> (C34).

`std/imm` carries no `## Stability` marker on any of its seven modules
(`grep -rn "## Stability" std/` returns only `std/term.yo:6`,
`std/encoding/csv.yo:20`, `std/http/server.yo:18`, `std/fs/watch.yo:28`), so by
the rule two lines above that one — "every `std` module is **stable** unless its
module doc carries a `## Stability` section" — all nine names are ALREADY
stable, and removing them would already be a breaking change. That is the
opposite of the audit's own O4 verdict (`plans/STD_API_AUDIT.md:778-780`: keep
`imm/` in std, "mark unstable until it has real consumers").

## Note, NOT part of this defect: the `MapEntry` re-export

`std/imm/map.yo:1003` also re-exports `MapEntry`, which it imports at `:31`
from the owning `../collections/entry.yo` (`export(MapEntry)` at
`std/collections/entry.yo:29`). That looked like the same class of problem, and
it is not: measured, `MapEntry` is re-exported by **four** modules —
`std/collections/hash_map.yo:869`, `std/collections/btree_map.yo:16`,
`std/collections/ordered_map.yo:265` and `std/imm/map.yo:1003` — so a
same-module re-export of the entry type is an established house pattern for
map-shaped containers, not an imm slip. Leave it alone in this PR; if it is
ever revisited, revisit all four together.

One detail IS worth recording while touching these files:
`std/imm/sorted_map.yo:23` imports `MapEntry` from `./map.yo` — the sibling's
re-export — rather than from the owning `../collections/entry.yo`. That is a
second-hop alias: `sorted_map` depends on `map`'s export list for a type
neither module owns. Repointing that one line to
`{ MapEntry } :: import("../collections/entry.yo");` costs nothing and removes
a coupling between two independent containers. It also means anyone who DOES
later drop the imm re-export must fix `sorted_map.yo:23` first, or `std/imm`
stops compiling.

## Fix

1. Delete the six internal names from `std/imm/map.yo:1003`, leaving
   `export(Map, MapEntry);`.
2. Delete `std/imm/sorted_map.yo:659-660` entirely (the `export(SortedMap);` on
   `:658` stays).
3. Change `std/imm/list.yo:287-290` to `export(List);`.
4. Repoint `std/imm/sorted_map.yo:23` at `../collections/entry.yo` (see the
   note above).

No implementation code moves; the `impl(... ListNode(T), Acyclic())` and the
`RBNode` / `Color` definitions and impls stay exactly where they are, since they
live in the same module as their uses.

## Breaking change

Removing an export is not additive
(`.github/instructions/yo-design.instructions.md:147`: "Renames, signature
changes, removed exports, changed error variants, changed defaults and changed
wire/serialization formats are NOT additive"). Because no `std/imm` module
carries a `## Stability` section today, these nine names are formally stable
right now, so the deletion is a **breaking `std` change** and must be called out
in the release notes for the v0.2.x patch it ships in.

It is nevertheless the right change, and the rule two lines further on says so
directly: dead surface is deleted BEFORE it is frozen, never marked stable by
default. The practical blast radius is zero — no file in the tree imports any of
the nine, and none is reachable from any public signature, so no in-tree
consumer breaks and no out-of-tree consumer can have had one that worked.

The cheapest way to make this honest rather than merely defensible is to land
the `## Stability` marker on all seven `std/imm` modules FIRST (the audit's O4
verdict, `plans/STD_API_AUDIT.md:778-780`, still un-executed: `grep -rn "## Stability" std/`
returns only `std/term.yo:6`, `std/encoding/csv.yo:20`, `std/http/server.yo:18`,
`std/fs/watch.yo:28`). With the family marked unstable the deletion is inside
the declared window and needs no deprecation dance.

## Sequencing

Do this AFTER the imm iteration work (`plans/STD_API_AUDIT.md` §4 imm row: no
`std/imm` module has an `IntoIterator` — `grep -n "IntoIterator" std/imm/*.yo`
is empty across all seven — while seven `std/collections` modules do
(`array_list`, `deque`, `linked_list`, `hash_map`, `hash_set`, `btree_map`,
`priority_queue`)), so the
new iterator structs are not built on names that are about to be deleted, and
so the deletion PR does not have to be re-reviewed against them.

## Verification when the fix lands

* `yo check ./std --std-path ./std` clean.
* All eight `tests/imm_*.test.yo` green unchanged (213 test blocks) — no test
  file needs editing: none of the nine is imported anywhere.
* `yo test ./tests/codegen-bootstrap` — `imm_map_entries_shell.yo` and
  `comptime_param_value_spec.yo` are compiler stress fixtures over `std/imm/map`
  and must keep compiling.
* `grep -rn --include='*.yo' 'MapNode\|MapBranch\|MapLeaf\|MapCollision\|InsertResult\|RemoveResult\|RBNode\|ListNode' . | grep -v '^./std/imm/'` returns
  nothing that resolves to these types (the bare names collide with unrelated
  definitions elsewhere — e.g. `Color` in `std/term` — so grep by name alone
  over-matches; the import enumeration above is the honest check).

## Regression test

Deleting an export is not directly testable, so the guard is the import
enumeration, not an assertion. Add the imm family to the S5 export-coverage
discipline instead: `tests/std_export_coverage.test.yo` exists precisely to
back "marking it stable" with a runtime test per exported name
(`tests/std_export_coverage.test.yo:1-4`). Once the nine are gone, every
remaining `std/imm` export is exercised by `tests/imm_*.test.yo`, which is the
condition the §6 rule asks for before the freeze.
