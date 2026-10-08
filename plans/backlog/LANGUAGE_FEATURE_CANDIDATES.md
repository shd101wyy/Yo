# Language feature candidates (2026-10-08)

**Status: BACKLOG — five candidates, none adopted.** Proposed 2026-10-08 in a
design conversation with the maintainer ("what other language features would
you suggest?"), the same session as
[`RUST_REFERENCE_PATTERNS.md`](RUST_REFERENCE_PATTERNS.md) and
[`CODEGEN_PERFORMANCE.md`](CODEGEN_PERFORMANCE.md). Every candidate was
checked against what exists in `std/`/`src/`, what is already designed in a
plan, and what the maintainer has ruled out; the checks are cited per item.
Nothing here drives a phase. A candidate leaves this file only by becoming
its own plan.

## 0. The filter, and the standing rejections

A candidate must fit the house philosophy, which is also the LLM-era bet
(`plans/ROADMAP.md` "Positioning"): **explicit over inferred, locally
checkable over whole-program, visible costs, one canonical spelling**.
Features whose value comes from hiding work (implicit conversion chains,
inference puzzles, hidden aliasing) are out even when they are ergonomic.

Rejected again here, per standing rulings — do not re-propose:

| Feature | Where it was rejected |
| --- | --- |
| order-free named arguments | `plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` §1 (2026-09-19, final) |
| integer-literal inference through bindings | same, §1 (final) |
| a third closure call trait (`FnMut`) | `plans/VALUES_BY_DEFAULT.md` decision 37 — `mut` captures cover it |
| `Pin` | `plans/VALUES_BY_DEFAULT.md` decision 40 |
| operator precedence / overloading | `plans/reference/OPERATOR_SET_AND_PRECEDENCE.md`, `plans/reference/FUNCTION_OVERLOADING_POLICY.md` |
| lifetimes or borrow types | `plans/ROADMAP.md` non-goals; `plans/VALUES_BY_DEFAULT.md` decision 30 |

## 1. Scoped parallel iteration — the std layer the machinery already built for

**What.** A user-facing parallel-map/join API: `xs.par_map(body)` and a
two-way `par_join`, with the bodies `Sync`-bounded and checked by the
compiler — rayon's ergonomics as std, spelled in Yo's modes.

**The ground, checked 2026-10-08.** The prerequisites all landed with the VBD
`Send`/`Sync` split (#1254, #1268): `Sync`-bounded closure slots are enforced
(D1's reach walk covers them — decision 38 E calls exactly this "a
prerequisite of any scoped parallel API"), D1–D9 data-race soundness holds
with a standing TSan proof (`plans/reference/PARALLELISM_RULES.md`), the lowering
runtime exists (`src/codegen/parallelism/`), and `ThreadPool` is in
`std/thread.yo`. What does not exist anywhere: `par_map`/`par_for`/a scoped
fork (verified by grep; `std/thread.yo` has no scoped spawn).

```rust
// sketches; nothing is adopted
totals := xs.par_map(v => v.score);     // body slot: Impl(Fn(imm(v) : T) -> R, Sync)
(a, b) := par_join(() => crunch(&left), () => crunch(&right));
```

**Why it fits.** In Rust this is a third-party crate with
`IntoParallelIterator` trait gymnastics; in Yo it is std, proved by the same
`Sync` bounds `yo check` already verifies, with the sharing visible in the
signature. It is the one domain where Yo can be *more* ergonomic than Rust
without giving up explicitness.

**Open question (the honest semantic difference).** Rayon *borrows* the
collection it iterates; Yo borrows are never `Send` (decision 38 E), so a
Rust-shaped scoped-thread API over stack locals is impossible by design. The
Yo shapes are: `Arc(ArrayList(T))` read-only sharing (already legal,
`plans/VALUES_BY_DEFAULT.md` §3.8), or owned chunks moved in and results joined.
Whether that covers rayon's real workloads — or whether the answer needs the
borrow-mode machinery of §3 — is the design question, and it should be
answered with workload examples before an API is chosen.

## 2. A portable SIMD layer — `std/simd`

**What.** Fixed vector types (`f32x4`, `i32x8`, …) with the arithmetic
operators, lanes, loads/stores, lowering to clang/gcc vector extensions.

**The ground.** Nothing in `std/` or `src/codegen/` touches vectors today
(verified 2026-10-08; the C compilers Yo drives — clang, gcc, zig cc — all
support `__attribute__((vector_size))`, and emscripten lowers it to wasm
SIMD). The existing escape hatches (inline asm, `ptr()` under the pragma)
cover the corners this would not.

```rust
// sketch; the emitted C is float __attribute__((vector_size(16)))
{ f32x4 } :: import("std/simd");
dot :: (fn(imm(a : f32x4), imm(b : f32x4) -> f32)((a * b).sum()));
```

**Why it fits.** A language claiming C-comparable speed needs an answer for
the code that most needs it (kernels, codecs, hashing, crypto — all already
in `std/`), and Rust's `std::simd` is still nightly. The cost is visible in
the type, the C stays readable, and it composes with
`CODEGEN_PERFORMANCE.md` CP1a: SIMD where you spell it, autovectorization
(`restrict`-unlocked) where you do not.

**Open questions.** The target matrix (every supported triple must either
lower the extension or take a scalar fallback path); whether lanes/extract
are methods, operators, or builtins; the `--sanitize` interplay.

## 3. Pre-design the stateful call and borrow-mode fields — treat the parked trigger as *when*, not *if*

**What.** Not the feature now — the design note now. Decision 37 already
sketches "the planned addition, if it is ever made" (a `mut(self)` closure
call) and decision 39 parks "borrow-mode struct fields" beside it, with one
shared trigger: lazy adapter chains over borrowed containers proving common
enough. The prediction recorded here: **that trigger will fire**, because
agents and Rust-trained writers reflexively produce `xs.map(...).filter(...)`
chains, and today's answers ("write the loop", or `xs.clone().into_iter()`)
are the weakest rows of `RUST_REFERENCE_PATTERNS.md` §5.

**The candidate.** Promote those two paragraphs into their own designed
backlog doc — the way `SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md` answered
`plans/SAFE_MODE.md` §8 — settling the shape (`struct(imm(xs) : ArrayList(T),
i : usize)` with `next(mut(self)) -> imm(T)`), the escape rules it reuses
(decision 38 A's structural second-classness was practically built for it),
and the trigger's measurement. Then adoption, when it comes, is a review
away instead of a campaign.

**Why it fits.** It is the first dividend of the VBD machinery rather than a
fight against it, and it retires the largest ergonomic gap the value-semantics
model created.

## 4. Rest and prefix patterns with second-class bindings

**What.** Array rest patterns and string-prefix patterns in `match`, where
the tail binding is a **borrow** (decision 26's binding modes), never a
storable view.

**The ground.** The `Pattern` IR has nested, literal, or, string, range,
guard, `:=`, tuple/struct and `Box` patterns
(`plans/reference/MATCH_PATTERN_MATCHING.md`); rest and prefix shapes are absent.
Fixed `Array(T, N)` makes array rest patterns exact — Rust needed const
generics for this; Yo's comptime value parameters already have it.

```rust
// sketch; array rest is exact on Array(T, N), and `rest` binds as imm
match(&xs, .Some([first, ...rest]) => f(&first, &rest), .None => ());
// a str prefix pattern ("GET " then the remainder) — the spelling is the
// open question; the remainder would bind as a borrow of the scrutinee
```

**Why it fits.** The lexer-shaped code that `RUST_REFERENCE_PATTERNS.md`
§2.1 writes with manual index arithmetic gets its pattern form back, and the
feature *exercises* the new borrow machinery (a binding that borrows, lives
for its arm, and cannot be stored — decision 38 A) instead of fighting it.

**Open questions.** The prefix spelling (a candidate token must not collide
with `+`/`++`-free operator set); exhaustiveness — the usefulness lattice
needs a rest node beside the interval and string nodes; `ArrayList` has no
fixed shape, so rest patterns are `Array(T, N)`-only by exactness.

## 5. Trait-method contracts — a prioritization, not a new feature

**The ground, checked.** This is already designed and queued:
`plans/backlog/FORMAL_VERIFICATION.md` Phase V6 ("Traits, generics, refinements")
carries trait-method contract tables with a named hook
(`register_trait_method_contracts`,
`src/evaluator/values/type_trait_methods.yo`), and type-level laws already
landed (B0–B1, `plans/backlog/BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`). **The
candidate recorded here is only sequencing**: pull V6 forward in the FV
queue relative to later phases, because it is the roadmap's own stated
differentiator ("humane verified systems programming",
`plans/ROADMAP.md` Positioning) and it closes contracts at the abstraction
boundary — where most real contracts live and where `Dyn(Trait)` dispatch is
currently unverifiable. It is also the item on this list no other systems
language has.

## 6. Maintenance

This file is the parking lot. A candidate that is adopted becomes its own
plan (active or backlog with a design), and its line here turns into the
pointer. A candidate rejected gets its reason recorded in §0's table so it
is not re-proposed. Re-verify each item's "ground" section before acting:
the tree moves fast (item 5's "gap" was already a designed phase when
checked — the reason every claim here carries its citation).
