# VALUES_BY_DEFAULT release schedule — draft (2026-10-20)

> **Status: DRAFT.** Written for the post-v0.2.67 handover. The coordinator folds it into that
> document. `plans/VALUES_BY_DEFAULT.md` §6 stays authoritative. Where the plan and a handover
> disagreed, and wherever the draft left a question open, the maintainer delegated the pick
> (2026-10-20); §5 "Decided 2026-10-20" records each pick and its reason, and the tables below
> follow it. Checked against develop `fc15a6092` (2026-10-20), with SEED_VERSION at v0.2.66.
> Plan line numbers cited here are develop's at `fc15a6092`, before this branch's dated notes in
> `plans/VALUES_BY_DEFAULT.md` (which shift them by 3 to 21 lines).

This draft maps every VBD step that has not landed to the release where it can land. It follows five rules:

- A Generation B needs a seed that carries its Generation A.
- Independent Generation A pieces may share a release.
- The §3.1 sharing prerequisites (2026-10-19 handover) come before the B1 regeneration.
- #1486 lands after the `Acyclic` declarations.
- V5 Generation A lands after decision 43 step 1 merges, and no later than v0.2.73 (§5, decision 6).

The macro/`Iso` campaign slots in as `plans/backlog/MACRO_AND_ISO_REMOVAL.md` "Schedule" says.

## 0. Baseline: what v0.2.67 is assumed to carry

The following are on develop since the v0.2.66 tag, or in flight on pushed branches:

- On develop:
  - #1485, the #1476 re-land.
  - The Generation B halves on the v0.2.66 seed: #1490, #1491, #1497 and #1498.
  - #1492, std declares `pragma(Pragma.AllowMacroDef)` itself.
  - #1501, the recursive-enum identity fix. This is the 2026-10-19 handover's §3.3, now landed.
  - #1503, the capture struct keyed by call signature. This is gi2 issue 1.
  - #1500, #1502 and #1504.
- In flight:
  - A4's std half: `feat/vbd-a4-std-half`, with the per-operand combinator spec on `fix/combinator-spec-per-operand-future`.
  - #1486, the LinkedList cycles fix (`fix/linkedlist-managed-element-cycles`). It waits for the PR with the 48 `impl(X, Acyclic())` declarations, which that branch does not carry. **Both are deferred to v0.2.68** (§5, decision 10); they are not v0.2.67 candidates.
  - The ArrayList same-named-binder fix (`fix/generic-impl-arraylist-binder-id`).

If any of the other in-flight items misses the v0.2.67 cut, it moves to v0.2.68. None of them is a release boundary, so the count in §3 does not change.

## 1. The schedule

The schedule follows an expected path. A **forced** release is one that a later Generation B needs as its seed. A **cadence** release is cut for size and stabilization. Nothing forces a cadence release, and it can fold into a neighbour (§3 has the floor).

| Release | Lands | Boundary | Forcing dependency | Uncertainty |
| --- | --- | --- | --- | --- |
| **v0.2.68** | **The V2b prerequisites (2026-10-19 handover §3.1, §4.2):** intern or `Rc`-share `module_path` and `input_string` in `Environment`; share envs at the adopt sites; share `TypeValue` label/type lists; redesign the read-by-clone mut-global caches (`synthetic_token`, `_stable_type_id_owner_memo`) so a read does not clone; the two explicit-copy tool guards (temporary-as-move, and a hot-path guard that lists sites instead of cloning them: `--hot-path <path>`, an explicit flag with no built-in default; the regeneration passes `--hot-path src/evaluator`, §5 decision 7). **Then the B1 regeneration** as a listing-heavy sweep with a clean-tree binary. **B2:** the tests, scripts and `markdown_yo` sweep, with a `markdown_yo` companion release. **B3:** the std hand edits. **Independent pieces:** the macro plan's B3 (collection literals become `from(Array(...))` constructors) and B4 (`unsafe.drop` becomes `___drop`); decision 43's N0 (the negative corpus and the reference checker); the 48 `impl(X, Acyclic())` declarations on the compiler's tree-shaped containers, then #1486 (both deferred here, §5 decision 10); `VcTerm` takes `Rc` children; V1's last leftover, `arc` gaining the `alloc` parameter. | Cadence | None. Every item is a std/src-only edit that the v0.2.66 seed compiles, or a tree-compiler-only change. | **High.** The prerequisites and the regeneration must recover the measured 80x / 45 GB regression. The b1diag verdict is that tool fixes alone do not recover it, so if the sharing work recovers too little, B1 slips one release and everything below it slips with it. The `arc` `alloc` parameter may need codegen to place an `Arc` cell through an allocator. If it does, it becomes a Generation A with one release before std uses it, which is off the critical path. |
| **v0.2.69** | **B4:** the src hand edits, one PR per directory (`evaluator/`, `codegen/`, the rest). **B5:** the collection globals become unmarked `RefCell` globals (`with`/`with_mut` only; B5 does not wait for B0's `get()`/`get_mut()`, §5 decision 3). **B6:** decision 20's accessors, the caller-attributed E0901, and `yo fix --migrate cloned-accessors` over std, src and tests. **B7:** the read walk `for(&xs, …)`, consuming `into_iter`, `iter()` under `AllowUnsafe`, and the entry `with` shape. **The B8 flip probe (N4)** runs on develop until it is clean under the SEED binary, and every compiler fix it finds lands here. | Cadence; it becomes forced if the probe finds a seed bug | B4 needs B1. B6 needs B1. B7 needs B6. The flip itself needs B1–B7. | **High.** CI's stage 1 is the seed compiling the flipped std. If the probe finds that the v0.2.68 seed miscompiles a value `String`/`ArrayList`, the fix must ship in a release before B8 can merge. Precedents: `Pattern` needed #1438 in the seed, and `IterPeekable` needed #1437. B7's `for(&xs, …)` rewrite lives in `src/expr.yo`. If src or std uses a form the seed's rewrite does not produce, B7 also needs a release before its use. |
| **v0.2.70** | **B8:** the flip of `ArrayList` and `String`; the S1 `issues/a-write-through-a-string-copy-is-lost-when-the-string-was-empty.md` moves to `fixed/`; lower the allocation ratchet. **B9–B11:** `HashMap`/`HashSet`, then `Deque`/`BTreeMap`/`OrderedMap`/`PriorityQueue`, then `LinkedList`/`StringBuilder`/`HeaderMap`, one probe per PR. **Macro plan Part A:** delete `Iso`, `^v`, `Var.*` and `Isolation`, after B8–B11 and before B12. **V3 std half, the cell-free resources** (plan lines 5096–5136, §5 decision 4): the `ref(...)` resources become move-only value structs whose state is a `Box` — `File`, `TempDir`, `TempFile`, `Watcher`, the sockets (`TcpStream`, `TcpListener`, `UdpSocket`, `UnixStream`, `UnixListener`), `TlsStream`, `HttpClient`, `Child*`, `Thread`. The `atomic(...)` primitives are NOT in this step: they ride V5 Generation A (v0.2.72). | Cadence | Part A needs the collections to be `Send` by move (B8–B11). Its replacement probe fails before B8. | **Medium–high.** Each flip is std-only ("needs no newer seed than B5 did"). Each still runs the seed as stage 1, so a second seed-codegen fix is possible for `HashMap`'s probe/move paths. `LinkedList` and `StringBuilder` need representation decisions (the plan's open question 5 and B11). Part A touches the dup/drop optimizer's family (A5), so the emit-diff gate and the canary are required. |
| **v0.2.71** | **B12:** `Dyn` Generation A (a `clone` vtable slot, and E0901 on a live-source `Dyn` copy outside std/src). **Allocator interface v2, Generation A:** the aligned `alloc`/`realloc`, a sized `free`, and the new prefix layout behind a switch. **The `__yo_cell`/`__yo_atomic_cell` primitive, Generation A:** a named PR of its own in this cut, compiler only, with no std use (plan §3.5; §5 decision 5). **V2c:** decision 17 as ONE PR (the rule, `yo fix --migrate rc-clone` and the sweep), after Part A; not a release boundary (§5 decision 1). **Decision 46 step 3:** the collector predicate narrows to cells that reach a `RefCell`/`Mutex`/`RwLock`, after Part A. | **FORCED #1** | B13 needs a seed with B12. Allocator v2's std half needs a seed that lowers the new layout. V5's std half needs a seed that lowers `__yo_cell`, and grep finds no `__yo_cell` anywhere in src or std today. | **Medium.** The vtable layout is a contract between the seed's codegen and the tree, so B13 can surface one more seed-gated fix. `__yo_cell` exists only as §3.5 prose: if its named PR misses this cut, V5 Generation A cannot land at v0.2.72 and V5 gains a boundary of its own (+1). Allocator v2 is off the critical path, so if it misses this cut its Generation B rides any later forced release. V2c stays one PR, but the plan's "63 sites in src" predates #1329: `TypeValue` is `Rc(TypeValueNode)` now, so the sweep covers every non-last-use `TypeValue` handle copy in src, which could be thousands of sites. `Rc.clone` is a count bump that every seed accepts, but the size of that sweep limits what else fits in v0.2.71. |
| **v0.2.72** | **On the v0.2.71 seed:** B13 (`Dyn` Generation B); allocator v2 Generation B (std moves); B14 (the verifier drops its list-alias model, decision 27's elision and lint, and a re-timing). **Decision 47 locals Generation B** (§5 decision 2): `yo fix --migrate mut-bindings` over src, std, docs (both languages) and `markdown_yo`, then drop `is_global_mut_rule_exempt` for locals. **V4:** `AstExpr` takes `Rc(Self)` children (measured). **Decision 43 step 1:** `TypeValue.Reference(T, mutable, origin)` plus the `Origin` kind, with behavioral identity, an emit-diff with no C change, and origins kept out of `type_key`, the memos and every specialization key. **Function-item types** after step 1. They close `issues/arc-of-a-named-function-value-fails-its-send-bound.md` and `issues/2026-10-17-a-declared-send-binding-of-a-named-function-is-rejected.md`, and they are off the critical path. **V5 Generation A targets this release** (§5 decision 6), serialized AFTER decision 43 step 1 merges: the ~60 contexts become `Rc(struct(...))`, the ~135 result records become structs, the wrappers move onto `__yo_cell`, every `atomic(...)` std type moves onto `__yo_atomic_cell` (`Mutex`, `RawMutex`, `RwLock`, `Cond`, `Barrier`, `Semaphore`, `WaitGroup`, `Once`, `OnceCell`, `ThreadPool`, the `std/sync` `Channel`/`Sender`/`Receiver`, the `Atomic*` types) — V3's atomic half, rewritten once (§5 decision 4) — ~150 test declarations migrate, and the parser warns. | Cadence | Decision 47 locals Generation B comes after B8–B11, because the 5,773 handle-write sites only count once the collections are values. It comes before decision 43 step 2, whose `&mut` rules assume `mut`. Decision 43 follows V2b. V5 Generation A needs `__yo_cell` in the seed (v0.2.71) and waits for step 1 to merge, so the two largest refactors never share a review window. | **High for step 1.** It is "the largest refactor in the plan" and ships alone. An emit-diff that is not empty means another round. The decision 47 sweep is about 9,547 src bindings, so expect at least one fix to the migration itself. If step 1 merges late in the window, V5 Generation A slips to v0.2.73, its ceiling. |
| **v0.2.73** | **Decision 43 step 2 (N1, Generation A):** `generic(p : Origin)`, `&(T, p)`, elision, the O3 rules, `Escapable` (O10), the handle-origin rule (O9), `.*` as an error together with `yo fix --migrate deref`, `impl(&T, …)` and `FnMut`. The deferred doors land with it: `Rc.get_mut`, `RefCell.get()`/`get_mut()` with the binding ban (B0's projections), and the `ctl`-as-origin-carrying decision. **Step 3 (N2):** first-class storage, E0909 becomes the no-origin rule, and declared unions with the `yo fix` widening. **Macro plan B1 and B2:** the `for`/`for_await` desugars, after step 3 settles the borrowed-`for` protocol. **V4:** `EvalValue`. **V5 Generation A only if it slipped from v0.2.72:** this release is its hard ceiling (§5 decision 6). | **FORCED #2** (this is the macro plan's B5) | Step 4 needs a seed carrying steps 2 and 3. Part C needs a desugar-bearing release as its seed. V5 Generation B needs a seed carrying a std without `ref`. | **High.** Origin rules swallowed inside closures and macro expansions are a known failure mode, which is why N0 keeps one corpus row per lowering. Macro B1's E0911 token placement and the verifier's desugar-site marker each need a golden re-record. Steps 2 and 3 in one window is the plan's heaviest stretch, and it is the likeliest place to split into two releases (+1); V5 Generation A is planned out of this window, and joins it only on a slip. |
| **v0.2.74** | **On the v0.2.73 seed:** decision 43 step 4 (N3) — `iter`, `slice` and `entry`; the borrowed `for` by `impl(&C, IntoIterator)`, with `BorrowedWalk` deleted; the `FnMut` slots; `Future(T, p)` replaces A2's registry; and `--migrate deref` over std and src. **Macro plan Part C:** E0010, the machinery deleted, the lowering channel renamed. **V5 Generation B:** the parser drops `ref`/`atomic`, the 527 `is_reference_semantics`/`is_atomic_rc` sites are reread, and the docs and skills follow. The effect records derive `Copy` (the `ctl` rule in the seed). Then the K7 docs sweep and the K4 skills removal. **This is the last release that ships every `--migrate` mode.** | **FORCED #3** | The six README example projects must build and pass their own tests on a published release that ships every migration, with `.yo-version` pinned there, before the migrations can go. | **Medium–high.** Each of the three Generation B halves can surface one seed-gated fix. A migration bug found while migrating the README projects means a fixed migration has to ship in another release before the retirement (+1). |
| **v0.2.75** | **Retire the `yo fix` migrations** (plan "After V5"). This removes today's modes from `src/main.yo` (`markers`, `borrow-spelling`, `params`, `addr-of`, `modes`, `match-scrutinee`, `dyn-spelling`, `drop-trait`, `rc-pattern`, `mutable-globals`, `mut-bindings`, `explicit-copy`) plus the ones the campaign adds (`cloned-accessors`, `rc-clone`, `deref`, decision 43's widening). The per-diagnostic repairs stay. ERROR_DIAGNOSTICS gains the table of last releases. **VBD is complete.** | End of campaign | It needs v0.2.74 published and the README projects migrated. | **Low** once v0.2.74 holds. |

## 2. The forced boundaries, and why

1. **B12 → B13 (`Dyn`), at v0.2.71.**
   - B0 and B12 are the only seed-gated V2b PRs (plan §6 V2, "PR sequence" item 1).
   - The cut also carries the Generation A halves of allocator v2 and of the `__yo_cell` primitive, so each costs no boundary of its own.
2. **Decision 43 steps 2+3 → step 4, at v0.2.73.**
   - It is the same cut as the macro plan's B5. Part C needs a desugar-bearing seed.
   - V5 Generation A lands by it (v0.2.72, ceiling v0.2.73), so V5 Generation B shares the next cut.
3. **The last release that carries every migration, at v0.2.74.**
   - It carries decision 43 step 4, Part C and V5 Generation B.
   - It is the gate the six README projects migrate on.
4. **The retirement release, at v0.2.75.** It is where the campaign ends rather than a seed boundary.

Two items are **not** boundaries, although the 2026-10-17 handover §4.4 lists them:

- **V2c.** The plan, lines 7240–7243, says: "One PR, not two generations. `Rc.clone(w)` has been in every seed since #1241 … The seed builds a swept `src/` unchanged." Decided 2026-10-20 (§5 decision 1). Please do not restore it to the count.
- **V5 as a release of its own.** V5 IS a Generation A/B boundary, which is why the v0.2.73 row lists it among its forcing dependencies. It adds no release, because it shares decision 43's step-3→4 cut: V5 Generation A targets v0.2.72 and v0.2.73 is its hard ceiling (§5 decision 6).

The 10-17 list also lacked two boundaries that this schedule absorbs into the B12 cut: allocator v2 (plan "After V2b … Seed gate") and the `__yo_cell` primitive.

## 3. Count

- **Expected: 8 releases, v0.2.68 to v0.2.75.**
  - Three are forced seed boundaries, plus the retirement release.
  - Four are cadence releases that hold the V2b sweep and flip volume. Each of them can also absorb a seed-gated fix.
- **Range: 6 to 12.**
  - **Theoretical floor: 4 cuts.** They are the B12 cut, the decision 43 step 2/3 cut, the last-migrations cut and retirement. This needs everything from the prerequisites through B12 in one release, which no measured velocity supports.
  - **Realistic floor: 6.** v0.2.68 and v0.2.69 merge, and v0.2.70 folds into v0.2.71.
  - **Pessimistic: 12.** A seed fix for the B8 probe is already absorbed by v0.2.69. Each of these adds one release:
    - B13 surfaces a vtable-contract fix;
    - decision 43 step 1, or steps 2+3, splits;
    - step 4 or V5 Generation B surfaces a seed-gated fix;
    - a README project finds a migration bug.
- **Any Generation B often surfaces one more seed-gated fix.** This cycle's precedents are `Pattern` (#1438) and `IterPeekable` (#1437/#1466). That is the main reason the expected count sits above the floor.

## 4. Every remaining step, by release

| Step | Spec | Release | Seed-gated? |
| --- | --- | --- | --- |
| §3.1 prerequisites: intern/share `module_path` + `input_string`, shared envs, `TypeValue` lists, non-cloning memo caches | 2026-10-19 handover §3.1, §4.2; plan V2b B1 "Path to a landable B1" | v0.2.68 | no |
| Explicit-copy tool guards (temporary-as-move, `--hot-path` with no default) | same; §5 decision 7 | v0.2.68 | no |
| V2b B1 regeneration (listing-heavy) | plan V2b B1 | v0.2.68 (may slip to v0.2.69) | no |
| V2b B2 (tests, scripts, `markdown_yo`) | plan V2b B2 | v0.2.68 | no (companion `markdown_yo` release) |
| V2b B3 std hand edits | plan V2b B3 | v0.2.68–v0.2.69 | no |
| V2b B4 src hand edits by directory | plan V2b B4 | v0.2.69 | no (`RefCell` is in every seed since v0.2.64) |
| V2b B5 `RefCell` globals (`with`/`with_mut` only) | plan V2b B5, open question 1; §5 decision 3 | v0.2.69 | no |
| V2b B6 accessors + `cloned-accessors` | plan V2b B6 | v0.2.69 | no |
| V2b B7 iteration and entries (the rest after #1429) | plan V2b B7; closes `issues/collection-iterators-have-no-sound-post-v2b-shape.md` | v0.2.69 | possibly (the `for(&xs, …)` rewrite) |
| V2b B8 flip `ArrayList` + `String` | plan V2b B8 | v0.2.70 | std-only; seed is stage 1 |
| V2b B9–B11 other collections | plan V2b B9–B11 | v0.2.70 | std-only |
| Macro plan Part A (`Iso` removal) | MACRO_AND_ISO_REMOVAL Part A | v0.2.70 | no |
| V3 std half, cell-free resources (`File`, `TempDir`, `TempFile`, `Watcher`, sockets, `TlsStream`, `HttpClient`, `Child*`, `Thread` → `Box`-celled structs) | plan lines 5096–5136; §5 decision 4 | v0.2.70 | no |
| V3 std half, atomic-cell primitives (every `atomic(...)` std type: `Mutex`, `RawMutex`, `RwLock`, `Cond`, `Barrier`, `Semaphore`, `WaitGroup`, `Once`, `OnceCell`, `ThreadPool`, the `std/sync` channel, `Atomic*`) | plan lines 5096–5136; §5 decision 4 | inside V5 Generation A (v0.2.72) | needs `__yo_atomic_cell` in the seed (v0.2.71) |
| V2b B12 `Dyn` Generation A | plan V2b B12 | v0.2.71 | is the Generation A |
| Allocator interface v2 Generation A | plan "After V2b: the allocator interface, version 2" | v0.2.71 | is the Generation A |
| `__yo_cell` / `__yo_atomic_cell` primitive (a named compiler-only PR) | plan §3.5, V5; §5 decision 5 | v0.2.71 | is the Generation A |
| V2c (decision 17), one PR | plan V2c; §5 decision 1 | v0.2.71 | no |
| Decision 46 step 3 (collector predicate) | plan "Decision 46" step 3 | v0.2.71 | no |
| V2b B13 `Dyn` Generation B | plan V2b B13 | v0.2.72 | needs v0.2.71 |
| Allocator v2 Generation B | same | v0.2.72 | needs v0.2.71 |
| V2b B14 follow-ups (verifier alias model, decision 27, re-time) | plan V2b B14 | v0.2.72 | no |
| Decision 47 locals Generation B | plan "Decision 47" step 2; §5 decision 2 | v0.2.72 | no (v0.2.65 carries #1440) |
| V4 `AstExpr` | plan V4 | v0.2.72 | no (watch for a `Pattern`-style seed bug) |
| Decision 43 step 1 (`TypeValue.Reference`, `Origin`) | plan "Decision 43" step 1 | v0.2.72 | no |
| Function-item types | 2026-10-17 handover §4 step 16 | v0.2.72–v0.2.73 | no |
| Decision 43 N0 (corpus + reference checker) | REFERENCES_AND_ORIGINS §8 | v0.2.68 (any time before step 2) | no |
| Decision 43 step 2 (N1) + deferred doors (`Rc.get_mut`, `RefCell.get`/`get_mut`) + `ctl` decision | plan "Decision 43" step 2; "Decision 46" as built; §5 decision 3 | v0.2.73 | is the Generation A |
| Decision 43 step 3 (N2) | plan step 3 | v0.2.73 | is the Generation A |
| Macro plan B1, B2 (`for`/`for_await` desugars) | MACRO_AND_ISO_REMOVAL Part B | v0.2.73 | is the Generation A (macros retained) |
| V4 `EvalValue` | plan V4 | v0.2.73 | no |
| V5 Generation A (with V3's atomic half) | plan V5; §5 decisions 4, 6 | v0.2.72, after decision 43 step 1 merges (ceiling v0.2.73) | needs `__yo_cell` in the seed (v0.2.71) |
| Decision 43 step 4 (N3) | plan step 4 | v0.2.74 | needs v0.2.73 |
| Macro plan Part C | MACRO_AND_ISO_REMOVAL Part C | v0.2.74 | needs v0.2.73 |
| V5 Generation B | plan V5 | v0.2.74 | needs v0.2.73 |
| Effect records derive `Copy` | plan "Decision 43", open `ctl` point | v0.2.74 | needs the rule in the seed |
| K7 docs sweep, K4 skills removal | `plans/AGENT_KNOWLEDGE_CONSOLIDATION.md` | v0.2.74 | no |
| Retire the `yo fix` migrations | plan "After V5" | v0.2.75 | needs v0.2.74 published and the README projects migrated |
| Macro plan B3, B4 | MACRO_AND_ISO_REMOVAL Part B; B3 deletes `from_array` (§5 decision 8) | v0.2.68 (any time) | no; B3 runs the escape-hatch checklist |
| `Acyclic` declarations, then #1486 | #1486's "Deferred"; §5 decision 10 | v0.2.68 | no |
| `VcTerm` `Rc` children | decision 21 as amended 2026-10-18 | v0.2.68 | no; after V2c its copies need `.clone()` |
| A4 std half + the capture-struct S2 | 2026-10-19 handover §3.2; `issues/2026-10-16-a-generic-io-async-body-shares-one-capture-struct-across-futures-of-one-generic-producer.md` | v0.2.67 (in flight) or v0.2.68 | no |
| V1 leftover: `arc` takes `alloc` | plan V1 "Remaining, Generation A" | v0.2.68 | possibly (see the v0.2.68 row) |

## 5. Decided 2026-10-20

The maintainer delegated these picks ("pick the best solution that fits Yo"), and they are final. Each entry names the pick and its reason. None of them adds or removes a cut, so the §3 count is unchanged: 8 releases expected, v0.2.68 to v0.2.75.

1. **V2c is ONE PR, and not a release boundary.**
   - The plan, lines 7240–7243, beats the 2026-10-17 handover §4.3 step 13 and §4.4.
   - Reason: `Rc.clone(w)` has been in every seed since #1241, so the rule, `yo fix --migrate rc-clone` and the sweep land together, and the seed builds a swept `src/` unchanged. A second generation would buy nothing.
2. **Decision 47 locals Generation B lands at v0.2.72**, after V2b B8–B11 and before decision 43 step 2.
   - The plan's decision 47 step 2 ("after V2b Generation B and before decision 43", plan line 7869) beats the 2026-10-17 handover §4.2 step 7, which placed it before V2b.
   - Reason: step 2's `&mut` rules assume `mut`, so the markers must exist first. Landing it before the flips is legal (the seed has carried Generation A since v0.2.65), but it would need a second pass over the 5,773 handle-write sites that only become value writes once the collections are values.
3. **B0's `RefCell.get()`/`get_mut()` projections wait for decision 43 step 2**, together with `Rc.get_mut`. B5 does not wait for them.
   - Decision 46's as-built note (2026-10-16, #1415) beats the B0 brief's "before the next release cut".
   - Reason: the expression-scoped mark and the binding ban the projections need do not exist until step 2. B5's decided spelling is `with`/`with_mut` only (plan lines 7041–7045, decided 2026-10-17), so B5 has nothing to wait for. The B5 detail block's "Needs: B0 in `SEED_VERSION` (the projections)" and its `get_mut()` example are superseded by that verdict.
4. **The V3 std half splits in two.**
   - **The cell-free resources are their own step at v0.2.70:** `File`, `TempDir`, `TempFile`, `Watcher`, the sockets, `TlsStream`, `HttpClient`, `Child*` and `Thread` become move-only value structs whose state is a `Box`. `Arena` stays as the plan's §3.11 exception.
   - **The concurrency primitives that need an atomic cell ride V5 Generation A** onto `__yo_atomic_cell`.
   - Reason: a cell-free resource needs only the unique `Box`, which V1 step 2 already landed, so it can move right after the flips. An `atomic(...)` primitive's state is shared and counted. Moving it now would mean an interim spelling that V5 then rewrites. Moving it once, onto the primitive V5 introduces, avoids that second rewrite. Both halves remove the same `ref`/`atomic` spellings, so the split loses no coverage.
   - The decision names `Barrier`, `Cond`, `Once`, `Semaphore`, `WaitGroup` and `ThreadPool`. Applying its criterion against std at `fc15a6092`, every other `atomic(...)` type joins that half as well: `Mutex` (`std/sync/mutex.yo:85`), `RawMutex` (:114), `RwLock` (`std/sync/rwlock.yo:73`), `OnceCell` (`std/sync/once.yo:152`), the `std/sync` `Channel`/`Sender`/`Receiver` (`std/sync/channel.yo:150`, :400, :411) and the `Atomic*` types (`std/sync/atomic.yo`). `File` (`std/fs/file.yo:74`) and `Thread` (`std/thread.yo:80`) are `ref(...)`, and so are the other cell-free resources.
5. **The `__yo_cell`/`__yo_atomic_cell` primitive is a named compiler-only Generation A PR in the v0.2.71 (B12) cut.**
   - Reason: no `__yo_cell` exists in src or std today, and V5 Generation A needs a seed that lowers it. Naming the PR puts it on the cut's checklist, so it cannot slip silently. It costs no boundary, because it shares B12's forced cut. If it still misses that cut, V5 gains a boundary of its own (+1, the v0.2.71 row).
6. **V5 Generation A targets v0.2.72, serialized AFTER decision 43 step 1 merges. v0.2.73 is the hard ceiling.**
   - The 2026-10-17 handover ordered decision 43 before V5, but no plan line makes that a hard dependency. V5 needs V2c and Part A first, and both are done by v0.2.71.
   - Reason for the serialization: step 1 is "the largest refactor in the plan", and its acceptance is an emit-diff with no C change. A V5 diff in the same window would make that diff unreadable. Reason for the ceiling: after v0.2.73, V5 Generation B no longer shares decision 43's step-3→4 cut and needs a release of its own (+1).
7. **The explicit-copy guard `--hot-path` has NO built-in default.**
   - Reason: the maintainer's principle "whenever we could be explicit, do explicit". The tool cannot know which directories are hot. The measurement that named `src/evaluator/` (1,268 of the 3,271 `src/` insertions) belongs to the plan, not the tool. So the B1 recipe spells `yo fix ./src --migrate explicit-copy --hot-path src/evaluator`.
   - Where it is recorded: the plan text and the flag live on `feat/explicit-copy-guards` (its `plans/VALUES_BY_DEFAULT.md` B1 hunk already says "an explicit flag, not a default") and land with that branch. Develop's plan does not name the flag yet, so this branch does not copy the hunk. The v0.2.68 row above names the flag.
8. **The macro plan's B3 DELETES `ArrayList.from_array`**, and does not keep a `Clone`-bounded copy.
   - Reason: `from_array(arr : &Array(T, N))` borrows the array and copies every element. That is exactly the implicit copy VBD removes. `Array(T, N)` already implements `Clone` element-wise (`std/prelude.yo:7315`, `where(T <: Clone)`), so a caller that keeps the array writes `ArrayList(T).from(arr.clone())`, and one that does not writes `ArrayList(T).from(arr)`, which moves. Recorded in `plans/backlog/MACRO_AND_ISO_REMOVAL.md` B3, with its caller count.
9. *(Decision 9 is the `Acyclic` stack's own brief. It is not part of this schedule.)*
10. **#1486 and the 48 `Acyclic` declarations land at v0.2.68.** They were deferred and are not v0.2.67 candidates. §0, the v0.2.68 row and §4 say so.
    - The copy-guards branch (`feat/explicit-copy-guards`) already has its issue doc in `issues/fixed/` with its gates unrun, and it edits the 2026-10-19 handover §4.2. Expect a conflict with the handover fold. Merge that branch only after its build runs.

### Records kept from the earlier §5

These are not maintainer decisions. They are corrections of the sources that this draft verified:

- **V1's "exclusivity assert moves to the write-through-`Rc` site"** is superseded. Decision 46 Generation B (#1421) makes a write through a plain `Rc` E0919 statically, and `RefCell` carries the dynamic check. The other V1 leftover, the auto-deref "payload has no field … either" message, has landed (`tests/deref_auto.test.yo:133`). Only `arc`'s `alloc` parameter remains.
- **`VcTerm`.** "Any time" predates V2c. After V2c a value enum with `Rc` children is explicit-copy, so `vc.yo`'s 49 `HashMap.get` sites need B6's accessors or `.clone()`. Landing it at v0.2.68 is still fine; it just pays a small V2c sweep later.

## 6. Verified against develop `fc15a6092`

These steps are landed, so they are not scheduled:

- Decision 47 globals Generation B (#1414) and locals Generation A (#1440, in v0.2.65).
- Decision 46 Generations A and B (#1415, #1421).
- B0's cell (#1415).
- B1's partial: the migration fixes and the E0916 exemption (#1478).
- B7's Generation A, the borrowed-`for` cursor (#1429).
- V4's `TypeValue` handle (#1329), `Z3Sexpr` (#1435) and `Pattern` (#1439).
- V1 step 2, Generations A and B (#1354).
- Decision 45, `Drop` (#1378).
- The async A1, A2, A3, A5 and A6 work (#1323, #1326, #1349, #1379, #1412).
- A4's compiler half (#1432).
- The await-through-a-generic-`Impl(Future)` `void*` S1 (#1458).
- The recursive-enum S2, by declaration identity (#1501).
- The closure capture struct keyed by signature (#1503).

`plans/backlog/SEED_VERSION_AUTOMATION.md` (audit #1499) has no open VBD seed gate besides decision 36's leftovers, which V2b carries. Its only other open entry is `__yo_build_doc`'s nine-argument builtin, which is not VBD: its Generation A was never built, so it needs a Generation A, one release, then the std edit. It can ride any forced cut.

## 7. Out of the campaign

The maintainer deferred these until after VBD. They follow v0.2.75 and are not counted above:

- evaluator performance steps 1–2;
- the issue-date rename;
- PARALLEL_COMPILATION P4 step 2;
- sizing `YO_TEST_FORK`.
