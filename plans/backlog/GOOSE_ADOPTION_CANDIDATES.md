# What to take from goose: adoption candidates checked against the tree

**Status: BACKLOG — research, written 2026-10-25 at the maintainer's
request, from the brainstorm of the same day.** Goose is Wouter van
Oortmerssen's memory-safe systems language with no heap allocator
(<https://github.com/aardappel/goose>; README, tutorial and benchmark
read 2026-10-25, sources in §6). Audited against the campaign state —
decisions 17, 42, 43, 47 and 48 and the V2c/V5 phases of
[`../VALUES_BY_DEFAULT.md`](../VALUES_BY_DEFAULT.md) — and the tree at
`ce80cbd39`: every "Yo today" claim below was checked by read and grep
on that tree; goose claims carry primary sources (§6). Written after the
maintainer's 2026-10-25 note that the cycle collector (decision 48) and
compile-time reference counting (decision 17 / V5: the dup/drop removal)
are going — several blockers that would have applied to the pre-campaign
language have dissolved accordingly. Companion audits:
[`RUST_ADOPTION_CANDIDATES.md`](RUST_ADOPTION_CANDIDATES.md),
[`ZIG_ADOPTION_CANDIDATES.md`](ZIG_ADOPTION_CANDIDATES.md),
[`LEAN_ADOPTION_CANDIDATES.md`](LEAN_ADOPTION_CANDIDATES.md) and
[`FSTAR_ADOPTION_CANDIDATES.md`](FSTAR_ADOPTION_CANDIDATES.md) carry the
same filter for their languages. Nothing here is adopted; each candidate
ends with a verdict and a trigger, and the maintainer picks.

## 0. The model, and the filter

Goose in one screen (all quotes from its README, §6):

| Mechanism | Goose |
| --- | --- |
| storage | "there is no heap": every dynamic value lives inline on one of N "data stacks" — large address-space reservations with a bump pointer — and "the compiler works out N"; "Freeing a million-element structure is one store, however deeply it nests" |
| references | "Every reference and slice has a static *root*: the variable that bounds its target's lifetime", compiler-inferred; "no lifetime syntax, no aliasing or exclusivity rules, no `unsafe`" |
| growth | only one resizable value may be live per data stack, and it must sit on top, so "growth never moves anything and never checks a capacity"; "A reference into a growing array stays valid for as long as the array does" |
| construction | "a constructed value is always built in its final home, propagated top-down through calls": `items.push(parse(line))` "writes the parsed record straight into the array", and returning a growable array by value is free |
| links | relative references `T&<u32>`: "a typed, checked link as a 1, 2 or 4-byte offset"; structures are position independent, so "your data structure is already its file format"; `from_bytes` verifies "every tag, every length and every link" and hostile bytes yield `false`, never a bad reference |
| polymorphism | ADTs are "the only dynamic polymorphism: no inheritance, no vtables"; blocks are compile-time entities — "no closure objects or function pointers" |
| threads | each thread is "a separate program with its own memory", typed queues carrying flat values by memcpy |
| the rest | multiple returns; statically-checked cross-frame `return err from f`; `reusable` pools for non-nested lifetimes; variable-size enums (each value its variant's size) |

The filter (RUST/LEAN §0, adapted):

1. **Not already rejected.** The binding non-goals: no region variables
   or a solver — origins are ground place sets
   ([`REFERENCES_AND_ORIGINS.md`](REFERENCES_AND_ORIGINS.md) §6); no
   second allocator model beneath the placement decisions C1–C7
   ([`ALLOCATOR_PLACEMENT.md`](ALLOCATOR_PLACEMENT.md)); no weakening of
   the freeze model (decisions 18, 42).
2. **Fits the model.** Values by default, explicit cells, explicit
   contracts. Anything needing inference at semantic distance, or buying
   ergonomics by dropping the law of exclusivity, is out on arrival.
3. **Pays for an LLM author.** A guarantee a model can rely on when
   writing code, or a diagnostic that names the next edit — not machinery
   only a human profile would notice.
4. **Not already here** (§1) **or already scheduled** by the campaign.

## 1. Already converged (do not re-propose)

The headline finding: **the owned half of post-campaign Yo is goose's
value model, arrived at independently.** Goose's static root is decision
43's origin; goose's inline pointer-free values are the campaign's
values-by-default plus V5; goose's explicit copy is decision 17's
E0901; goose's count-free values are V2c/V5 and decision 48. Concretely:

| Goose | Yo (decision / phase) |
| --- | --- |
| a reference's static root, the bounding variable | origins: `&(T, p)`, `p` a ground set of places (decision 43, `REFERENCES_AND_ORIGINS.md` O1) — declaration-first where goose infers (the LLM-authorship principle, that file's §2) |
| inline, pointer-free nested values | structs and enums are inline C values today; V5 flips the implicit `ref` objects to explicit-clone `Rc`, so every non-cell value is a count-free C value (decision 42; V5) |
| `=` copies, `.=` binds a reference | implicit `Rc`/`Arc` handle copies are E0901 with `.clone()` (decision 17, V2c) |
| no reference counting on values | once V5 lands, "the dup/drop pair optimizer has no implicit copy left to cancel" (`VALUES_BY_DEFAULT.md:8525`); counts survive only on explicit `Rc`/`Arc` cells (`:1784`) |
| no cycle collector; deterministic destruction | decision 48: Rust's model exactly — the last strong handle frees, a cycle leaks, `Weak` names the back edge (`VALUES_BY_DEFAULT.md:4606`) |
| multiple return values, destructuring | tuples, already |
| monomorphized generics | specialization, already |
| pools for non-nested lifetimes (`reusable`) | scheduled as the allocator library's application ([`ZIG_STYLE_ALLOCATORS.md`](ZIG_STYLE_ALLOCATORS.md) A1/A3) |

What remains genuinely different after the campaign: the explicit
shared cells (`Rc`/`Arc`, `RefCell`, `Box`, `Dyn`), raw buffer allocation
for the containers, the async state machines (decision 40's heap storage
that never relocates), dynamic dispatch and fn values (goose refuses
both), shared-memory threads (goose refuses those too), and the freeze
model (goose checks lifetime only; Yo additionally guarantees
exclusivity). §2's candidates live in that remainder; §3 prices complete
adoption (the maintainer's question of 2026-10-25: what would Yo lose?);
§4 records the refusals Yo should keep refusing.

## 2. The candidates, ranked

### G1 — Guaranteed in-place construction (the copy-elision spec)

**Goose:** "a constructed value is always built in its final home,
propagated top-down through calls", so `items.push(parse(line))` "writes
the parsed record straight into the array" and a function "returning a
grow-only array by value writes its elements straight into the caller's
variable". This is a *specification*, not an optimization pass: the
language promises the elision.

**Yo today:** the dup/drop pair optimizer
(`_optimize_dup_drop_pairs`, `src/evaluator/exprs/begin.yo`;
`VALUES_BY_DEFAULT.md:1756`) cancels pairs best-effort, and its
over-cancellation pitfalls are catalogued in `AGENTS.md`. It is
trustworthy enough as an optimizer, too fragile to promise.

**Candidate:** after V5 removes the implicit copies, replace the
optimizer's *role* with a guarantee: a value returned into a binding, an
argument slot or a container insertion is constructed in place — NRVO
through calls, construction-through-argument. The spec lives in the V5
ownership doc (`OWNERSHIP_AND_BORROWING`), enforced by an emit-diff gate
on the self-build, the instrument V2c already requires for its own
measurement.

**Verdict: the strongest semantic candidate** — the ergonomics half of
"values are cheap" stated as a contract, with goose as the existence
proof. **Trigger:** V5's landing — the optimizer's current job disappears
then; its successor is the guarantee, not a better optimizer.

### G2 — Relative references: a checked `Rel(T)` offset and a verified `from_bytes`

**Goose:** `T&<u32>` is "a typed, checked link as a 1, 2 or 4-byte
offset"; structures are position independent, so "your data structure is
already its file format"; `from_bytes` verifies "every tag, every length
and every link", and hostile bytes yield `false`, never a bad reference.

**Yo today:** nothing. `View(T, p)` (decision 43's zero-copy row,
`REFERENCES_AND_ORIGINS.md` §3) borrows live memory; a *stored* offset
that is checked on every dereference does not exist, and the
serialize/deserialize story is separate from the borrow model entirely.

**Candidate:** a std type `Rel(T, W)` — a width-`W` offset into a named
buffer, bounds- and link-checked on every dereference, safe by
construction the way `ARENA_ALLOCATOR_FEASIBILITY.md` §4.1's `Handle(T)`
is (stale reads `.None`, never UB) — plus a `from_bytes`-style loader
whose walk (tag, length and link validation) is a verifier-contract
template the way bounds obligations are today. The origins discipline
extends naturally: a `Rel`'s root is the buffer's place, so `Rel(T)`
inside a buffer behaves like a reference whose origin names the buffer
binding — O1's set algebra unchanged, one new origin value shape.

**Verdict: adopt** — pure std + verifier territory, no language change
beyond what decision 43 already designs, and the verifier is exactly the
right tool for the loader's obligations. **Trigger:** independent of the
campaign; the origins tie-in arrives with `View` at N3, the type and the
loader can land earlier.

### G3 — The zero-allocation DTO benchmark

**Goose:** its benchmark leads with a sample order that is "29 bytes and
0 allocations" versus 160 bytes and 1 allocation for C++ — allocation
count and inline bytes as a published, comparable metric.

**Yo today:** `--allocator debug` counts allocations (the leak oracle,
decision 48's precondition, `src/main.yo:7025`), but no test ratchets a
representative program's allocation count or bytes.

**Candidate:** one frozen DTO-shaped program (nested structs, a
container of variable-size records, string fields) compiled under
`--allocator debug`, ratcheting total allocations = 0 (post-G1) and
reporting bytes. It guards the campaign's central claim — returning
values is free — the way the fixpoint guards self-hosting.

**Verdict: adopt; the cheapest item here.** **Trigger:** with V5 (before
it, `ref` cells make the count nonzero by design).

### G4 — `reusable` pools: a std `Pool(T)`

**Goose:** `reusable` values keep a hidden freelist, for lifetimes that
do not nest.

**Yo today:** covered by the allocator library already scheduled — a
`FixedBufferAllocator`/`ArenaAllocator`-backed pool is an application of
[`ZIG_STYLE_ALLOCATORS.md`](ZIG_STYLE_ALLOCATORS.md) A1/A3, not a new
mechanism (`ARENA_ALLOCATOR_FEASIBILITY.md` §0.5 ships the handle-indexed
library shape).

**Verdict: fold into the ZIG plan's examples; not a separate goose
item.** **Trigger:** A1/A3.

### G5 — Cross-frame `return err from f`

**Goose:** `return err from f` returns from a function any number of
frames up, statically checked — error propagation without `Result`
plumbing through every intermediate frame.

**Yo today:** algebraic effects already express it: an operation handled
frames up, `unwind(expr)` discards the continuation and exits the
enclosing `fn` (`AGENTS.md`'s effects model). Goose contributes a
spelling, not a mechanism.

**Verdict: noted, not a candidate.** If error propagation ever measures
as agent friction, the sugar goes through the effect machinery.

### G6 — The escape-free profile: goose's data stacks as a Yo sub-language

This is the maintainer's question ("goose uses no heap — is it possible
to do the same while keeping the ergonomics?") answered at full length,
because the campaign has moved the ground under it.

**What dissolved.** The classic reason a bump stack cannot serve Yo —
RC frees blocks in arbitrary order, so a bump region fragments
(`FIXED_REGION_ALLOCATOR.md` §0's rejection of a bump `--allocator
fixed`) — applied to compile-time RC on ordinary values. Decisions 17
and 48 and V5 delete exactly that: ordinary values become count-free
inline values with scope-nested lifetimes, and arbitrary-order freeing
survives only on explicit `Rc`/`Arc` cells — which leak cycles instead
of collecting them. Post-campaign, the owned half of a Yo program
already has goose's lifetime discipline; what it lacks is goose's
*storage*: container buffers malloc/realloc, cells box, async machines
heap-allocate.

**The candidate.** An opt-in profile — declared at a module or root, in
the placement decisions' spirit of explicitness — under which:

- the checker proves membership: no `Rc`/`Arc`/`RefCell`/`Box`/`Dyn`, no
  `spawn`; every origin resolves to a place of the enclosing frame. The
  origin checker decision 43 builds is exactly this proof: origins are
  ground place sets, so "every root is in this frame" is a set
  predicate, not a region solver.
- containers are region-backed: each growable container gets its own
  bump region (goose's "the compiler works out N"), so a scope exit is
  one pointer store per region and growth never reallocates-and-moves.
- async state machines allocate from a per-event-loop arena released at
  quiescence — completions interleave, so not LIFO: a chunked arena, not
  a pure bump (the generalization of
  `ARENA_ALLOCATOR_FEASIBILITY.md` §5's hatch-8 note).

This is `ARENA_ALLOCATOR_FEASIBILITY.md` §4.3's Option C′ generalized
from one cell kind to a whole profile, riding two rails the campaign
just laid: the placement decisions C1–C7 (a data stack is an
`Allocator` a root declares, not a fourth implicit `--allocator`), and
the origins N-phases (the membership proof). Decision 48's own sentence
draws the same line: "Arenas do not replace the collector (they cover
phase-structured data, the collector long-lived mutable graphs)"
(`VALUES_BY_DEFAULT.md:4621`) — the profile is the phase-structured
half, made checkable.

**The honest costs, from goose itself:** recursion cannot keep growable
data across recursive calls (each frame's growth needs its own region);
non-nested lifetimes need pools (G4); the author thinks about scopes.
Goose's ergonomics are real *inside* the discipline, and the discipline
is the price. A profile — not the default language — is the only shape
that keeps the cells, the dynamic dispatch and the shared-memory threads
Yo keeps by design; that is the answer to "while keeping the
ergonomics": the ergonomics of the whole language are kept by not
making the profile the language.

**Verdict: the right long-term shape for the no-allocator story
(embedded, kernels, per-request scratch), and NOT a campaign item.**
**Trigger:** origins N-phases + ZIG A1/A3 landed, and a workload that
asks — the bar Option C′ set ("not motivated by anything measured
today"). Goose is the existence proof the ergonomics can work, not the
measurement that they pay.

### G7 — Variable-size enums

Goose sizes each enum value by its variant rather than the largest one.
For movable C values this is unsound to promise — a by-value copy of a
variable-size object has no size to copy, which is why C unions
over-allocate — but §2 G6's profile values never move, and there the
idea becomes expressible (flexible-array layout over region storage, a
profile-only layout liberty).

**Verdict: park inside G6.** **Trigger:** G6.

## 3. What complete adoption would delete

The maintainer's question of 2026-10-25: if Yo adopted goose's model
completely — no heap, no allocators — what would Yo lose? Do `Dyn`,
closures, async I/O stop working? **Yes: all three, and they are the
visible third of the cost.** Complete adoption is not a refactor of Yo;
it is goose with Yo's syntax. The accounting, feature by feature:

| What goes | Why the model cannot hold it | Goose's replacement | What Yo actually loses |
| --- | --- | --- | --- |
| `Dyn` | "no vtables": a `Dyn` cell is a heap cell with a vtable pointer (the clone slot landed in #1603) | monomorphized generics, or hand-written tagged enums | runtime-chosen behavior: heterogeneous lists, plugin registries, `Dyn(Fn(...))` callback slots. Only comptime-known behavior survives |
| closures and fn values | "no closure objects or function pointers": a capture record is a heap cell, and the io and effect runtimes are built on them | compile-time blocks, inlined per call site | storing or transporting behavior at runtime (callback fields, strategy values), and every closure that outlives its frame. A `sort(xs, cmp)` comparator survives (it is generic); a callback chosen by input does not |
| async I/O as designed | decision 40's heap machines that never relocate, alive concurrently with interleaved lifetimes — no bump stack serves non-LIFO completion | goose has none; its answer is threads + memcpy queues | suspension, `await`, `Future` as a value, select/join, the single-threaded event loop; thread-per-task or a fixed slot pool (a *static* concurrency bound) remain. A per-task arena "fix" silently reintroduces an allocator |
| `Rc`/`Arc`/`RefCell` | shared ownership is unrepresentable when every lifetime nests | pool indexes; cross-thread = flat values over queues | shared graphs and caches. And goose checks lifetime only — adopting its alias-permissive half costs the law of exclusivity, which the verifier's alias reasoning leans on (`REFERENCES_AND_ORIGINS.md` §6's Ante rows) |
| `Box`, stable addresses | unbounded-lifetime storage IS a heap | nothing — flat values by copy | FFI with any C library that stores your pointer (userdata, GUI toolkits, sqlite-style handles); pointer-shaped C APIs cannot be wrapped |
| unbounded-lifetime data | scope-exit freeing forces every program to be phase-structured | pools (`reusable`) | process-wide caches, memo tables, the module cache, LSP state; and `Drop`-at-last-use (decision 45) collapses to lexical scope end — resource guards held to end of block |
| the allocator work just decided | "no allocators" | one reservation per data stack | decisions C1–C7, the ZIG-style allocator library, `--allocator fixed`/`mimalloc`, `--heap-size` — all moot. The reservation trick also needs 64-bit address space; wasm32 (a Yo target) degrades to explicit pools |

**The decisive row is not in the table: the compiler.** The compiler is
the anti-goose workload — `TypeValue`/`AstExpr` trees retained and
shared across every phase, the demand loader's cached prelude
environment, a multi-gigabyte resident `check`: retention, not churn,
which is why [`../EVALUATOR_MEMORY_REDUCTION.md`](../EVALUATOR_MEMORY_REDUCTION.md)
and `ARENA_ALLOCATOR_FEASIBILITY.md` §0 item 4 concluded arenas do not
fix its memory story. Complete adoption means rewriting the compiler
around handle-indexed tables at best, with the evaluator's shared
mutable graphs fighting the model throughout: self-hosting as
architected does not survive. A language that cannot host its own
compiler, an LSP, an async server std and pointer-shaped C interop is a
niche systems DSL, not Yo.

**What survives untouched** is most of the owned half: values (already
goose-shaped post-V5), `&`/`&mut` with origins (which get *simpler*,
closer to inferrable), generics, enums and `match`, tuples, and
containers under the one-resizable-value-per-region constraint with
pools. That survivors list is why G6 took the shape it did: a profile
the origin checker proves, inside which the kill list above is accepted
deliberately, while the rest of the program keeps the dynamic half.

## 4. Rejected, with reasons

| Goose's choice | Verdict |
| --- | --- |
| "no closure objects or function pointers", no vtables — everything monomorphized | **rejected** — `Dyn`'s vtable just gained its clone slot (#1603); first-class fn values, closures and effect handlers are load-bearing in Yo's design and in its own compiler |
| threads as isolated programs, typed queues, memcpy transfer, no shared memory | **rejected** — the parallelism runtime is shared-memory `Send`/`Arc` by design ([`../reference/PARALLELISM_RULES.md`](../reference/PARALLELISM_RULES.md)); goose's isolation is the maximal answer to a question Yo answered differently |
| references into a growing array stay valid (growth never moves) | **rejected** — growth is an access, and live loans freeze the container (decisions 18, 42; `REFERENCES_AND_ORIGINS.md` O6): goose's most-quoted ergonomic win is exactly the exclusivity guarantee Yo refuses to trade |
| no aliasing or exclusivity rules (lifetime safety only) | **rejected** — the freeze model is what the verifier's alias reasoning leans on (`REFERENCES_AND_ORIGINS.md` §6's Ante rows carry the same verdict) |
| data stacks as the whole language's storage | **rejected as a default** — the explicit cells keep last-handle freeing in arbitrary order; the shape that survives is G6's profile |
| the six array kinds, varint-sized arrays | **not adopted** — capacity policy is a container concern under the placement decisions, not a type-system distinction; `ArrayList`, `Array(T, N)` and `View` cover Yo's ground |

## 5. What goose validates

- **Origins.** Goose independently arrived at "every reference carries
  its bounding root, and errors name the root and the destination" —
  decision 43's design, inference-first. The convergence is recorded in
  `REFERENCES_AND_ORIGINS.md` §6's table (this PR). Yo keeps
  declaration-first (the maintainer's LLM-authorship principle) and
  keeps exclusivity; goose is the inference-only, lifetime-only extreme
  of the same design space, and its N-data-stacks scheme is prior art
  for the "growth never moves" half Yo trades away.
- **The dup/drop-removal direction.** Goose demonstrates that count-free
  values with nested lifetimes are enough for ergonomic systems code —
  the same destination decisions 17/48/V5 reach, from the opposite
  direction: no heap ever, versus a heap of explicit cells.
- **The arena/collector split.** Decision 48's "arenas cover
  phase-structured data, `Weak` covers long-lived graphs" is goose's
  architecture collapsed onto one language: goose IS the
  phase-structured half, standing alone as a whole language.

## 6. Sources

Goose (all read 2026-10-25):

- Repository and README: <https://github.com/aardappel/goose>
- Tutorial: <https://aardappel.github.io/goose/docs/tutorial.html>
- Benchmarks: <https://aardappel.github.io/goose/bench/results.html>
- Hacker News discussions:
  <https://news.ycombinator.com/item?id=49748954>,
  <https://news.ycombinator.com/item?id=50224100>

Yo:

- [`../VALUES_BY_DEFAULT.md`](../VALUES_BY_DEFAULT.md) — decision 17
  (`:8525`), 42, 43, 47, 48 (`:4606`, `:4621`); V2c, V5; the RC
  runtime's scope (`:1784`); the dup/drop optimizer (`:1756`)
- [`REFERENCES_AND_ORIGINS.md`](REFERENCES_AND_ORIGINS.md) — O1–O10, §3,
  §6
- [`ARENA_ALLOCATOR_FEASIBILITY.md`](ARENA_ALLOCATOR_FEASIBILITY.md) —
  §0 verdicts, §4.1, §4.3 Option C′, §5 hatches
- [`ALLOCATOR_PLACEMENT.md`](ALLOCATOR_PLACEMENT.md) — C1–C7
- [`../EVALUATOR_MEMORY_REDUCTION.md`](../EVALUATOR_MEMORY_REDUCTION.md) —
  why the compiler's footprint is retention, not churn
- [`ZIG_STYLE_ALLOCATORS.md`](ZIG_STYLE_ALLOCATORS.md) — A1/A3
- [`../reference/FIXED_REGION_ALLOCATOR.md`](../reference/FIXED_REGION_ALLOCATOR.md) —
  §0's bump rejection
- `AGENTS.md` — the dup/drop optimizer's pitfalls; the effects model
