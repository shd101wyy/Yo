# `ref` reference semantics — unify `object`, extend to enums, free `ref`→`inout`

Status: PLANNED (design agreed 2026-06-27). Large, multi-phase, both compilers.

## 1. Motivation

Today reference semantics is a **struct-only**, bespoke concept:

- `object(…)` → `StructType { isReferenceSemantics: true }` (heap handle, shared,
  RC-managed, mutate-in-place).
- `atomic(object(…))` → also `isAtomicRc: true` (thread-safe RC, e.g. `String`,
  `imm/*` persistent nodes).
- Enums are **value-only** (tagged unions, copied).
- `ref` is the keyword for *second-class references*: the `ref(name) : T`
  parameter convention (`-> ref(T)` returns are banned).

This proposal makes reference semantics a single, orthogonal, composable type
constructor `ref(...)` that works over **both** struct and enum literals, freeing
the `ref` keyword from the parameter convention (which becomes `inout`):

| Today                         | After                          |
| ----------------------------- | ------------------------------ |
| `object(struct fields…)`      | `ref(struct(fields…))`         |
| `atomic(object(fields…))`     | `atomic(ref(struct(fields…)))` |
| *(no reference-semantics enum)* | `ref(enum(variants…))`       |
| *(no atomic reference enum)*  | `atomic(ref(enum(variants…)))` |
| `ref(name) : T` (parameter)   | `inout(name) : T`              |

### Why now — this is also the principled fix for the P1 self-host wall

The remaining ~43 P1 stage-2 transpile markers are **all** the recursive-enum
"self-shell" family (`TypeValue.clone`, `AstExpr.clone`, supertrait search over
`TypeValue`, boxed `(self.*).clone()`). Root cause: **value** enums cannot mutate
`Self` in place during recursive construction, so the port uses a one-level
self-shell placeholder + id/registry interning (memory
`yo-self-typevalue-enum-interning`). After many sessions and 9+ failed fix
attempts that approach has **not converged**.

The TS reference compiler models `TypeValue`/`AstExpr`/`EvalValue` as **mutable
JS objects** (reference semantics, patched in place). `ref(enum(…))` lets the
self-hosted port mirror TS directly: a recursive type is a heap handle whose
recursive field is patched to point at the same handle — no value-copy shell, no
interning dance. **This supersedes the `yo-self-typevalue-enum-interning`
decision deliberately**, because the interning approach has proven to be a wall.
Phase 4 (rephrasing the bootstrap's recursive enums) should collapse most of the
43 markers.

## 2. Design

### 2.1 `ref(…)` — reference-semantics type constructor (inline literals only)

`ref(X)` is legal **only** when `X` is an inline `struct(…)` or `enum(…)` type
literal. It produces the corresponding `StructType`/`EnumType` with
`isReferenceSemantics: true`. `ref(SomeNamedType)` and `ref(value)` are **errors**
(keeps the type-vs-borrow distinction unambiguous, matches how `object(…)` works
today).

Self-recursive positions use `Self` (Yo has no forward references — the binding
name is not in scope yet while its own definition is being evaluated):

```rust
Node :: ref(struct(value : i32, next : Option(Self)));   // was: object(...)
Tree :: ref(enum(Leaf(i32), Branch(Self, Self)));        // new capability
```

### 2.2 `atomic(…)` — atomic reference counting (inline `ref(…)` only)

`atomic(Y)` is legal **only** when `Y` is an inline `ref(struct(…))` /
`ref(enum(…))`. It sets `isAtomicRc: true` (thread-safe RC).

```rust
String :: atomic(ref(struct(_ptr : ?*(u8), _len : usize, _capacity : usize)));
SharedTree :: atomic(ref(enum(Leaf(i32), Branch(Self, Self))));   // Self, not the binding name
```

### 2.3 `inout(name) : T` — the (renamed) parameter convention

`ref` as a *parameter / reference binding* is renamed to `inout`:

```rust
push :: (fn(inout(self) : ArrayList(T), x : T) -> unit)({ … });   // was ref(self)
```

- The only supported form is the **parameter** `inout(name) : T`.
- `inout(name) := expr;` (local lvalue borrow) is **NOT** supported (the `ref`
  keyword's doc comment mentions a `ref(name) := expr;` local binding; per design
  it is unsupported — Phase 1 verifies it has no live usages and removes the
  mention).
- Returning `inout` remains **banned** (as `-> ref(T)` is today).

After this, `ref` no longer appears in binding position anywhere, so `ref(…)`
unambiguously means the reference-semantics type constructor.

### 2.4 Semantics of `ref(enum(…))`

Mirror `object` (`ref(struct)`) semantics, lifted to enums:

- **Allocation/identity:** heap-allocated, RC-managed handle. Copying the handle
  shares the underlying enum (refcount bump), same as objects.
- **Pattern matching:** `match` on a `ref(enum)` **borrows** the handle (does not
  consume it — you may match the same value again); variant bindings borrow the
  active variant's fields (value fields copy, `ref`/object fields share). This is
  the enum analogue of object field access — distinct from value-enum `match`,
  which moves/copies out of the scrutinee.
- **Mutation:** a `ref(enum)` can be re-assigned to a different variant in place;
  all handles observe the change (reference semantics). (Value enums cannot.)
- **Recursive construction (replaces the self-shell):** allocate the handle, then
  set its recursive field(s) to the same handle / a forward handle — the patch
  mutates in place. No value-copy shell, no `__self_shell` placeholder.
- **Equality / derived traits:** `derive(Eq/Clone/ToString)` traverse the variant
  fields structurally (same as objects), **not** by pointer identity.
- **Effect-row / TypeValue parity:** Phase 4 rephrases the bootstrap's recursive
  enums to `ref(enum)`; their construction/cloning then mirrors TS objects.

### 2.5 Cycle handling (QuickJS-style collector)

Yo's runtime already has a QuickJS-style RC cycle collector. Rules (confirmed
with the design owner):

- **Non-atomic `ref(enum(…))`:** participates in cycle collection — recursive
  cycles are **reclaimed, not leaked**. Extend the codegen-c.ts:159 pre-scan
  (`needsCycleGC`) and `canTypeFormRcCycle` to traverse **enum variant field
  types** (today they only walk struct fields), and emit the GC `__yo_ref_header_t`
  fields + scan/collect hooks for cyclic ref-enums.
- **`atomic(ref(…))`:** cycles are **disallowed** (the existing restriction for
  atomic objects). Extend that prohibition/check to `atomic(ref(enum(…)))`.
- **Derived-trait termination:** derived `Clone`/`Eq`/`ToString` over a *cyclic*
  ref-enum must not infinitely recurse (the collector reclaims memory, not
  traversal termination). Reuse the existing cycle-guard pattern (cf. the
  `TraitT` clone cycle guard, task #20 / `yo-self-substitute-cycle-guard`) for
  derived traversals on reference-semantics enums.

## 3. Type-system changes (TS reference compiler first)

- `EnumType` (`src/types/definitions.ts`): add `isReferenceSemantics: boolean`
  and `isAtomicRc?: boolean`, mirroring `StructType`. Update the enum creator
  (`src/types/creators.ts`) to thread them.
- Guards (`src/types/guards.ts`): generalize `isObjectType`/`isAtomicObjectType`
  to cover enums, or add `isReferenceEnumType`/`isAtomicReferenceEnumType`; update
  `usesReferenceSemantics` (guards.ts:~280) to include reference enums.
- Compatibility (`src/types/compatibility.ts`): a `ref`/value mismatch on the same
  underlying shape is incompatible (mirror struct `isReferenceSemantics` handling)
  — a `ref(enum)` is not interchangeable with the value `enum`.
- Parser (`src/parser.ts`) + keywords (`src/expr.ts`):
  - Add `inout` keyword; route the parameter-modifier parsing from `ref` → `inout`.
  - Repurpose `ref` as the type constructor: `ref(struct(…))` / `ref(enum(…))`,
    inline-literal-only (error otherwise).
  - `atomic(…)`: restrict its operand to an inline `ref(…)` (error otherwise);
    keep producing `isAtomicRc`.
  - Keep `object` as a **deprecated alias** for `ref(struct(…))` during Phase 2,
    then remove in Phase 2's cleanup.
- Codegen (`src/codegen/`): enum type emission, RC header/inc/dec, dispose, and the
  cycle-GC scan must handle reference-semantics enums (today only ref structs get
  RC headers + cycle GC). Value enums are unchanged.

## 4. Staged rollout (each phase gated by `scripts/diff-test.sh tests/codegen-bootstrap` + `check ./std` + targeted tests)

**Phase 1 — `ref` → `inout` rename (mechanical, both compilers).**
- TS: add `inout` keyword, move the parameter-modifier parsing/eval/codegen from
  `ref` to `inout`; verify/remove the unused `ref(name) := expr` local-binding
  form; keep `-> ref`/`-> inout` banned.
- Migrate all `ref(name) : T` → `inout(name) : T` in `std/`, `tests/`, `yo-self/`,
  `src/tests/`.
- Port the same to `yo-self/` evaluator/codegen.
- Gate: corpus 83/83, `check ./std`, full evaluator test suite.

**Phase 2 — `ref(struct(…))` ≡ `object(…)`; deprecate `object`.**
- TS: parse `ref(struct(…))` to the reference-semantics `StructType`; make
  `object(…)` a deprecated alias emitting a one-line deprecation note.
- Migrate `std/`, `yo-self/`, `tests/` `object(…)` → `ref(struct(…))` and
  `atomic(object(…))` → `atomic(ref(struct(…)))`.
- Remove the `object` keyword after migration; update the lexer/parser/evaluator
  + the yo-self port.
- Gate: corpus 83/83, `check ./std`, runtime suite (object-heavy: `imm/*`, String).

**Phase 3 — reference-semantics enums + `atomic` composition (the new capability).**
- TS: `EnumType.isReferenceSemantics`/`isAtomicRc`; parser `ref(enum(…))` /
  `atomic(ref(enum(…)))`; codegen RC headers + dispose + cycle-GC scan over enum
  variants; `match`/mutation/equality semantics per §2.4; atomic-no-cycle check.
- Port to `yo-self/`.
- Add tests (§6): construction, recursive cycles (collected), atomic (cycle
  rejected), match-borrow, in-place variant reassignment, derived traits.
- Gate: corpus + `check ./std` + new ref-enum tests; ASan run on the cyclic-enum
  test to confirm the collector reclaims (no leak, no UAF).

**Phase 4 — rephrase the bootstrap's recursive enums to `ref(enum(…))` (the payoff).**
- Convert `TypeValue`, `AstExpr`, `EvalValue` (and any other recursive
  `yo-self/` enums that drive the self-shell) from value `enum` to `ref(enum)`.
- Delete the self-shell machinery they needed (`__self_shell`, `resolve_enum_shell`
  use-sites, the one-level patch dance) where it becomes dead; recursive
  construction now patches the handle in place.
- Re-measure the full stage-2 self-compile marker count (expect the self-shell
  cluster — most of the 43 — to drain).
- Gate: corpus 83/83, `check ./std`, full self-compile marker delta, the heavy
  `yo-self/tests` sweep where feasible.

## 5. Docs to update (after the migration that touches each)

- `.github/instructions/yo-syntax.instructions.md`,
  `.github/instructions/yo-design.instructions.md` — `inout` param convention;
  `ref(struct/enum(…))` / `atomic(ref(…))` reference semantics; `object` removed.
- `.github/skills/yo-syntax/syntax-cheatsheet.md`,
  `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md` — same.
- `docs/en-US/` **and** `docs/zh-CN/` — reference-vs-value types, the new
  constructors, the `inout` convention (current-language description only, no
  before/after sections).
- `AGENTS.md` / `CLAUDE.md` if they reference `ref`/`object` semantics.
- Update memories: supersede `yo-self-typevalue-enum-interning`; note `inout`
  rename in `yo-unwind-not-escape`-style keyword notes if relevant.

## 6. Tests to add / update

- Rename-driven: every `ref(name):T` test → `inout(name):T`; add a
  `comptime_expect_error` test that `ref(name):T` (old param syntax) is rejected
  and that `inout` cannot be returned.
- `ref(struct(…))` parity with the old `object` tests; `object(…)` rejected after
  removal (`comptime_expect_error`).
- `ref(enum(…))`: heap identity/sharing; `match` borrows (re-match works);
  in-place variant reassignment observed through another handle; recursive enum
  built + a cycle formed and **collected** (ASan-clean); `derive(Eq/Clone/ToString)`
  structural + cycle-guarded.
- `atomic(ref(enum(…)))`: cross-thread share; a cycle is **rejected** at
  compile time (`comptime_expect_error`).
- `ref(NamedType)` / `ref(value)` / `atomic(non-ref)` rejected
  (`comptime_expect_error`).

## 7. Risks / open items

- **Scope:** large, in both compilers + std + bootstrap. Phases are independently
  shippable and corpus-gated; keep each phase a separate commit series.
- **Cycle-GC over enums:** the pre-scan + collector currently walk struct fields
  only; extending to enum variants (active-variant traversal) is the subtlest
  runtime change — validate with ASan + the QuickJS-style collector's existing
  tests.
- **Derived-trait termination on cyclic ref-enums:** must reuse cycle guards;
  otherwise `Clone`/`Eq`/`ToString` infinite-loop on graphs.
- **Bootstrap rephrase (Phase 4):** changing `TypeValue`'s value/reference nature
  touches comparison, cloning, and the interning registry — done last, after the
  language feature is solid in both compilers, so the self-host fixpoint isn't
  destabilized mid-feature.
- **`inout` for local borrows:** explicitly out of scope (not supported); if a
  future need arises, it is a separate proposal.

## 8. Relationship to in-flight P1 work

This pauses the per-marker P1 grind (43 markers, all self-shell) in favor of
fixing the root representation. The committed `array_list` variadic-macro fix
(47→43) stands. After Phase 4, re-baseline the marker count; the residual (if any)
returns to the per-cluster drain.
