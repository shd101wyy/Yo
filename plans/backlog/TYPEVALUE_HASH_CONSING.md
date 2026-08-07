# TypeValue hash-consing — design & scoping (P2 memory, peak reduction)

Status: **DESIGN / not started.** Successor lever to the RC-header shrink
(`c8fa9157c`, −0.43 GB steady). This is the one remaining lever with **multi-GB,
peak-reducing** potential; it is a substantial, multi-phase change with real
correctness risk. Read the whole doc before touching code.

---

## 1. Why (the measured problem)

macOS `heap` on the yo-self **binary** self-compiling `yo-self/main.yo` (verified
sizes via a `-Dmain` include-the-emitted-C `sizeof` probe; header now 56 B):

| Object                                                                                            | sizeof | malloc class | live count | total   |
| ------------------------------------------------------------------------------------------------- | ------ | ------------ | ---------- | ------- |
| **TypeValue** (`ref(enum)`)                                                                       | 168 B  | 176/192      | **~13 M**  | ~2.5 GB |
| **ArrayList** objects — TypeValues' `field_types`/`param_types`/`forall_types`/`variant_fields`/… | 80 B   | 80           | **~26 M**  | ~2.1 GB |
| ArrayList backing buffers                                                                         | —      | 16/32        | ~16.5 M    | ~0.5 GB |

**~90 % of the heap is rooted in TypeValue + its collection fields.** The TS
reference compiles the same input in **81 s at ~3.3 GB**; the yo-self binary peaks
**~9.5 GB** (transient eval surge) and is compressor-thrash-slow on 16 GB. The gap
is that yo-self allocates **~13 M distinct TypeValue objects** where TS both shares
references and lets the JS GC collect transients.

Two facts that shape the design (both established this session):

- **Allocation is DIFFUSE** (MallocStackLogging: largest single backtrace ~14 MB of
  ~6 GB; construction spread across `evaluate_struct_type`, `substitute`,
  `synthesize`, `_patch_self_shell`, `evaluate_comptime_fn_call`, …). ⇒ No hot site;
  a per-site fix cannot work. Interning must live at a **chokepoint** (construction
  factory) or be applied uniformly.
- **The fit-determining metric is the transient PEAK, not steady size.** The header
  shrink cut steady heap 0.43 GB but left the ~9.5 GB peak unchanged, because the
  peak is a surge of _many distinct objects_, not per-object size. ⇒ Only reducing
  the **count** (dedup) attacks the peak. Hash-consing is the count lever.

Expected payoff: if the program has **D** distinct types and the evaluator
materialises **N ≈ 13 M** TypeValue objects, hash-consing collapses N→D. D is
bounded by the program's actual type vocabulary (concrete types, function
signatures, struct/enum instantiations) — plausibly ~10⁵–10⁶, i.e. a **5–13×**
reduction in TypeValue objects and their attached ArrayLists. That is the only
change with a credible path to <16 GB peak (and toward the ~3.3 GB TS bar).

---

## 2. What hash-consing is here

Maintain a global **intern table**: a canonical, deduplicated store of TypeValues.
Construction returns the existing canonical instance for a structurally-equal type
instead of allocating a new one. Because `TypeValue` is already a `ref(enum)`
(a pointer), "sharing" is just returning the same pointer + an RC bump — no
representation change is needed (unlike the "convert TypeValue to a handle type"
worry in older P2 notes; that work was already done by the `ref(enum)` refactor,
task #36).

**Recursive (bottom-up) interning.** A compound type's children are interned
_first_; then the parent's identity key is (variant tag, **child pointers**, scalar
fields). Once children are canonical, structural equality on the parent is O(1)
pointer comparison of children + scalar compare — no deep recursion at lookup time.

---

## 3. Faithfulness note (this is a deliberate divergence)

The TS reference **memoizes atomic types** (`src/types/creators.ts`:
`cachedComptimeIntType`, etc.) but does **not** hash-cons compound types — it
relies on JS reference sharing + generational GC. So full hash-consing is a
**yo-self-specific optimization**, in the same justified-divergence category as
`Token.clone` returning self, the `ref(enum)` model, and the cycle GC. It must be
documented as such (header comment on the intern module + this doc), and the
atomic-type portion should be framed as _completing_ the port of TS's `cached*`
memoization.

---

## 4. Design

### 4.1 The intern table

```
// module: yo-self/types/intern.yo  (mirror: informed by src/types/, but this is
// a yo-self memory optimization — TS has only the atomic cached* singletons)
(g_type_intern : HashMap(u64, ArrayList(TypeValue))) = HashMap(u64, ArrayList(TypeValue)).new();
```

- Keyed by a **structural hash** `u64` (§4.3); value is a bucket (collision list)
  of canonical TypeValues sharing that hash.
- `intern(tv) -> TypeValue`: hash `tv`; scan its bucket for a structurally-equal
  entry (§4.4); if found, **drop `tv`, return the canonical**; else insert `tv`
  and return it.
- The table is a **GC root** (module-level global) → interned types live for the
  whole compile (intended: they are the dedup'd universe). They are never
  cycle-collected while the table holds them.

### 4.2 Where interning happens — CONSTRUCTION factory (not storage)

To reduce the **peak** (not just steady retention), transient duplicates must be
deduped _at construction_, so they are never separately allocated. Introduce
interning constructors and route **all** construction through them:

```
mk_unit()  mk_bool()  mk_int(bits, signed)  mk_usize()  ...   // atomics: §4.5
mk_pointer(pointee)            // interns pointee, then interns the Pointer node
mk_struct(id, name, field_labels, field_types, ...)           // compound: children pre-interned
mk_func(forall, params, implicit, where, result, meta)
mk_enum(...)  mk_tuple(...)  mk_union(...)  mk_trait(...)  mk_dyn(...)  ...
```

Each `mk_*`:

1. interns its child TypeValues (recursively — callers usually pass already-interned
   children, but `mk_*` re-interns defensively; interning an already-canonical value
   is an O(1) hash+pointer-hit),
2. constructs the node,
3. returns `intern(node)`.

**Rerouting.** Replace the ~86 `TypeValue.Xxx(...)` construction sites (26 Func, 25
Struct, 13 EnumT, …) — plus the `TypeValue.clone` reconstruction arms and the
`substitute`/`synthesize` builders — with the `mk_*` calls. This is the bulk of the
mechanical work. `creators.yo`'s `t_*()` accessors become thin wrappers over the
atomic `mk_*` singletons (this also _finally_ lands the TS `cached*` memoization
that a naive `t_*()`-memo attempt was a no-op for, because it caught only the
accessor, not inline construction — see the P2 memory milestone notes).

> **Storage-interning is the cheaper fallback** (intern only at `ExprInfo.ty` /
> `Variable.ty` setters): far fewer sites, dedups the _retained_ set (helps steady
> RSS), but does NOT dedup transient peaks. Use it as Phase 0 to validate the
> mechanism/mutation-safety cheaply, but the peak win needs construction-interning.

### 4.3 Structural hash

`type_hash(tv) -> u64`, mixing (murmur3 fmix64 — already used in the std HashMap's
`h1_hash`; see the hash-clustering fix in `git log`):

- the variant tag,
- scalar fields (bits/signed/level/bools/`id`/`name`/`cfid` string hashes),
- **child identity**: since children are interned, hash their POINTER/identity
  (or a per-node cached hash — see §4.7), not a deep re-hash.

### 4.4 Structural equality (`type_eq_canonical`)

Given children are interned, equality is shallow:

- same variant tag,
- scalar fields equal (string compare on `id`/`name`/`cfid`; `==` on bits/bools),
- children **pointer-equal** (ArrayList elements compared by element pointer, same
  length). No deep recursion.

> **Phase-0 finding (2026-07-01): the existing type-key helpers are UNSAFE to
> intern on — a purpose-built structural key/eq is mandatory for Phase 2.**
>
> - `type_to_string_key` (`types/string.yo`, `_tts(t, 36)`) is deliberately
>   **shallow/truncated** ("renders only the top few levels then `…`") to avoid an
>   O(n²) hang — so two distinct DEEP types can share a key ⇒ interning on it would
>   merge them ⇒ corruption.
> - `synthesis_type_id` (`evaluator/types/synthesizer.yo`) returns the bare `id`
>   for Struct/EnumT/TraitT/SomeT — which does NOT distinguish two generic
>   INSTANTIATIONS of the same definition (`HashMap(i32,str)` vs `HashMap(str,i32)`
>   share the struct `id`) ⇒ also unsafe as an identity key.
> - `type_to_string` (full, depth 40) still truncates at 40 and is O(depth); not a
>   safe/cheap key either.
>   So Phase 2 must build the recursive structural hash (§4.3) + `type_eq_canonical`
>   below; there is no ready-made shortcut. (Phase 0/1 — atomics — need no structural
>   key: atomics are keyed by (tag, bits/signed/level) trivially.)

This is DIFFERENT from the existing `are_types_compatible` (which is
subtyping/compatibility, not identity) and from `_ctfe_args_equal`. It is strict
structural identity for canonicalization. **Do not reuse the compatibility
predicates** — the Phase-3 HashMap.new blocker (name-only struct comparison was unsound for cache-key identity) shows name-only/loose
comparison is unsound for identity keys.

### 4.5 Atomics (Phase 1 — do first, lowest risk)

The ~31 nullary/atomic variants (`Unit`, `Str`, `BoolT`, `Int(bits,signed)`×8,
`Float(bits)`×2, `Usize`, `Isize`, `Comptime*`, `C*`, `TypeUni(level)`) are a finite
singleton set. `mk_int(32,true)` etc. return module-level singletons (exactly TS's
`cached*`). This validates the mechanism + mutation-safety on the simplest case
before touching compound types. NOTE: memoizing only `t_*()` was measured as a
**no-op** — Phase 1 is only meaningful once construction sites are rerouted to
`mk_*` (§4.2).

### 4.6 What must NOT be merged (identity-carrying types)

- **`SomeT`** (type variables): each has a fresh unique `id` and denotes a DISTINCT
  variable even when structurally similar. Its `id` is part of the key, so two
  different type-vars never merge (correct) — but this also means SomeT gets little
  dedup. Interning SomeT is still safe (keyed by id) but low-value; can be excluded
  in Phase 1–2 and revisited.
- Any type carrying a **fresh `random_id`** at construction: the id must be in the
  key, or interning would wrongly merge/duplicate. Audit `Struct.id`,
  `EnumT` id, `constructor_func_id` — these are deterministic per definition
  (good, they dedup instantiations correctly) EXCEPT where a fresh random id is
  minted (those won't dedup — acceptable).

### 4.7 Optional: cache a per-node hash

Store the computed `u64` hash on the node (there is spare room — after the header
shrink, TypeValue is 168 B / 176 class; a `u64 hash` field lands in the same class
if it fits the padding, else bumps to 192 — measure). Avoids re-hashing on every
intern lookup. Optional; add only if profiling shows hashing is hot.

---

## 4.8 CRITICAL constraint found by the Phase-1/2 attempt (2026-07-02)

A first implementation — a total, injective `type_intern_key` (atomics by tag;
structural types by full recursive structure; **named types Struct/EnumT/TraitT/
SomeT keyed by `id` (+ generic `type_arguments`)**), whole-tree interning at
`ExprInfo.ty` — compiled and passed `check ./std` 152/152 **but regressed the
differential corpus to 59 PASS / 32 SELF-FAIL.** The failures are **C-compiler
errors on malformed emitted types** (e.g. `__yo_enum_yo_id_3869_u8`), i.e. a
**wrong merge**: interning replaced an `ExprInfo.ty` with a canonical instance
that **codegen treats as a DIFFERENT type**. `check ./std` didn't catch it because
`check` doesn't run codegen; the corpus (full compile→C→run) did.

**Root lesson — the intern key MUST equal CODEGEN's type identity, which is finer
than the evaluator-side `id`.** Codegen already dedups type _emissions_ by its own
structural keys — `_type_key_at`, `g_struct_cfid_keys`, `g_enum_sig_keys`
(`codegen/utils/index.yo`) — using `constructor_func_id`/variant signatures/full
content, NOT the evaluator `id`. Keying by `id`(±args) merged types that share an
`id` but that codegen emits as distinct C types (generic instantiations, or
same-id types differing in fields codegen reads). So:

- **Phase 2's key must be, or exactly match, codegen's `_type_key_at` identity.**
  Options: (a) reuse `_type_key_at` as the intern key (but it is codegen-side and
  may need codegen state / mutate registries — evaluate feasibility at eval time);
  (b) replicate its exact keying evaluator-side and keep the two in lockstep (a
  divergence-risk if they drift). Either way, the eval-side `id`-based key used in
  this attempt is INSUFFICIENT and unsafe.
- **The differential corpus is the required gate** (not `check ./std`): any intern
  change must keep corpus 96/96. A cheaper pre-check: diff the interned self-compile
  `stage2.c` against the baseline — a wrong merge changes it.
- Kept the kill switch honest: the attempt was reverted (tree clean); `intern.yo`
  is recoverable from git.

This confirms hash-consing is genuinely a **codegen-coupled** change (the intern
identity and codegen's type identity are one and the same), which is why it is the
substantial multi-session core rather than a self-contained evaluator tweak.

## 5. Correctness: the mutation-safety invariant

**Interning is sound ONLY IF interned TypeValues are never mutated in place** (a
shared canonical must not change under one holder). Evidence it holds:

- `TypeValue.clone` already RC-shares nested collections and its doc asserts a
  "codebase-wide audit found NO in-place mutation of these fields."
- The clone-returns-self experiment this session shared whole TypeValue nodes and
  was **corpus-neutral** (96/96) — direct evidence that node sharing is behavior-safe.

But this is the #1 risk. **Before Phase 2**, do a dedicated audit + guard:

- grep for `.ty =`, `.field_types =`, `.<typevalue-field> =` reassignments on a
  TypeValue that could be interned; and for ArrayList `.push`/`.set`/`.clear` on a
  TypeValue's collection field after construction. the P1 dirB clone-Comptime finding
  historically found ONE in-place `.value=` on a reused prelude `TypeVal(Comptime)`
  — confirm it is gone / not on an interned path.
- Add a **debug assertion** (behind a flag): mark interned nodes; in RC-mutation or
  the relevant setters, assert an interned node is never written. Run the corpus +
  self-compile with it on.

If a mutation site exists, either (a) make it rebuild-not-mutate (preferred, matches
the invariant), or (b) exclude that construction path from interning.

---

## 6. GC interaction

- The intern table is a strong GC root; interned types are reachable for the whole
  compile → never cycle-collected while cached. Correct and intended.
- Recursive/cyclic types (self-referential enums via `_patch_self_shell`): the
  shell placeholder and the resolved node must intern consistently. **Risk**:
  interning a shell vs its resolved form as different keys. Handle by interning only
  AFTER shell resolution (`resolve_enum_shell`), or excluding shells. See
  the recursive-enum self-shell mechanism.
- RC: `intern` that finds a hit must **drop the caller's `tv`** (it's discarded) and
  return the canonical (RC bump). Get this exactly right or you leak / double-free.

---

## 7. Phasing & validation gates (never regress)

Gates each phase: **corpus 96/96** (`scripts/diff-test.sh`), **`check ./std`
152/152** (TS + yo-self binary), **cycle_collector 16/16**, **arc / atomic_object /
thread / imm_threading**, and a **heap measurement** (macOS `heap` node count +
`scripts/count-transpile-failures.sh` stays 0 real). Validate under a **clean env**
(`YO_MAIN_STACK_MB=2048`, kill stray procs). Commit per phase; mirror 1-to-1 in the
yo-self emitter is N/A here (this is evaluator-side `types/` code, not codegen) —
but keep TS `src/types/` and `yo-self/types/` in step where they correspond.

- **Phase 0 — storage-interning spike (cheap safety probe). ✅ DONE 2026-07-01
  (mechanism validated; reverted as a no-op — do NOT re-land as-is).** Implemented
  `intern_type` (atomic variants → memoized canonical singletons; compound
  pass-through) in `types/creators.yo` and applied it at the `ExprInfo.ty`
  chokepoint (`new_expr_info`). Result: **correct + safe** (`check ./std` 152/152,
  corpus 96/96 — atomic node-sharing does not break behavior) but **zero heap
  change** (59.1 M nodes / 5.72 GB, unchanged). Why: root-level ExprInfo.ty
  interning touches <688 K roots (<5 % of 13 M); the bulk is NESTED types (inside
  compound ArrayLists), `Variable.ty` (2.6 M), caches, and transients — none of
  which a root-only, atomics-only intern reaches. **Conclusion: skip narrow
  storage-interning; Phase 1 goes straight to construction-site + RECURSIVE
  interning.** The validated `intern_type` + singleton pattern (and the memoized
  `t_*()` idiom) can be regenerated from git history / the P2 memory notes.
- **Phase 1/2 — the KEY IS SOLVED + VALIDATED (2026-07-02), committed unwired as
  `yo-self/types/intern.yo` (`29bef3a9f`).** After the id-only key wrong-merged
  (§4.8), the fix was a FULL-CONTENT key (named types render name + all flags +
  field/variant types recursively, cycle-guarded by a monotonic visited-id set →
  injective and at-least-as-fine as codegen identity → cannot wrong-merge). Wiring
  it at `ExprInfo.ty` kept corpus 96/96 + check ./std 152/152 (CORRECT) but was a
  memory NO-OP (heap 59.9 M nodes unchanged — only ~688 K root tys deduped; the
  13 M are nested/`Variable.ty`/cache/transient), so it is left UNWIRED (not
  imported → not built → zero cost). Remaining work = reuse this validated key from
  (a) RECURSIVE interning (intern children + reconstruct the node — the 25-variant
  rebuild) or (b) CONSTRUCTION-site interning (also dedups transients → the PEAK).
- **FIRST WIN LANDED (`7f547078d`): `intern_type` wired at `substitute()`** →
  TypeValue 13.04 M → 11.59 M (−1.45 M), heap 5.72 → 5.44 GB, corpus 96/96.
  `substitute` recurses, so wrapping its result interns bottom-up (generic
  instantiations dedup).
- **KEY PRINCIPLE found (2026-07-02): intern at PRE-canonical construction, NOT at
  storage/downstream.** Wiring `intern_type` at `type_of_eval_value` AND at
  `Variable.ty` (`add_variable_to_env`) were BOTH net-NEGATIVE (reverted): each
  showed a **99.9 % hit rate** (only ~3.7 K distinct types across 36 M calls — types
  ARE massively duplicated) yet the heap grew, because the types reaching those
  points are **already canonical** (deduped upstream by `substitute`), so
  re-interning is pure redundant key-building overhead. So downstream/storage
  interning is redundant; only sources that emit types BEFORE canonicalization
  (like `substitute`) pay off.
- **The remaining ~11.6 M TypeValues + 26 M ArrayLists are `clone`-created NESTED
  nodes** (every stored type is a `.clone()` → a fresh top node sharing children;
  clone doesn't go through `substitute`). Deduping them needs either (a) interning
  at `TypeValue.clone` — BLOCKED by an import cycle (`clone` lives in
  `types/definitions.yo`, which `intern.yo` imports), or (b) RECURSIVE interning
  (intern children + reconstruct — but named types Struct/EnumT have self-referential
  fields, so reconstruction must treat them as leaves keyed by id, structural types
  reconstruct their children). Both are the bigger next step.
- **Phase 1 — atomics.** `mk_*` for all nullary/Int/Float/TypeUni; reroute their
  construction sites; `t_*()` → `mk_*`. Measure (should dedup the atomic slice).
- **Phase 2 — compound, one variant at a time.** Start with the highest-frequency
  compound (likely `Func` — every function/method type — then `Struct`, `EnumT`,
  `Pointer`, `Tuple`). For each: add `mk_<variant>`, reroute its ~N construction
  sites + the `TypeValue.clone` arm + substitute/synthesize builders, validate,
  measure the heap `node count` drop. Stop early if a variant regresses or its
  dedup is negligible.
- **Phase 3 — hash/eq tuning + optional per-node hash cache** if hashing is hot.
- **Phase 4 — measure the PEAK** on the full self-compile (clean env): target peak
  well under the previous ~9.5 GB and toward the ~5.5 GB steady, ideally opening
  headroom for a looser `YO_GC_FULL_PCT` (faster completion).

## 8. Risks & rollback

- **Mutation aliasing → corruption** (the P0 double-free class). Mitigate: §5 audit
  - debug assertion; phase gates; RC discipline in `intern`.
- **Merging types that must stay distinct** (SomeT/fresh-id). Mitigate: ids in the
  key; exclude SomeT early.
- **Shell/recursive-type interning inconsistency.** Mitigate: intern post-resolution.
- **Hashing/lookup becomes the new hot spot.** Mitigate: fmix64 + per-node hash
  cache; measure with `sample`.
- **Rollback:** each phase is an isolated commit; `mk_*` can fall back to plain
  construction (no intern) by making `intern` the identity function — a one-line
  kill switch to bisect a regression.

## 9. Effort estimate

Multi-session. Phase 0 ~½ day (spike + safety). Phases 1–2 the bulk (reroute ~86
construction sites + clone + substitute/synthesize; per-variant validate/measure).
The dominant cost is the careful reroute + per-phase self-compile measurement
(each full measure ~15–45 min wall in a clean env).

## References

- Measured breakdown, prior no-op experiments (clone-share, atomic-memo), header
  shrink `c8fa9157c`: `plans/archive/BOOTSTRAPPING_CODEGEN.md` P2 section + `git log`.
- Hash mixing (murmur3 fmix64): `std/collections/hash_map` `h1_hash`.
- Identity-key soundness lesson: name-only struct comparison is unsound for exact
  cache-key identity (Phase-3 `HashMap.new` blocker; see `git log`).
- Recursive-enum shell: `resolve_enum_shell` / `_patch_self_shell` in the evaluator.
- Header-shrink + GC knob: commits `c8fa9157c`, `ed48c310c`; `docs/en-US/CYCLE_COLLECTION.md`.
