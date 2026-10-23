# VALUES_BY_DEFAULT release schedule (2026-10-20)

> **Status: LIVING schedule** (adopted with the post-v0.2.67 handover, `plans/handover/VBD_HANDOVER_2026-10-20.md`;
> update a row when its release ships). `plans/VALUES_BY_DEFAULT.md` §6 stays authoritative. Where the plan and a handover
> disagreed, and wherever the draft left a question open, the maintainer delegated the pick
> (2026-10-20); §5 "Decided 2026-10-20" records each pick and its reason, and the tables below
> follow it. Checked against develop `fc15a6092` (2026-10-20), with SEED_VERSION at v0.2.66.
> Plan line numbers cited here are develop's at `fc15a6092`, before this branch's dated notes in
> `plans/VALUES_BY_DEFAULT.md` (which shift them by 3 to 21 lines).
> **Revised 2026-10-21 (maintainer):** the B1 regeneration, and with it B3, moves to v0.2.69, and the macro
> plan's Part A (`Iso` removal) moves forward to v0.2.68 (§5a decisions 11 and 12). The count in §3 is unchanged.
> **Revised 2026-10-22 (post-v0.2.68):** v0.2.68 shipped; its row records what landed. The `markdown_yo` half of
> B2 and `rc`'s `alloc` parameter move to v0.2.69, which also gains decision 48's W1 and W2, `drop_in_place`
> (§5a decision 13), the explicit-copy migration fixes and the async aliased-argument share S1. Decision 48
> (`plans/backlog/WEAK_AND_UNCOLLECTED_RC.md`, W1–W6) is placed from v0.2.69 to v0.2.74 (§5a decision 14), and
> decision 46 step 3 is deleted (W6 supersedes it). §3 still expects 8 releases. The range becomes 7 to 13:
> v0.2.68 shipped on its own, which spends one fold, and W6b is a new risk on v0.2.74.
> **Revised 2026-10-23 (during the v0.2.69 cut; §5c decisions 16–20):** v0.2.69's row records what landed.
> B1's re-run is GO (1.02x user time, 0.998x RSS on `check src/main.yo`). **v0.2.70 becomes a seed release**: it
> carries the compiler fixes the B8 probe and the lookahead (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §3) need in
> stage 1, plus B7a's read walk, Z11, the V3 std half and the v0.2.71 Generation A halves that are gated in time.
> B4, B6, B7 and the B8–B11 flips then run on the v0.2.70 seed and ship in v0.2.71 with the B12 cut. §3 still
> expects 8 releases, but the last fold is spent, so the range becomes 8 to 13.
> **Revised 2026-10-23 (maintainer):** static-argument inference (`plans/backlog/STATIC_ARGUMENT_INFERENCE.md`) is
> placed as riders that add no cut. Its Generation A goes to v0.2.72. Its Generation B goes to v0.2.73: `box`/`rc`/`arc`
> become `Box.new`/`Rc.new`/`Arc.new` through `yo fix --migrate handle-ctors`, with the builtins kept for that
> release so the published mode can type old calls. The builtins are deleted at v0.2.74, and the migration retires
> at v0.2.75.

This schedule maps every VBD step that has not landed to the release where it can land. It follows five rules:

- A Generation B needs a seed that carries its Generation A.
- Independent Generation A pieces may share a release.
- The §3.1 sharing prerequisites (2026-10-19 handover) come before the B1 regeneration.
- #1486 lands after the `Acyclic` declarations.
- V5 Generation A lands after decision 43 step 1 merges, and no later than v0.2.73 (§5, decision 6).

The macro/`Iso` campaign slots in as `plans/backlog/MACRO_AND_ISO_REMOVAL.md` "Schedule" says.

## 0. Baseline: what v0.2.67 carries

v0.2.67 (cut 2026-10-20) carries everything merged since the v0.2.66 tag: #1484, #1485 (the #1476 re-land),
#1487–#1509 (the Generation B halves on the v0.2.66 seed #1490/#1491/#1497/#1498, #1492, the recursive-enum
identity fix #1501, the capture-struct fixes #1503/#1506, #1500/#1502/#1504/#1507, the S1 #1508, and A4's std
half #1509). The ArrayList same-named-binder issue closed through #1504 (its exploration branches are deleted).

Carried into v0.2.68 (none is a release boundary, so §3's count is unchanged):

- #1486, the LinkedList cycles fix (`fix/linkedlist-managed-element-cycles`, draft), stacked under
  `perf/acyclic-compiler-containers` (the `impl(X, Acyclic())` declarations; §5 decision 9 / 10).
- `feat/explicit-copy-guards` (the two tool guards; not yet built).

Both landed in v0.2.68 (#1515, #1516).

## 1. The schedule

The schedule follows an expected path. A **forced** release is one that a later Generation B needs as its seed. A **cadence** release is cut for size and stabilization. Nothing forces a cadence release, and it can fold into a neighbour (§3 has the floor).

| Release | Lands | Boundary | Forcing dependency | Uncertainty |
| --- | --- | --- | --- | --- |
| **v0.2.68** | **Shipped** (cut 2026-10-22: #1511–#1533). **The §3.1 prerequisites:** `module_path` a shared `Rc(String)` with the dead `input_string` deleted (#1526); `Environment.frames` a shared `Rc(ArrayList(Frame))`, with one `env_adopt` helper for the 62 adopt sites (#1531); `TypeValue` label/type lists as `SharedList` handles (#1532); the mut-global memo caches share entries through `Rc` (#1521). **The explicit-copy guards** (#1516): dying temporaries and `--hot-path` sites are listed, not cloned. **B2, Yo half:** `tests/`, the build scripts and five cli fixtures (#1525). **Macro plan:** Part A deletes `Iso`, `^v`, `Var.*` and `Isolation` (#1530); B3, the collection-literal macros become `ArrayList`/`HashMap`/`HashSet.from` (#1527); B4, `unsafe.drop` becomes `___drop` (#1513). **#1493's +3.3 % `check` RSS reclaimed** (#1520). **Decision 43 N0**, the corpus and reference checker, plus the S1 dup/drop share and the S2 `&mut(A, B)` it found (#1528). **The 48 `Acyclic` declarations and #1486** (#1515). **`VcTerm` an `Rc` handle** (#1518). **`arc` takes `alloc`** (#1519). **The ref-enum cycle walk S1** (#1517). **Plans:** decision 48 (#1529), the origins audit (#1522), ZIG_STYLE_ALLOCATORS (#1523), #1514. **Fix-forward:** #1533 re-recorded the two LSP goldens that #1530 left stale, caught by develop's battery. **Moved to v0.2.69:** B2's `markdown_yo` half and its companion release, because 52 of 54 `markdown_yo` files fail E0917 under the tree compiler (assignment to a binding without `mut`; diagnosis in progress); and `rc`'s `alloc` parameter, which was not built. | Cadence (shipped) | None. | **Measured:** the sharing prerequisites cost about 5 % `check` user time. Allocation calls fell 8.4 % with the memo caches (#1521) and rose 3.8 % with #1532. RSS: #1520 took stage 2 from 1,107,640 to about 1,075,700 kB, reclaiming #1493. v0.2.67's notes had blamed the de-sharing PRs; they were corrected to #1493. The allocation ratchet is re-baselined from develop's battery once the sharing branches have all landed. |
| **v0.2.69** | **Being cut 2026-10-23/24.** Landed: the explicit-copy migration fixes (#1537) and their three S1 follow-ups (#1549); W1 `--cycle-collector off` (#1536); W2, `Arc` and std/sync without `Acyclic` (#1534); the async aliased-argument share S1 (#1538); two generic-inference S2s (#1542); `drop_in_place` and the `unsafe` gate on `___drop` (#1543); `markdown_yo` ^0.0.20, B2's `markdown_yo` half (#1544); `rc` takes `alloc` (#1547); E0003 names the canonical grouping (#1541); the per-process code spill, S1 (#1550); **B5**, 377 collection globals become `RefCell` globals (#1551); **B3**, std explicit copies, with eleven getters returning borrows (#1553, an API break); `RefCell.replace`/`replace_with`/`take`/`into_inner` (#1554); the derive-body and loop-exit drop S1s (#1557); `=>>` deleted (#1558); the ratchet re-baseline for B5 (#1555). Plans: #1535, #1539, #1540, #1545, #1546, #1548, #1552, #1556, #1559. **Still landing before the cut:** the `Token.input`/`Token.module_path` `Rc(String)` sharing (`perf/share-token-input`), then **the B1 regeneration**, redone by script on develop. The re-run measured GO: `check src/main.yo` 1.02x user time and 0.998x RSS, `std/rand.yo` 1.03x / 1.014x; 632 insertions, 1,959 listed sites; `plans/VALUES_BY_DEFAULT.md` B1 "As-built, re-run 2026-10-23". Also the compile-time `cond` dup S1s (`fix/compile-time-cond-borrowed-handle-dup`). If B1's final gate fails, the cut ships without it and B1 moves to v0.2.70. **Not here:** B4, B6 and B7 (§5b decision 15, then §5c decision 16). The S1 `Rc(RefCell)` collector issue is not fixed: collector-only bugs are documented, not fixed (decision 48 deletes the collector). | Cadence | B1 needs the token sharing and the tool fixes (both landed or landing). | **Low now.** B1 is measured; the rest has landed. |
| **v0.2.70** | **The seed release for the flips (§5c decision 16).** The compiler fixes the lookahead's §3 lists for stage 1. **C1**, the compile-time `cond` dup S1, lands here only if it misses v0.2.69. **C2**, the raw-view gate on a generic buffer-owning value. **C3**, a struct pattern on a newtype. **C4**, a move in a returning match arm. **C7**, a read-only method iterating a value field. **S1a**, the match-break double drop. **S1b**, keeping an `Rc` auto-deref receiver alive. **B7a:** the read walk `for(&xs, …)` (src/expr.yo rewrite, `BorrowedWalk`/`BorrowedWalkMut` split, `walk_ref`), as a Generation A (lookahead D7). **Z11, decision 48's leak oracle:** `--allocator debug` and `yo test --allocator debug`; W6's precondition 2. **V3 std half, the cell-free resources** (§5 decision 4): `File`, `TempDir`, `TempFile`, `Watcher`, the sockets, `TlsStream`, `HttpClient`, `Child*` and `Thread` become move-only value structs whose state is a `Box`. **Pulled forward from v0.2.71 when gated (lookahead D12):** the `__yo_cell`/`__yo_atomic_cell` primitive (`feat/yo-cell-primitive-gen-a`), B12 and allocator v2 Generation A. The other open S1s merge as they are gated: the verifier call-site frame, `check` passing a failed-transpile closure, deep-nesting teardown, and an unwind through a method call. **Not waited for:** the first B4 and B6 pieces (B4-0a, B6-a) ride along if they are gated. | **FORCED (new)**: B8 needs a seed carrying C2–C7 and B7a | B8 compiles the flipped std with this seed as stage 1. | **Medium.** The pieces are independent. A fix that misses the cut moves B8's need for it to std workarounds (the lookahead lists one per row) or to the next seed. |
| **v0.2.71** | **From v0.2.70 (§5c decision 16), on the v0.2.70 seed:** **B4**, the src hand edits (8 PRs of about 260 sites or fewer; lookahead §4). **B6**, decision 20's accessors, the caller-attributed E0901 and `yo fix --migrate cloned-accessors`. **B7**, the rest after B7a: consuming `into_iter`, `iter()` under `AllowUnsafe`, the entry `with` shape. **Decision 47 locals Generation B, std half only, before B8** (§5c decision 18). **B8**, the flip of `ArrayList` and `String`: the S1 `issues/a-write-through-a-string-copy-is-lost-when-the-string-was-empty.md` moves to `fixed/`, string interpolation appends a `String` part by borrow, the allocation ratchet is lowered, and Part A's replacement probe runs in its gate. **B9–B11**, one probe per PR (lookahead D11). **B12:** `Dyn` Generation A (a `clone` vtable slot, and E0901 on a live-source `Dyn` copy outside std/src). **Allocator interface v2, Generation A:** the aligned `alloc`/`realloc`, a sized `free`, and the new prefix layout behind a switch. **The `__yo_cell`/`__yo_atomic_cell` primitive, Generation A:** a named PR of its own in this cut, compiler only, with no std use (plan §3.5; §5 decision 5). **V2c:** decision 17 as ONE PR (the rule, `yo fix --migrate rc-clone` and the sweep), after Part A; not a release boundary (§5 decision 1). **Decision 48 W3 and W4:** `Weak(T)` (the weak count in decision 46's freed header bits, the dead flag, the two free paths, `traverse_fn` skipping `Weak`), then `ArcWeak(T)`. Both are Generation A, landing after V2c merges so that `Weak`'s own copy is `.clone()` from its first commit; std uses them on the v0.2.71 seed. (Decision 46 step 3, the predicate narrowing, is deleted: W6 deletes the predicate instead of narrowing it.) | **FORCED #1** | B13 needs a seed with B12. Allocator v2's std half needs a seed that lowers the new layout. V5's std half needs a seed that lowers `__yo_cell`, and grep finds no `__yo_cell` anywhere in src or std today. W5 and W6a need a seed carrying W3/W4. | **Medium.** The vtable layout is a contract between the seed's codegen and the tree, so B13 can surface one more seed-gated fix. `__yo_cell` exists only as §3.5 prose: if its named PR misses this cut, V5 Generation A cannot land at v0.2.72 and V5 gains a boundary of its own (+1). Allocator v2 is off the critical path, so if it misses this cut its Generation B rides any later forced release. V2c stays one PR, but the plan's "63 sites in src" predates #1329: `TypeValue` is `Rc(TypeValueNode)` now, so the sweep covers every non-last-use `TypeValue` handle copy in src, which could be thousands of sites. `Rc.clone` is a count bump that every seed accepts, but the size of that sweep limits what else fits in v0.2.71. W3 changes the cell header and allocator v2 changes the owner prefix, both in this window. Land them one after the other so that each layout diff is read on its own. **This row is now the heaviest window (§5c decision 16).** If it runs long, V2c, W3 and W4 slip to v0.2.72, and W5/W6a slip with them, rather than holding the B12 cut. |
| **v0.2.72** | **On the v0.2.71 seed:** B13 (`Dyn` Generation B); allocator v2 Generation B (std moves); B14 (the verifier drops its list-alias model, decision 27's elision and lint, and a re-timing). **Decision 47 locals Generation B** (§5 decision 2): `yo fix --migrate mut-bindings` over src, std, docs (both languages) and `markdown_yo`, then drop `is_global_mut_rule_exempt` for locals. **V4:** `AstExpr` takes `Rc(Self)` children (measured). **Decision 43 step 1:** `TypeValue.Reference(T, mutable, origin)` plus the `Origin` kind, with behavioral identity, an emit-diff with no C change, and origins kept out of `type_key`, the memos and every specialization key. **Function-item types** after step 1. They close `issues/arc-of-a-named-function-value-fails-its-send-bound.md` and `issues/2026-10-17-a-declared-send-binding-of-a-named-function-is-rejected.md`, and they are off the critical path. **V5 Generation A targets this release** (§5 decision 6), serialized AFTER decision 43 step 1 merges: the ~60 contexts become `Rc(struct(...))`, the ~135 result records become structs, the wrappers move onto `__yo_cell`, every `atomic(...)` std type moves onto `__yo_atomic_cell` (`Mutex`, `RawMutex`, `RwLock`, `Cond`, `Barrier`, `Semaphore`, `WaitGroup`, `Once`, `OnceCell`, `ThreadPool`, the `std/sync` `Channel`/`Sender`/`Receiver`, the `Atomic*` types) — V3's atomic half, rewritten once (§5 decision 4) — ~150 test declarations migrate, and the parser warns. **Decision 48 W5:** the derived `Acyclic` walk skips `Weak`/`ArcWeak` edges and answers a cycle through a cell inductively (the S2 derivation fix); the declared exemption loses its pragma; `yo fix` drops std's `SAFETY:` comments. **W6a:** `--cycle-collector off` becomes the default for one release, with the tracked-type count over std and `src/` and the oracle's leak report over the corpus recorded in the plan. W6a may land at v0.2.73 instead. **Static-argument inference, Generation A** (`plans/backlog/STATIC_ARGUMENT_INFERENCE.md` A1–A3; off the critical path). A1 is the rule: a static method called through an unapplied constructor infers the constructor's arguments from every argument whose declared parameter type mentions them, and a method with `self` keeps decision 32. A2 adds `Rc`/`Box`/`Arc` `.new`, with `alloc`, and `rc`/`box`/`arc` forward to them. A3 makes `dyn` synthesize `Rc(T).new` instead of naming `rc`. A2 and A3 change the emitted C, so they merge first in the window, before decision 43 step 1 takes its no-C-change baseline (and so before V5 Generation A). | Cadence | Decision 47 locals Generation B comes after B8–B11, because the 5,773 handle-write sites only count once the collections are values. It comes before decision 43 step 2, whose `&mut` rules assume `mut`. Decision 43 follows V2b. V5 Generation A needs `__yo_cell` in the seed (v0.2.71) and waits for step 1 to merge, so the two largest refactors never share a review window. W5 and W6a need the v0.2.71 seed (W3/W4), and W6a also needs Z11 (v0.2.70). | **High for step 1.** It is "the largest refactor in the plan" and ships alone. An emit-diff that is not empty means another round. The decision 47 sweep is about 9,547 src bindings, so expect at least one fix to the migration itself. If step 1 merges late in the window, V5 Generation A slips to v0.2.73, its ceiling. W6a is the measurement that W6b needs one published release of. If W6a slips past v0.2.73, W6b slips past v0.2.74. If any of static-argument inference A1–A3 misses this cut, its Generation B moves to v0.2.74: src may spell `Rc.new(x)` only on a seed carrying A1, and the tree may delete `rc` only once the seed's `dyn` stops naming it (A3). |
| **v0.2.73** | **Decision 43 step 2 (N1, Generation A):** `generic(p : Origin)`, `&(T, p)`, elision, the O3 rules, `Escapable` (O10), the handle-origin rule (O9), `.*` as an error together with `yo fix --migrate deref`, `impl(&T, …)` and `FnMut`. The deferred doors land with it: `Rc.get_mut`, `RefCell.get()`/`get_mut()` with the binding ban (B0's projections), and the `ctl`-as-origin-carrying decision. **Step 3 (N2):** first-class storage, E0909 becomes the no-origin rule, and declared unions with the `yo fix` widening. **Macro plan B1 and B2:** the `for`/`for_await` desugars, after step 3 settles the borrowed-`for` protocol. **V4:** `EvalValue`. **V5 Generation A only if it slipped from v0.2.72:** this release is its hard ceiling (§5 decision 6). **W6a, if it slipped from v0.2.72.** Until W6b, steps 2 and 3 keep O9's `Escapable` bound on `Rc`/`Arc` payloads; W6b amends it. **Rider, adding no cut: static-argument inference Generation B** on the v0.2.72 seed, as the first PR of the window: `yo fix --migrate handle-ctors` rewrites `rc(`/`box(`/`arc(` to `Rc.new(`/`Box.new(`/`Arc.new(` (about 2,200 lines over src, std, tests, docs and skills, measured 2026-10-23, plus V4's `AstExpr` constructions), and a scripted pass edits the Markdown, comments and string literals the mode cannot reach. The prelude builtins stay in this release so that the published mode can still resolve and type old calls; the README projects are migrated with v0.2.73. | **FORCED #2** (this is the macro plan's B5) | Step 4 needs a seed carrying steps 2 and 3. Part C needs a desugar-bearing release as its seed. V5 Generation B needs a seed carrying a std without `ref`. | **High.** Origin rules swallowed inside closures and macro expansions are a known failure mode, which is why N0 keeps one corpus row per lowering. Macro B1's E0911 token placement and the verifier's desugar-site marker each need a golden re-record. Steps 2 and 3 in one window is the plan's heaviest stretch, and it is the likeliest place to split into two releases (+1); V5 Generation A is planned out of this window, and joins it only on a slip. The `handle-ctors` sweep collides textually with steps 2 and 3, with V4 `EvalValue`, and with V5 Generation A if it slips to v0.2.73. It is mechanical, so on a conflict it is re-run on the rebased tree, never hand-merged. If it does not fit, it moves to v0.2.74 on the v0.2.73 seed, and the deletion to v0.2.75. If its Generation A missed v0.2.73 as well, it leaves the campaign (§7) rather than adding a cut. |
| **v0.2.74** | **On the v0.2.73 seed:** decision 43 step 4 (N3) — `iter`, `slice` and `entry`; the borrowed `for` by `impl(&C, IntoIterator)`, with `BorrowedWalk` deleted; the `FnMut` slots; `Future(T, p)` replaces A2's registry; and `--migrate deref` over std and src. **Macro plan Part C:** E0010, the machinery deleted, the lowering channel renamed. **V5 Generation B:** the parser drops `ref`/`atomic`, the 527 `is_reference_semantics`/`is_atomic_rc` sites are reread, and the docs and skills follow. The effect records derive `Copy` (the `ctl` rule in the seed). Then the K7 docs sweep and the K4 skills removal. **This is the last release that ships every `--migrate` mode.** **Decision 48 W6b, with V5 Generation B, so the header is rewritten once:** delete the collector runtime, `std/gc`, `YO_GC_THRESHOLD`/`YO_GC_FULL_PCT`, `Trace` and its impls, the large header, `compute_needs_cycle_gc`/`can_type_form_rc_cycle`, `--cycle-collector`, and ONLY the DECLARED `Acyclic` form: `g_declared_acyclic_ids`, the pragma rule, decision 21's `impl(TypeValue, Acyclic())`, and #1515's 48 declarations, which are dead code from here on. `Acyclic` stays as a derived-only marker. O9/O10 are amended to Rust's rule. `CYCLE_COLLECTION.md` is deleted, and what survives of it moves into `MEMORY_SAFETY.md` (both languages). The S1 `Rc(RefCell)` issue retires with the collector, unless v0.2.69 fixed it first. **Static-argument inference B3:** delete `box`/`rc`/`arc`; E0401 names `Rc.new` and repairs the token. | **FORCED #3** | The six README example projects must build and pass their own tests on a published release that ships every migration, with `.yo-version` pinned there, before the migrations can go. W6b needs one published release with `Off` as the default (W6a), on a seed that carries W3/W4 and Z11. | **Medium–high.** Each of the three Generation B halves can surface one seed-gated fix. A migration bug found while migrating the README projects means a fixed migration has to ship in another release before the retirement (+1). **W6b is a risk on the heaviest release.** The seed's codegen refers to `Trace` by name (`src/codegen/functions/collection.yo`), so stage 1 compiling a std without `Trace` may need one more seed-gated split. If W6b does not fit, it takes a release of its own (+1, §3). |
| **v0.2.75** | **Retire the `yo fix` migrations** (plan "After V5"). This removes today's modes from `src/main.yo` (`markers`, `borrow-spelling`, `params`, `addr-of`, `modes`, `match-scrutinee`, `dyn-spelling`, `drop-trait`, `rc-pattern`, `mutable-globals`, `mut-bindings`, `explicit-copy`) plus the ones the campaign adds (`cloned-accessors`, `rc-clone`, `deref`, decision 43's widening, and `handle-ctors` if its Generation B shipped by v0.2.74; otherwise it retires one release after it ships, §7). The per-diagnostic repairs stay, E0401's `rc`/`box`/`arc` token repair among them; its help drops the `--migrate handle-ctors` clause. ERROR_DIAGNOSTICS gains the table of last releases. **VBD is complete.** | End of campaign | It needs v0.2.74 published and the README projects migrated. | **Low** once v0.2.74 holds. |

## 2. The forced boundaries, and why

0. **The flip seed, at v0.2.70** (§5c decision 16).
   - B8–B11 compile the flipped std with the seed as stage 1, so the compiler fixes the B8 probe found (lookahead §3: C1–C4, C7, the match-break double drop, the `Rc` receiver) and B7a's `for(&xs, …)` must be in that seed.
   - It is not a Generation A/B pair in the plan's sense: it is the seed-gated fix the §3 "Any Generation B often surfaces one more seed-gated fix" line anticipated, taken early and on purpose.
1. **B12 → B13 (`Dyn`), at v0.2.71.**
   - B0 and B12 are the only seed-gated V2b PRs (plan §6 V2, "PR sequence" item 1).
   - The cut also carries the Generation A halves of allocator v2 and of the `__yo_cell` primitive, so each costs no boundary of its own.
2. **Decision 43 steps 2+3 → step 4, at v0.2.73.**
   - It is the same cut as the macro plan's B5. Part C needs a desugar-bearing seed.
   - V5 Generation A lands by it (v0.2.72, ceiling v0.2.73), so V5 Generation B shares the next cut.
3. **The last release that carries every migration, at v0.2.74.**
   - It carries decision 43 step 4, Part C, V5 Generation B and decision 48's W6b (§5a decision 14).
   - It is the gate the six README projects migrate on.
4. **The retirement release, at v0.2.75.** It is where the campaign ends rather than a seed boundary.

Two items are **not** boundaries, although the 2026-10-17 handover §4.4 lists them:

- **V2c.** The plan, lines 7240–7243, says: "One PR, not two generations. `Rc.clone(w)` has been in every seed since #1241 … The seed builds a swept `src/` unchanged." Decided 2026-10-20 (§5 decision 1). Please do not restore it to the count.
- **V5 as a release of its own.** V5 IS a Generation A/B boundary, which is why the v0.2.73 row lists it among its forcing dependencies. It adds no release, because it shares decision 43's step-3→4 cut: V5 Generation A targets v0.2.72 and v0.2.73 is its hard ceiling (§5 decision 6).

The 10-17 list also lacked two boundaries that this schedule absorbs into the B12 cut: allocator v2 (plan "After V2b … Seed gate") and the `__yo_cell` primitive.

## 3. Count

- **Expected: 8 releases, v0.2.68 (shipped 2026-10-22) to v0.2.75.**
  - Four are forced seed boundaries (v0.2.70's flip seed, §5c decision 16, plus the three below), plus the retirement release.
  - Three are cadence releases. Each of them can also absorb a seed-gated fix.
  - Static-argument inference adds no cut: Generation A rides v0.2.72, the migration and sweep ride v0.2.73 and the builtins' deletion v0.2.74 (one release later each on a slip).
  - Decision 48 adds no cut (§5a decision 14). W1, W2 and Z11 ride cadence releases, W3/W4 ride the B12 cut, W5 and W6a ride v0.2.72 or v0.2.73, and W6b rides the last-migrations cut.
- **Range: 8 to 13** (7 to 13 before v0.2.70 became the flip seed on 2026-10-23; 6 to 12 before v0.2.68 shipped on its own and W6b was placed).
  - **Theoretical floor: v0.2.68 plus 4 cuts.** The 4 cuts are the B12 cut, the decision 43 step 2/3 cut, the last-migrations cut and retirement. This needs everything after v0.2.68 through B12 in one release, which no measured velocity supports.
  - **Realistic floor: 8.** v0.2.68 shipped alone, which spent one fold. v0.2.70 became the seed the flips need, which spent the other (§5c decision 16).
  - **Pessimistic: 13.** A seed fix for the B8 probe is already absorbed by v0.2.69. Each of these adds one release:
    - B13 surfaces a vtable-contract fix;
    - decision 43 step 1, or steps 2+3, splits;
    - step 4 or V5 Generation B surfaces a seed-gated fix;
    - W6b does not fit v0.2.74 (§5a decision 14);
    - a README project finds a migration bug.
- **Any Generation B often surfaces one more seed-gated fix.** This cycle's precedents are `Pattern` (#1438) and `IterPeekable` (#1437/#1466). That is the main reason the expected count sits above the floor.

## 4. Every remaining step, by release

| Step | Spec | Release | Seed-gated? |
| --- | --- | --- | --- |
| §3.1 prerequisites: intern/share `module_path` + `input_string`, shared envs, `TypeValue` lists, non-cloning memo caches | 2026-10-19 handover §3.1, §4.2; plan V2b B1 "Path to a landable B1" | **landed in v0.2.68** (#1521, #1526, #1531, #1532) | no |
| Explicit-copy tool guards (temporary-as-move, `--hot-path` with no default) | same; §5 decision 7 | **landed in v0.2.68** (#1516) | no |
| Explicit-copy migration fixes (the B1 prerequisite) | `fix/explicit-copy-migration-defects` | **landed in v0.2.69** (#1537, #1549) | no |
| V2b B1 regeneration (listing-heavy) | plan V2b B1; §5a decision 11 | v0.2.69 (re-run GO 2026-10-23; v0.2.70 if its final gate fails) | no |
| V2b B2 (tests, scripts, `markdown_yo`) | plan V2b B2 | Yo half **landed in v0.2.68** (#1525); `markdown_yo` half **landed in v0.2.69** (#1544, `markdown_yo` v0.0.20) | no (companion `markdown_yo` release) |
| V2b B3 std hand edits | plan V2b B3; needs B1's listing | **landed in v0.2.69** (#1553; eleven getters return borrows) | no |
| V2b B4 src hand edits by directory | plan V2b B4; §5b decision 15; §5c decision 16; lookahead §4 | v0.2.71 (B4-0a may ride v0.2.70) | no (`RefCell` is in every seed since v0.2.64) |
| V2b B5 `RefCell` globals (`with`/`with_mut` only) | plan V2b B5, open question 1; §5 decision 3 | **landed in v0.2.69** (#1551) | no |
| V2b B6 accessors + `cloned-accessors` | plan V2b B6; §5b decision 15; §5c decision 16 | v0.2.71 (B6-a may ride v0.2.70) | no |
| V2b B7a read walk `for(&xs, …)` | lookahead D7, §4.3; §5c decision 17 | v0.2.70 | is the Generation A (std/src use it from the v0.2.70 seed on) |
| V2b B7 iteration and entries (the rest after #1429 and B7a) | plan V2b B7; closes `issues/collection-iterators-have-no-sound-post-v2b-shape.md`; §5b decision 15 | v0.2.71 | no |
| V2b B8 flip `ArrayList` + `String` | plan V2b B8 | v0.2.71, on the v0.2.70 seed | std-only; the seed is stage 1 and must carry C2–C7 and B7a |
| V2b B9–B11 other collections | plan V2b B9–B11; lookahead D11 | v0.2.71 | std-only |
| Macro plan Part A (`Iso` removal) | MACRO_AND_ISO_REMOVAL Part A; §5a decision 12 | **landed in v0.2.68** (#1530) | no |
| V3 std half, cell-free resources (`File`, `TempDir`, `TempFile`, `Watcher`, sockets, `TlsStream`, `HttpClient`, `Child*`, `Thread` → `Box`-celled structs) | plan lines 5096–5136; §5 decision 4 | v0.2.70 | no |
| V3 std half, atomic-cell primitives (every `atomic(...)` std type: `Mutex`, `RawMutex`, `RwLock`, `Cond`, `Barrier`, `Semaphore`, `WaitGroup`, `Once`, `OnceCell`, `ThreadPool`, the `std/sync` channel, `Atomic*`) | plan lines 5096–5136; §5 decision 4 | inside V5 Generation A (v0.2.72) | needs `__yo_atomic_cell` in the seed (v0.2.71) |
| V2b B12 `Dyn` Generation A | plan V2b B12 | v0.2.71 | is the Generation A |
| Allocator interface v2 Generation A | plan "After V2b: the allocator interface, version 2" | v0.2.71 | is the Generation A |
| `__yo_cell` / `__yo_atomic_cell` primitive (a named compiler-only PR) | plan §3.5, V5; §5 decision 5; lookahead D12 | v0.2.70 if gated, else v0.2.71 | is the Generation A |
| V2c (decision 17), one PR | plan V2c; §5 decision 1 | v0.2.71 | no |
| V2b B13 `Dyn` Generation B | plan V2b B13 | v0.2.72 | needs v0.2.71 |
| Allocator v2 Generation B | same | v0.2.72 | needs v0.2.71 |
| V2b B14 follow-ups (verifier alias model, decision 27, re-time) | plan V2b B14 | v0.2.72 | no |
| Decision 47 locals Generation B | plan "Decision 47" step 2; §5 decision 2; §5c decision 18 | std half v0.2.71 (before B8); src, docs and `markdown_yo` v0.2.72 | no (v0.2.65 carries #1440) |
| V4 `AstExpr` | plan V4 | v0.2.72 | no (watch for a `Pattern`-style seed bug) |
| Decision 43 step 1 (`TypeValue.Reference`, `Origin`) | plan "Decision 43" step 1 | v0.2.72 | no |
| Function-item types | 2026-10-17 handover §4 step 16 | v0.2.72–v0.2.73 | no |
| Decision 43 N0 (corpus + reference checker) | REFERENCES_AND_ORIGINS §8 | **landed in v0.2.68** (#1528) | no |
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
| Macro plan B3, B4 | MACRO_AND_ISO_REMOVAL Part B; B3 deletes `from_array` (§5 decision 8) | **landed in v0.2.68** (#1527, #1513) | no; B3 runs the escape-hatch checklist |
| `Acyclic` declarations, then #1486 | #1486's "Deferred"; §5 decision 10 | **landed in v0.2.68** (#1515); the declarations are dead code at W6b | no |
| `VcTerm` `Rc` children | decision 21 as amended 2026-10-18 | **landed in v0.2.68** (#1518) | no; after V2c its copies need `.clone()` |
| A4 std half + the capture-struct S2 | 2026-10-19 handover §3.2; `issues/fixed/2026-10-16-a-generic-io-async-body-shares-one-capture-struct-across-futures-of-one-generic-producer.md` | **landed in v0.2.67** (#1503, #1506, #1509) | no |
| V1 leftover: `arc` takes `alloc` | plan V1 "Done" (`feat/arc-alloc-parameter`, 2026-10-21) | **landed in v0.2.68** (#1519) | no: std-only, the scope swap around the cell constructor |
| V1 leftover: `rc` takes `alloc` | plan V1 "Done" (`feat/rc-alloc-parameter`, 2026-10-22); §3.2 | **landed in v0.2.69** (#1547) | no: the same scope swap as `arc`, std-only. Under the v0.2.68 seed the first build failed: a tail `match` was typed by the unbound `Rc(V)` for the `rc` that `dyn` synthesizes in `analyze_await_points`, so `rc` and `arc` now bind their `match` (`issues/fixed/2026-10-22-a-dyn-closure-in-a-generic-fn-boxes-through-a-cell-typed-by-the-unbound-return.md`). RSS/time check, `check src/main.yo`, develop `e30c0d8ed` vs the branch at `f41ffa39a` (before its rebase onto `95162303d`, whose #1543 moved the prelude), both binaries built by the v0.2.68 seed, interleaved runs on a shared box (load about 10 on 32 cores): max RSS 1,054,956 / 1,054,140 kB vs 1,053,080 / 1,051,212 kB; user time 606.2 / 564.2 s vs 533.8 / 523.8 s. No regression; the time gap is within this box's noise. |
| Async aliased-argument share S1 | `issues/fixed/2026-10-21-an-aliased-argument-in-an-async-body-gets-no-caller-owned-share.md` | **landed in v0.2.69** (#1538) | no |
| `drop_in_place(p : *T)` and the `unsafe` gate on `___drop` | §5a decision 13 | **landed in v0.2.69** (#1543) | no: a std function and a tree-compiler gate |
| Decision 48 W1 `--cycle-collector off` | WEAK_AND_UNCOLLECTED_RC §1, §7; §5a decision 14 | **landed in v0.2.69** (#1536) | no |
| Decision 48 W2 `Arc` and std/sync without `Acyclic` (#1534) | WEAK_AND_UNCOLLECTED_RC §2 | **landed in v0.2.69** (#1534) | no (needs Part A, landed in v0.2.68) |
| The S1 `Rc(RefCell)` cycle never tracked | `issues/2026-10-21-an-rc-refcell-cycle-is-never-tracked-by-the-collector.md` | retired by W6b (v0.2.74); not fixed (§5c decision 20) | no |
| Z11 `--allocator debug` + `yo test --allocator debug` | `ZIG_ADOPTION_CANDIDATES.md` Z11; `ZIG_STYLE_ALLOCATORS.md` A2 | v0.2.70 | no (the size-mismatch check follows allocator v2) |
| Decision 48 W3 `Weak(T)`, W4 `ArcWeak(T)` | WEAK_AND_UNCOLLECTED_RC §3, §7 | v0.2.71, after V2c merges | is the Generation A |
| Decision 48 W5 (derived `Acyclic` skips `Weak` edges; the S2 derivation fix; no pragma) | WEAK_AND_UNCOLLECTED_RC §4, §7 | v0.2.72 | needs v0.2.71 |
| Decision 48 W6a (`Off` the default for one release; the measurement recorded) | WEAK_AND_UNCOLLECTED_RC §6 precondition 3 | v0.2.72 or v0.2.73 | needs v0.2.71 (W3/W4) and Z11 |
| Decision 48 W6b (delete the collector, `Trace`, the large header, the knob and the DECLARED `Acyclic` form; derived `Acyclic` stays; O9/O10 amended) | WEAK_AND_UNCOLLECTED_RC §6 | v0.2.74, with V5 Generation B (risk +1) | needs W6a published |
| Static-argument inference Generation A: the rule, `Rc`/`Box`/`Arc` `.new`, `dyn` stops naming `rc` | `plans/backlog/STATIC_ARGUMENT_INFERENCE.md` §5 A1–A3 | v0.2.72, A2/A3 first in the window (before decision 43 step 1's emit-diff baseline) | is the Generation A |
| Static-argument inference Generation B: `--migrate handle-ctors` and the sweep (B1, B2, B4) | same, B1, B2, B4 | v0.2.73, first PR of the window (v0.2.74 on a slip); the mode retires at v0.2.75 | needs A1–A3 in the seed (v0.2.72) |
| Static-argument inference B3: `box`/`rc`/`arc` deleted, E0401 names `Rc.new` | same, B3 | v0.2.74 (v0.2.75 on a slip) | one release after the mode ships, so a published mode can type old calls |

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

## 5a. Decided 2026-10-21

The maintainer made all four. None adds or removes an expected cut. Decisions 11 and 12 keep v0.2.68 and v0.2.69 as two cadence releases. Decisions 13 and 14 were made the same day and recorded on 2026-10-22, after the v0.2.68 cut. Decision 14's W6b is one more risk on v0.2.74, so §3's pessimistic count rises by one.

11. **The B1 regeneration moves to v0.2.69, and B3 moves with it.**
    - Reason: v0.2.68 is cut on 2026-10-21 with the work that is gated by then. B1 can only start once the four §3.1 prerequisite branches and the copy guards are on develop, and then it needs a multi-hour measurement against the 80x / 45 GB regression. Nothing in v0.2.68 is a forced boundary, so the move costs no release slot, and B1 is measured against a released base instead of a moving one. B3 works from B1's listing (plan B3: "N1's std list"), so it follows B1. B2 is a separate sweep of tests, scripts and `markdown_yo`, and it stays in v0.2.68 if it is gated in time.
12. **The macro plan's Part A (`Iso` removal) moves forward from v0.2.70 to v0.2.68.**
    - Reason: `Iso` is little used and `src/` does not depend on it. Deleting it now closes the S2 `Iso` `Send` hole and the S1 collector hand-off (both issue docs retire with it) instead of carrying them through two more releases.
    - Cost: from v0.2.68 until B8 (v0.2.70) there is no safe way to move a `String` or collection to another thread. Part A's replacement probe moves to B8's gate.
13. **Keep `___drop` as the std-internal builtin, add the `unsafe` std function `drop_in_place(p : *T)`, and make `___drop` require an `unsafe` context.** v0.2.69.
    - `drop_in_place` is Rust's `ptr::drop_in_place`, with the body `___drop(p.*)`. It runs the destructor in place and does not move the value out. std's 11 `___drop(x_ptr.*)` sites (`std/prelude.yo`, `std/collections/array_list.yo`, `deque.yo`, `hash_map.yo`, `std/sync/channel.yo`) may move to it where that reads better.
    - Reason: macro plan B4 (#1513) deleted the `unsafe.drop` wrapper, so nothing at a `___drop` call asks for `unsafe` any more. The std sites wrap only the dereference. On a field place, safe code can write `___drop(h.xs)` and then read `h.xs`, which is a heap use-after-free with no `unsafe` anywhere. That is filed S2 on `docs/issue-drop-builtin-safe`, and `feat/drop-in-place` carries the issue together with its fix.
    - Not a cut: it is a std function plus a gate in the tree compiler, and the seed compiles both unchanged.
14. **Decision 48's placement** (`plans/backlog/WEAK_AND_UNCOLLECTED_RC.md` §7; plan "Decision 48" ordering 1–6):

    | Phase | Release | Why there |
    | --- | --- | --- |
    | W1 `--cycle-collector off` | v0.2.69 | independent; it is the measurement instrument |
    | W2 `Arc`, `Mutex`, `RwLock`, `Channel`, threads without `Acyclic` | v0.2.69 | needs Part A, which landed in v0.2.68; retires the S2 `Arc(Mutex)` issue as a leak |
    | Z11 `--allocator debug` | v0.2.70 | a campaign item that needs no seed; W6's leak oracle |
    | W3 `Weak`, W4 `ArcWeak` | v0.2.71 | Generation A after V2c's rule; rides the B12 forced cut, so it costs no boundary |
    | W5 derived-`Acyclic` fixes | v0.2.72 | needs W3's `Weak` edges in the seed |
    | W6a `Off` as the default | v0.2.72 or v0.2.73 | needs a seed with W3/W4, plus Z11 |
    | W6b the deletion | v0.2.74 | with V5 Generation B, so the header is rewritten once; risk +1 (§3) |

    - **Amendment (maintainer, 2026-10-21): `Acyclic` STAYS as a derived-only structural marker.** `T <: Acyclic` holds when no cycle of STRONG edges is reachable from `T`, and `Weak`/`ArcWeak` edges do not count. W6b deletes only the DECLARED form: `impl(T, Acyclic())`, `g_declared_acyclic_ids`, the pragma rule, decision 21's declaration and #1515's 48 container declarations. W5 also fixes the derivation, answering a cycle through a cell inductively instead of coinductively (the S2 `Arc(Mutex(Self))` case), and makes the walk skip `Weak` edges. The S2 issue therefore retires as a leak at W2 and stays open as a derivation bug until W5.
    - **Superseded:** decision 46 step 3, the collector predicate narrowing (the v0.2.71 row and §4), because W6 deletes the predicate. #1515's declarations and #1486 shipped in v0.2.68 and become dead code at W6b. Nothing is done about them before then.
    - **Docs ship with the phases:** W1 adds a section to `CYCLE_COLLECTION.md`, W3/W4 add a `Weak` page beside `ARC.md`, and W6b deletes `CYCLE_COLLECTION.md` and moves what survives into `MEMORY_SAFETY.md`, in both languages each time. The transitional collector-page draft was deleted in review (#1524, which landed as #1529), so the "promotion waits for V5" loose end is gone.
    - **Issues:** the S1 `Rc(RefCell)` cycle that is never tracked lands in v0.2.69 if the registration fix is cheap; otherwise W6b retires it with the collector. Decision 43 steps 2/3 (v0.2.73) keep `Escapable` on `Rc` payloads, and W6b amends O9/O10.

### Records kept from the earlier §5

These are not maintainer decisions. They are corrections of the sources that this schedule verified:

- **V1's "exclusivity assert moves to the write-through-`Rc` site"** is superseded. Decision 46 Generation B (#1421) makes a write through a plain `Rc` E0919 statically, and `RefCell` carries the dynamic check. The other V1 leftover, the auto-deref "payload has no field … either" message, has landed (`tests/deref_auto.test.yo:133`). `arc`'s `alloc` parameter landed std-only on `feat/arc-alloc-parameter` (2026-10-21), and the same review found that `rc` lacks it too (§3.2 gives it one), so `rc`'s `alloc` parameter is what remains.
- **`markdown_yo`'s decision 47 locals sweep ran at B2 (its v0.0.20, 2026-10-22), not at v0.2.72.** The v0.2.72 row assumed the package needs no `mut(x)` until the exemption is dropped. That holds for the store copy the compiler imports (`is_global_mut_rule_exempt` covers `/store/sha256/`), but not for `markdown_yo`'s own checkout: every compiler since v0.2.65 enforces E0917 there, and the checkout kept building only because its `.yo-version` pinned 0.2.64, which predates the rule. B2's explicit-copy migration has to evaluate the package from that checkout with the tree compiler, so 51 of its 54 `src` files failed with E0917 until `yo fix --migrate mut-bindings` marked 577 bindings and `.yo-version` moved to 0.2.67. The v0.2.72 Generation B pass still covers `markdown_yo`: this early sweep marks only the locals written by assignment today. Its handle writes (`b_marks.push(...)` on an unmarked local in `src/block/state.yo`, and the same shape in `renderer.yo`, `block/parser.yo`, `block/fence.yo` and `inline/superscript.yo`) write through a shared handle until B8–B11 and become value writes after them, so they need the same second pass as std, src and scripts (§5 decision 2).
- **`VcTerm`.** "Any time" predates V2c. After V2c a value enum with `Rc` children is explicit-copy, so `vc.yo`'s 49 `HashMap.get` sites need B6's accessors or `.clone()`. Landing it at v0.2.68 is still fine; it just pays a small V2c sweep later.

## 5b. Decided 2026-10-22

15. **B4, B6 and B7 move from v0.2.69 to v0.2.70, ahead of B8 in the same release.** v0.2.69 ships with the B1 regeneration if its re-run passes the measurement, plus B3, B5 and the independent items.
    - **Reason:** the B1 attempt of 2026-10-22 was NO-GO (#1539). Its re-run needs `Token.input`/`Token.module_path` shared as `Rc(String)` and two migration-tool fixes first, so B1 reaches develop late in the window. B4 then hand-edits about 1,950 listed `src/` sites by directory. B6 follows B1, and B7 follows B6. Holding the v0.2.69 cut for all three would delay it by several days.
    - **Not a cut:** none of the three needs a seed (B7's `for(&xs, …)` rewrite excepted, which the v0.2.70 row's uncertainty already covers), and the flip (B8) still needs B1–B7. The forced chain and §3's count are unchanged. v0.2.70 grows by three steps and carries more risk.
    - If the B1 re-run is NO-GO again, B1 moves to v0.2.70 as well, together with B3's dependents. B3 itself (std hand edits from the std listing) does not need B1 to land.

## 5c. Decided 2026-10-23

The maintainer delegated the picks ("decide what fits Yo best") and approved decision 16 directly. Decisions 17–19
adopt the lookahead's amendments (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` D7, D9, D11, D12 and D14).

16. **v0.2.70 is the seed release for the flips.** B4, B6, B7 and B8–B11 move to v0.2.71.
    - **Reason:** stage 1 is the seed compiling the flipped std. The B8 probe census and the lookahead's §3 list the
      compiler fixes B8 needs in that seed: C1–C4, C7, the match-break double drop and the `Rc` auto-deref receiver.
      None of them was ready by the v0.2.69 cut on 2026-10-23. Holding v0.2.69 would idle the campaign 12–24 h.
      Cutting v0.2.69 with what is ready, then a short v0.2.70 seed release (about a day), costs one release of
      overhead and no waiting. B4/B6/B7 are not seed-gated, and they keep landing on develop throughout.
    - **Count:** expected stays 8. The last fold is spent, so the floor becomes 8 (§3). v0.2.71 becomes the heaviest
      window. If it runs long, V2c, W3 and W4 slip to v0.2.72 rather than holding the B12 cut.
17. **B7a, the read walk `for(&xs, …)`, is split out and lands in v0.2.70 as a Generation A** (lookahead D7). std and
    src may write `for(&xs, …)` from the v0.2.70 seed on, so B8–B11 can use it.
18. **Decision 47 locals Generation B: the std half moves before B8** (v0.2.71, lookahead D9; amends §5 decision 2).
    The census showed that the std exemption hides real lost writes after the flip (the OrderedMap index, the TOML
    cursor). src, docs and `markdown_yo` stay at v0.2.72, so the 5,773 handle writes get one pass.
19. **Generation A halves merge once gated, even a window early** (lookahead D12): `__yo_cell`, B12 and allocator v2.
    Allocator-placed cells record their size and alignment in a 32-byte owner prefix (lookahead D14; the plan said
    16 B). Every cell free path is generic until W6b, which may shrink the prefix again.
20. **Process (maintainer, 2026-10-23).**
    - Every PR merges on its Tier 1. No local gate runs the whole `tests/internal` directory (AGENTS.md, #1556).
    - Develop's battery is watched and fixed forward.
    - The memory ratchet is re-baselined from the battery's own measurement whenever VBD work moves it (#1555).
    - A new bug in the cycle collector or the macro machinery is documented, not fixed. Both are being removed.

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
