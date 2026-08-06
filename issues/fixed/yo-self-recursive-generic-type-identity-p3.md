> **FIXED — verified 2026-08-06** (the status header below is stale): fixed by the later era-memo canonicalization (1f2dab455), which flipped tests/collections/linked_list.test.yo to 69/69 green.

# yo-self P3 refinement: recursive generic type instances aren't canonicalized (linked_list root)

_2026-07-20. Deep root trace of the `tests/collections/linked_list.test.yo` C
failure (`initializing/passing/assigning '__yo_tN' with incompatible '__yo_tM'`).
Refines the P3 "create_specialized per-call type identity" framing: for the
COLLECTION cluster (linked_list, arc, imm\_\_, sync/_, ordered*map) the failing
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

## TRIED + REVERTED (2026-07-20): enum-only cycle token is INSUFFICIENT

Implemented an eid-free `_enum_cycle_token` (variant names + discriminants +
`type_intern_key` of each variant field) swapped into the type_key ENUM cycle
guard for value enums (ref enums kept the eid path; the big compiler enums
TypeValue/AstExpr/EvalValue are all `ref(enum)` so they were untouched). Built
s1, emitted the repro: **the 7 `__yo_tN` mismatches persisted UNCHANGED.**
Reverted.

WHY it failed — the divergence is at EVERY level, not just the outer enum. The
repro's single `LinkedList(i32)` emits **6-7 distinct `Node` struct eids**
(struct_yo_id 4940/4946/4952/4954/4960/5182/5184) and **8 distinct Option enum
eids**. So `type_intern_key(Node)` — which the enum token embeds — is ITSELF
eid-divergent (Node has many eids, each with a divergent inner Option). A token
built from field intern keys inherits the whole-tree divergence; it can only
canonicalize when the sub-tree below is already stable, which it is NOT here.

LESSON: the fix cannot live in the enum cycle guard alone. It must be a genuine
eid-free canonical form applied UNIFORMLY to structs AND enums (the whole
recursive tree), OR — more promising — the divergence must be killed UPSTREAM so
one `LinkedList(i32)` instantiation reuses ONE `Node`/`Option(Node)` (generic
instantiation memoization / knot-tying at substitute time), which is closer to
what TS does (memoized instantiation + id-keyed codegen registry,
collection.ts:805). The codegen-only angle is a dead end while the evaluator
mints 6-7 Nodes per instantiation.

## Suggested next-session entry point (UPSTREAM — the codegen angle is disproven)

Kill the divergence at CONSTRUCTION: memoize generic type instantiations so
`LinkedList(i32)` (and its `Node` / `Option(Node)`) is built ONCE and reused,
matching TS (memoized instantiation + id-keyed codegen registry, creators.ts /
collection.ts:805). Steps:

1. Find where a generic struct/enum is instantiated for concrete args — the
   `substitute` path (types/substitution.yo, already wrapped in `intern_type`)
   and/or the specialization/`TypeApp` evaluator. Instrument with an eprintln at
   Node/`LinkedList` construction to count how many instances one
   `LinkedList(i32)` program mints and WHERE (the repro mints 6-7 Nodes).
2. Add a generic-instantiation memo keyed by (generic-type-id or
   constructor_func_id, type-args) that returns the SAME instance for repeat
   instantiations — with SHELL knot-tying so the recursive `Node ↔ Option(Node)`
   self-references resolve to the memoized instance (not a fresh shell). This is
   the "tie the knot once" that `intern_type` can't do because its key embeds the
   eid (so recursively-built instances never collide).
3. Gate HARD (this touches type construction → large blast radius, and is the
   exact zone that broke the 6 `wip/resolution-time-spec` attempts at
   self-compile scale): differential corpus (135/2/0) + `check ./std` + stage2
   clang + `s2 check std/env.yo` + STRICT*FIXPOINT + linked_list/arc emit-c diff.
   Build stage2 + `s2 check std/env.yo` FIRST (cheap early signal) before the
   full sweep. Expect the whole collection cluster (linked_list, arc, imm*_,
   sync/_, ordered_map — ~12 files) to unblock at once if instantiations unify.

Do NOT retry the codegen-only enum/struct cycle-token approach — proven
insufficient above (divergence is at every recursion level).

---

## SESSION 2026-07-21 — MECHANISM FULLY TRACED (census probes); FIX DESIGN

Instantiation census (probe in `evaluate_comptime_fn_call` at the cache-hit +
fresh-return sites, logging kind/eid/fid/should_cache/gates/arg-kind) on the
linked_list repro:

- **Node ctor (`fid=yo_id_4932`): 22 executions — 21 `a0=Tsomet sc=false`**
  (placeholder instantiations: def-time per-method trial evals bind a FRESH
  SomeT for `T` per method — function_type.yo `_build_def_time_body_env`; the
  SomeT cache-gate correctly refuses to cache them) **+ exactly 1
  `a0=Tconc sc=true`** (the real `Node(i32)`, eid 5184 — cached).
- **84 distinct Option instantiations** minted for one small program. The three
  that reach the failing C (`__yo_t1`=5186, `__yo_t12`=4956, `__yo_t14`=4962)
  are ALL `sc=true` (CACHED!) from the same Option ctor `fid=yo_id_2435` —
  three separate cache ENTRIES because their ARGS are three DIFFERENT
  concrete Node instances.

**The missing link — `substitute` mints concrete types with placeholder eids:**
`substitute` (types/substitution.yo Struct/EnumT arms) PRESERVES ids. When
specialization/type-resolution substitutes `T→i32` into a method's def-time
placeholder `Node@eid_M`, the result is a CONCRETE `Node(i32)` value that
RETAINS `eid_M` — no cache consultation. Then `Option(Node@eid_M)` (now a
fully-concrete arg) instantiates a fresh CACHED Option entry per `eid_M`
(`_ctfe_args_equal` distinguishes the Node instances by id). Per-method
lineages never converge; the C emits one struct per lineage.

TS never hits this: its `substituteType` (helper.ts:3037) only swaps the
forall SomeT at signature level, and every deep concrete type is produced by
RE-EVALUating the (cloned) body through the comptime-fn cache
(helper.ts:3014) — so all methods converge on the ONE memoized `Node(i32)`.
yo-self's spec ALSO re-evaluates the cloned body (helper.yo:1558/1607), but
type positions that arrive via structural `substitute` (annotations, receiver
field types baked into struct instances, resolved signatures) bypass the
cache.

### FIX DESIGN — canonicalize at substitute (cache-mediated)

In `substitute`'s Struct and EnumT arms: after building the substituted
instance, IF the result is fully concrete (`!type_contains_some_type`) AND the
type carries constructor identity (`Struct.constructor_func_id`; enums via
`lookup_enum_cfid`), consult the comptime-fn cache for
`(cfid, substituted type_arguments)`:

- HIT → return the CACHED instance (the canonical eid) instead of the rebuilt
  one. This converges every substituted `Node(i32)` on eid 5184, which
  converges the downstream `Option(Node)` cache keys, which unifies the C.
- MISS → keep the rebuilt instance (first-use; optionally register it as the
  canonical entry so later ctor calls converge on IT).

Plumbing: `g_comptime_fn_caches` lives in evaluator/calls/comptime_fn.yo,
which (transitively) imports types/substitution.yo — a direct import is a
cycle. Use the `g_enum_cfids` pattern (value.yo — "leaf both import, no
cycle"): a leaf-module side-table `(cfid, type_args_key) → TypeValue`
registered by `evaluate_comptime_fn_call` when it caches a type-returning
call, consulted by `substitute`. (Simplest: register in the same place the
cfid stamping happens, comptime_fn.yo ~line 867.)

RISKS (the 6×-fixpoint-breaking zone): (a) eid swap mid-flight — anything
keyed by the placeholder eid (trait-method registry entries, shell redirects)
must still resolve; TS-equivalence says the canonical instance has its own
registrations, but VERIFY. (b) enum variant*fields substitution must compare
by the same args key. (c) `type_arguments` on the substituted instance must be
the SUBSTITUTED args (they are — the arm substitutes `tyargs` too).
GATES: stage2 + `s2 check std/env.yo` FIRST (cheap early signal), then full
battery (corpus 135/2/0, std 153/153, STRICT_FIXPOINT, prior flips, and the
collection cluster sweep: linked_list arc imm*_ sync/_ ordered_map thread
worker).

---

## TRIED + REVERTED (2026-07-21): substitute-side cache-canonicalization (v1-v3)

Implemented the fix design above — canonical-instantiation registry in
types/intern.yo (struct key: cfid + arg intern-keys; enum key: cfid via
g_enum_cfids + eid-free structural render), registered at
evaluate_comptime_fn_call's should_cache finalize, consulted in substitute's
Struct + EnumT arms (gate-free: a placeholder's key contains SomeT tokens and
never matches a concrete registration).

**What it PROVED:** the mechanism converges constructor-level identity — the
census showed Node ctor calls cache-HITTING the canonical eid 5184 where 21
fresh placeholder mints happened at baseline. Generic-light programs
(ArrayList/HashMap/Option) compile and run fine.

**Why it FAILED anyway — the def-time-stamp leak:** linked_list crashed in
codegen (`get_enum_variant_c_name: no C type name found for enum 5131`).
Enum 5131 = a CACHED `Option(Node@placeholder)` instantiation stamped into
def-time ExprInfo. Such stamps NEVER flow through `substitute`, so no
substitution-side canonicalization can reach them — but the canonicalization
CHANGED which trees the C-type collection walks, leaving the def-time stamp
referenced-but-unregistered. Partial canonicalization creates NEW
inconsistencies between collection and emission. Measured damage: **corpus
129/6/2 vs baseline 135/2/0** (6 DIFF + 2 SELF-FAIL regressions), zero cluster
improvement (arc/thread/mutex/imm_list/ordered_map unchanged). REVERTED.

**Sharpened conclusion:** identity convergence cannot be grafted onto ONE
flow (substitution) while def-time-stamped ExprInfo reaches emission by other
flows. TS is consistent because emission consumes ONLY cache-converged
re-evaluated bodies — def-time placeholder stamps never reach codegen. The
complete fix is the `wip/resolution-time-spec` direction: make specialized
(re-evaluated) bodies the SOLE source of emitted ExprInfo, so every concrete
type reaching codegen went through the comptime-fn cache. The census probes
(P3HIT/P3MISS in comptime_fn.yo, see git history of this session) are the
right instrument to verify convergence when that lands.

**Census facts to reuse (linked_list repro):** Node ctor fid=yo_id_4932 — 22
executions: 21 `a0=Tsomet sc=false` (def-time per-method placeholder mints;
`_build_def_time_body_env` binds a FRESH SomeT per method) + 1
`a0=Tconc sc=true` (the real Node(i32), eid 5184). Option ctor fid=yo_id_2435:
84 distinct instantiations; the 3 reaching the failing C are all CACHED, keyed
by 3 different Node-instance args (the cascade). `substitute` PRESERVES ids —
the concrete-with-placeholder-eid instances are substitution products.

## 2026-07-21 — MAINLINE (feat/bootstrap-codegen) codegen structural-dedup attempt: REVERTED, decisive

Attempted on feat/bootstrap-codegen (per user directive, no wip branch): made
`stable_type_identity` (type_key.yo) render by STRUCTURE (positional cycle
markers, no nominal instance id) so same-layout recursive-generic instantiations
merge to one C type. GATED (.c/clang):

- codegen-bootstrap REGRESSED 137→135 (false-merged `dyn_fn_same_sig_closures`,
  segfault `io_async_two_await_struct`) — structural-only merge is UNSAFE
  (same-signature closures must stay distinct; confirms the type_key.yo comment
  warning). check ./std 153/153.
- LL repro UNCHANGED (5 FTT / 8 clang) — didn't even fix the target.
  Reverted.

ROOT (now conclusive): the PRIMARY `type_key` already does structural enum dedup
(`g_enum_sig_keys`) + struct cfid-keying + shell resolution + cycle guards, but
the recursive `Node(i32)` (`ref(struct(value, next:Option(Self), prev:Option(Self)))`)
has an UNSTABLE key — empty `constructor_func_id` on the recursive occurrence →
id-fallback → duplicate Node C-types (`__yo_t2`/`__yo_t13`) → duplicate
`Option(Node)` (`__yo_t14`/`__yo_t1`, enum ids 4962/5186) → LinkedList assignment
mismatch + FTT. The enum structural sig includes Node's key, so Node's instability
propagates up.

FIX SCOPE (empirically confirmed, not asserted): needs EVAL-SIDE stable identity
for recursive generic instantiations (stamp Node's cfid consistently) = the
resolution-time-spec architecture. All localized fixes ruled out with gated
evidence: codegen structural-merge (this, 135/137 regress), codegen cfid-recovery
(wip: eval fixed but codegen crash/miscompile), eval substitute-side canon
(mainline prior: corpus 129/6/2 regress). No clean localized fix exists.

### Hard-data confirmation (2026-07-21, TK-STRUCT probe on the LL repro)

Instrumented `_type_key_at`'s Struct arm to dump (sid, first-field-label, cfid
HAS/EMPTY, type_args count) for every 3-field ref-struct reaching type_key.
Node(i32) (l0=value) proliferates into >=5 DISTINCT struct ids:
sid 4940: 40x cfid=EMPTY + 2x cfid=HAS(tas=1)
sid 4946: 37x EMPTY + 1x HAS
sid 4954: 43x EMPTY (never HAS)
sid 4960: 86x EMPTY (never HAS)
sid 5184: 56x EMPTY + 14x HAS
LinkedList (l0=head): sids 4952/5025/5182 (cfid=HAS) + decl-shell 56459 (EMPTY).

So the SAME logical Node(i32) is minted as many struct instances. Where a sid
ever arrives cfid=HAS (4940/4946/5184), the g_struct_cfid_keys recovery dedups
its EMPTY copies. But 4954/4960 arrive ONLY cfid=EMPTY with their own unique
sids -> structural fallback keys them by their distinct sid -> distinct C types
-> the **yo_t14/**yo_t1 (Option(Node)) mismatch + FTT.

CONCLUSION (data-backed, not asserted): the fix is eval-side canonicalization so
`Node(i32)` returns ONE canonical instance (one sid, cfid-stamped) from the
comptime-fn cache across ALL call sites incl. the recursive `Self` placeholder.
This is precisely the resolution-time-spec / instantiation-canonicalization
direction that feat/bootstrap-codegen's HEAD (ae10e6844) tried substitute-side
and reverted (corpus 129/6/2). No safe codegen-local dedup exists (structural
merge regresses same-signature closures: 137->135). Multi-session architectural.
