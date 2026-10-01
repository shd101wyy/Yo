# What else Yo can take from ATS: beyond indexed types

**Status:** ACTIVE (2026-10-01): implementation started, in the §6 order
(A4 first: it fixes a live S1). Audit done 2026-09-30 (develop `c0c8ab6af`,
seed `yo 0.2.46`). The companion of
[`backlog/ATS_STYLE_INDEXED_TYPES.md`](backlog/ATS_STYLE_INDEXED_TYPES.md), which covered
ATS's dependent (indexed) types and existentials; its R1 phase is complete.
This doc covers the rest of ATS. Every "Yo today" claim is a probe run with
the seed, or a cited file.

| Item | State |
| --- | --- |
| A1 lemma layer (= R2) | slices 1–2: recursive `ghost_fn` as an axiomatized function (#1075); lemmas, `seq_of`, the three DML exit fixtures (`feat/verifier-lemmas`); slice 3: a verified `for` over a list with `produced(xs)` (`feat/verifier-for-produced`); slice 4: `distinct(a, b)` (`feat/verifier-distinct`). **Done** |
| A2 must-use | done (#1075): E0617, plus the always-exits rule found while landing it |
| A3 spec-transparent pure fns | done: slice 1 (#1075); slice 2 (`feat/verifier-distinct`): a recursive callee is transparent only with `decreases` (without it, an S1: `issues/fixed/a-transparent-callee-that-recurses-without-decreases-proves-anything.md`), and the subset error names the missing property |
| A4 init proof token (S1) | done (#1075): `set_len` deleted, the token is `Option(*(T))` |
| A5 lexicographic `decreases` | done (#1075) |
| A6 typestate idiom | docs done (#1075); its S3 (`issues/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`) open |

## 0. The verdict

ATS has three big ideas: indexed types (done), **programming with theorem
proving**, and **linear types with views**.

- **Theorem proving.** Proofs are values that are erased after checking:
  `prfun`, `praxi`, `dataprop`. Yo's verifier already has the erased-spec
  half: `ghost`, `ghost_fn`, `law`, `assumed()`, `decreases`. What it lacks
  is **induction lemmas**. Today's measurement (R2 in the indexed-types plan)
  shows every inductive obligation over a list is `unknown` to Z3 until a
  lemma is supplied. That is the most valuable thing left to take.
- **Linear types with views.** Yo decided against linear types (RC +
  `Dispose` + `own` is the model; `plans/backlog/FUTURE_ORIGINS.md`,
  `plans/reference/MEMORY_SAFETY.md`), and this audit does not reopen that.
  But two things linearity buys in ATS are missing from Yo, both measured:
  - a result you must not silently drop (`Result`, an unawaited `Future`);
  - a proof token that gates claiming memory initialized. Its absence is a
    live S1: safe code reaches freed memory through `ArrayList.set_len`
    (`issues/fixed/safe-code-reaches-freed-memory-through-arraylist-set-len.md`).

  Both can be had without linear types.
- **The rest ATS is known for, Yo already has:** exhaustive matching,
  termination metrics, typestate through phantom parameters, flat vs boxed
  data, static conditionals, templates-as-comptime, stack closures. Or it
  has an equivalent it prefers.

## 1. What was measured

Probes are small files checked with the installed seed `yo 0.2.46` in a
scratch directory (its bundled std), 2026-09-30.

| Probe | Result |
| --- | --- |
| Phantom typestate: `Handle(S)` with `Open`/`Closed` markers, `read_h(close_h(h))` | **rejected**, E0601 `Expected "Handle(Open)", Given "Handle(Closed)"` |
| The same, reusing the old handle after `close_h(own(h))` on a `ref` handle | **rejected**, E0901 use of moved value |
| The same with a VALUE struct handle and a plain parameter | **accepted**: the old state stays usable (a copy) |
| `match` missing a variant | **rejected**, E0607 with the missing witness |
| use after `own(t)` move | **rejected**, E0901 |
| `parse(1);` discarding a `Result(i32, i32)` at statement position | **accepted silently** (rc=0, no warning) |
| `work(io);` discarding an unawaited `Impl(Future(i32, Io))` | **accepted silently** (rc=0, no warning) |
| recursive fn with `decreases(n)` whose call does not decrease | **refuted** at `decreases-step` |
| recursive fn without `decreases` | subset error "recursion (requires decreases(...) in the signature)" |
| `ensures(r == sq(x))` where `sq` has only `requires` | **refuted**: a call in a spec is opaque unless the callee has `ensures` |
| the same where `sq` has no contract | subset error "call to a callee without contracts" |
| a safe file: `ArrayList.set_len` after `pop` | **accepted**; reads the popped `11 22` and a popped `String`; **rc=139** under Guard Malloc with `--allocator system` |
| `unsafe.drop(s)` then `println(s)` in a safe file | **rejected**, E0901 |

The R2 encoding measurement (Z3 5.1.0, the verifier's preamble) is in
`backlog/ATS_STYLE_INDEXED_TYPES.md` R2 task 1. In short:
- both `define-fun-rec` and axiom + trigger prove one-step unfoldings;
- both return `unknown` on push / frame / swap until a lemma is supplied;
- with the lemmas, the axiom encoding proves all of them, `swap` included,
  while the recursive encoding fails `swap`.

## 2. The correspondence

| ATS | Yo today | Verdict |
| --- | --- | --- |
| Indexed types, `{n:nat}`, existentials | comptime `generic(N : usize)`, `refine`, the verifier (R1 landed) | done: `backlog/ATS_STYLE_INDEXED_TYPES.md` |
| `prfun` / `praxi` / `dataprop` (proofs as erased values) | `ghost`, `ghost_fn` (inlined; a recursive one is a subset error), `law`, `assumed()`, ghost `Seq`/`Multiset`/`Set` | **take the lemma layer** (§3 A1) |
| Termination metrics `.<n>.` and `.<m, n>.` | `decreases(M)` on functions and loops, mutual-recursion cliques (V6 task 4); one measure, no tuples | **take lexicographic measures** (§3 A5) |
| Effects on function types (`<>` pure, `<!ntm>` total) | spec calls see only a callee's `ensures`; the effects analysis exists (`src/evaluator/effects/`) but specs cannot use a function's body | **take spec-transparent pure functions** (§3 A3) |
| Linear types `vtype` / `absvtype` (must consume exactly once) | affine: `own` moves (E0901), E0907 for path-dependent moves, `Iso(T)`, RAII `Dispose`; no must-use | **take must-use, not linearity** (§3 A2) |
| `!T` (non-consuming parameters) | the default: parameters are read-only borrows; `inout`; borrow guards; `Pragma.StrictBorrow` | have |
| Views `T @ l`, safe pointer arithmetic by proof | a type-based gate: no raw pointer in safe code; the verifier does not model pointers | **take the proof-token idea for init** (§3 A4); a verified-unsafe std is §4 |
| `T?` / `@[T?][n]` (uninitialized, initialized by proof) | `MaybeUninit(T)`, definite-initialization E0903; `set_len` is ungated (the S1) | **take it** (§3 A4) |
| Typestate through indexed resources (`FILEptr(mode)`) | phantom comptime parameters work (E0601); sound only for `ref` + `own` handles | **document the idiom** (§3 A6) |
| `case+` / `case-` (exhaustive / partial with a warning) | always exhaustive (E0607); partial = explicit `_ => panic(...)` | have |
| `abstype` / `assume` | `_`-prefix privacy (E0405), `newtype`, `Impl(Trait)` | have |
| Flat `@(...)` vs boxed `'(...)` | value `struct`/`enum` vs `ref(...)`, `Box(T)` | have |
| Closures: `clo` (stack), `cloref` (GC), `cloptr` (linear heap) | `Impl(Fn)` (capture struct by value, no heap), `Dyn(Fn)` (RC'd) | have (no linear `cloptr`: RC frees it) |
| Templates, late-bound instantiation | comptime generics, per-specialization checking | have |
| `sif`, `#if` | comptime-known `cond`/`match` evaluate one branch, `comptime_assert` | have |
| `%{ ... %}` inline C, `$extfcall` | `c_include`, `extern`, `c_type`, `asm` | have what Yo wants (§5) |
| No GC required | non-atomic RC, cycle collector (off per type with `Acyclic`), explicit allocators, arenas | have (different model) |
| Linear values across exceptions | `Dispose` runs on the `unwind` path; handlers are second-class | have |

## 3. The plan: what to take

### A1. The lemma layer (ATS `prfun`), extending R2

Already R2 of the indexed-types plan. This audit ranks it first and pins
its shape from the measurement:
- a **lemma** is a `ghost_fn` returning `unit` with `requires` / `ensures`
  and a `decreases`;
- its body is checked once, by induction over the measure (the recursive
  call's `ensures` is the induction hypothesis);
- at each use, its `ensures` is emitted as a quantified axiom with a
  `:pattern` trigger.

std ships the frame and point-update lemmas for every list measure it
defines. Without them, `push`, `swap` and every inductive property is
`unknown`. Exit: the R2 fixtures (`dml_append_seq`, `dml_sorted_insert`,
`dml_member`) prove, and their twins refute.

### A2. Must-use results (the part of linearity Yo lacks)

ATS forces a linear value to be consumed. Yo stays affine but should reject
the one drop that is almost always a bug: an expression **statement** whose
value is a `Result`, or a `Future` that is neither awaited nor bound. Both
are measured silent today. Proposal:
- a std marker trait `MustUse` implemented by `Result(T, E)` and by the
  future types;
- `yo check` rejects a statement-position expression whose type implements
  it, with the fix spelled out: `_ := e` to discard on purpose, `?`/`match`
  to handle it, `io.await(...)` for a future;
- `Option` is deliberately NOT `MustUse` (dropping a `pop()` result is
  idiomatic).

Cost: an evaluator check in the statement walk (`src/evaluator/exprs/begin.yo`,
beside the unused-variable warning) plus a sweep of std/src/tests for
statements the rule rejects. Measure the sweep before deciding error vs
warning. A warning channel exists for unused variables. Seed gate: std may
use `_ :=` today, so the sweep needs no seed; only the new diagnostic does.

### A3. Spec-transparent pure functions (ATS effect annotations)

In ATS a total, pure function (`-<>`, `:<!ntm>`) can appear in proofs. In
Yo a spec sees only a callee's `ensures`, so `ensures(r == sq(x))` is
refuted even when `r = x * x` (measured). The only transparent spec
functions are `ghost_fn`s, so users must write each helper twice.
Proposal: a runtime function whose body is in the verifier subset, whose
effects analysis says pure (no I/O, no mutation of arguments, no
unwind/effect use), and which terminates (non-recursive, or recursive
with `decreases`) is **unfolded** when called from a contract. It becomes
a defining axiom, like A1's lemmas, capped at one unfolding per call. A
function that is not all three stays opaque, as today, with a message
naming the missing property. Depends on A1's axiom machinery.

### A4. A proof token for initialization (ATS `T?` + views): fixes an S1

`issues/fixed/safe-code-reaches-freed-memory-through-arraylist-set-len.md`.
ATS claims a region is initialized only by presenting its view. Yo can
get the same with the gate it already has, which is type-based: a
value that carries a raw pointer is unavailable in safe code. Growth
needs a token only unsafe code can hold:
- `spare_capacity(self) -> Option(*(T))`, not `RawSlice(T)`: the value gate
  catches a pointer and an enum wrapping one, but not a struct that contains
  one. A `RawSlice` token was measured passing through safe code;
- `assume_init(self, n, spare : *(T))`;
- `set_len` goes away in favor of the safe `truncate`;
- `std/io/index.yo` (the only caller) switches.

Cost: small, std only, plus a `comptime_expect_error` test. Do it first:
it is a live memory-safety hole, unrelated to the verifier.

### A5. Lexicographic termination measures (ATS `.<m, n>.`)

Found by the survey: `plans/backlog/FORMAL_VERIFICATION.md` promises tuple
measures, while `docs/en-US/FORMAL_VERIFICATION.md` says "no lexicographic
tuples". The same plan's D12 says recursion without `decreases` gets
partial correctness, yet the verifier makes it a subset error (probed
above). Take lexicographic `decreases(a, b)`: the step obligation is
`a' < a ∨ (a' = a ∧ b' < b)`, with non-negativity per component. That
covers Ackermann-shaped and nested-loop recursion. Then reconcile D12 with
the code: keep the subset error (it is the honest, loud choice) and
correct the plan.

### A6. Typestate as a documented idiom (ATS indexed resources)

Measured: phantom comptime parameters give typestate today, but it is only
sound when the handle is a `ref` type passed with `own(...)`. The move makes
the old state unusable (E0901). A value-struct handle is copied, so the
closed state is still readable. Document the idiom with that rule in
`docs/*/DESIGN.md` (both languages). Fix the open phantom-enum method
lookup (`issues/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`,
S3), which is the one thing standing in its way. std adoption (`File`,
sockets) is **not** proposed: those handles alias by design (RC), and
runtime state already guards them.

## 4. Later: verified unsafe std (ATS's headline, the long form)

ATS's promise is low-level code proved safe: pointer arithmetic under
views. Yo's `std/collections/array_list.yo` bodies are `assumed()`; their
contracts are trusted and checked at runtime, never proved. A raw-buffer
model would let the verifier prove those bodies instead: capacity, an
initialized prefix, and element ownership over the R1 contents array.
That is a heap/pointer model, which open question 1 of
`FORMAL_VERIFICATION.md` deliberately defers. Revisit after A1 and A4:
A4's token is exactly the view that model would reason about.

## 5. Not taken, and why

- **Linear types, and a type-level view language** (`vtype`, `T @ l` as
  types). Already decided: RC + `Dispose` + `own` is the memory model.
  "Use after move" confusion is the stated cost
  (`plans/backlog/FUTURE_ORIGINS.md`; `plans/reference/MEMORY_SAFETY.md`
  rejects `&T` and per-function `unsafe fn`). A2 and A4 take the two
  benefits that do not need linearity.
- **`dataprop` / user-declared index sorts.** Rejected in the indexed-types
  plan; A1's lemmas over ghost values cover what they are used for.
- **Linear closures (`cloptr`).** `Impl(Fn)` already has no heap and no
  RC; `Dyn(Fn)` is freed by RC. There is nothing a must-free closure adds.
- **Inline C (`%{ ... %}`).** `c_include` + `extern` + `c_type` cover FFI,
  and an inline C block would bypass the safe-mode gate and the
  cross-target story. A real need should come with a use case.
- **Interactive proofs / tactics.** Rejected in `FORMAL_VERIFICATION.md`.
  A1 keeps proofs as ordinary Yo lemmas discharged by Z3.
- **`case-` (a partial match with a warning).** An explicit
  `_ => panic(...)` says the same, loudly.

## 6. Order and cost

| Item | Depends on | Size | Why this order |
| --- | --- | --- | --- |
| A4 init token (fixes the S1) | — | 1–2 days | a live safe-code memory hole |
| A2 must-use | — | 3–5 days incl. the sweep | measured silent bugs, no verifier work |
| A6 typestate idiom | the S3 phantom-enum fix | 1 day + that fix | docs; the idiom already works |
| A5 lexicographic `decreases` | — | 2–3 days | small verifier change, reconciles two docs |
| A1 lemma layer (R2) | R1 (landed) | 3 weeks | the largest payoff, the largest cost |
| A3 spec-transparent pure fns | A1's axioms | 1–2 weeks | removes the write-it-twice tax |
| §4 verified unsafe std | A1, A4, a heap model | open | the long form of ATS's promise |

## 7. Sources

- Hongwei Xi, *Applied Type System* (TYPES 2003), and *Introduction to
  Programming in ATS* (ats-lang.org): views, `vtype`, `T?`, `prfun`,
  effect annotations, termination metrics, `case+` / `case-`, closure
  kinds.
- Zhu, Xi, *Safe Programming with Pointers through Stateful Views*
  (PADL 2005): at-views as proofs of memory ownership.
- In-tree: `backlog/ATS_STYLE_INDEXED_TYPES.md`, `DEPENDENT_TYPES_POSITION.md`,
  `FORMAL_VERIFICATION.md`, `plans/reference/MEMORY_SAFETY.md`,
  `plans/backlog/FUTURE_ORIGINS.md`, `plans/reference/MATCH_PATTERN_MATCHING.md`,
  `docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`,
  `docs/en-US/ISOLATED.md`, `docs/en-US/CYCLE_COLLECTION.md`.
