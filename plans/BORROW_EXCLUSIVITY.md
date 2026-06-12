# Borrow Exclusivity v3 — declared `mut` parameters + call-site exclusivity law

Status: **APPROVED DESIGN, IMPLEMENTATION HANDOFF** (2026-06-12).
Supersedes v2 (inferred summaries) and v1 (dynamic borrow counter) — see
the appendix for the history and why they were superseded. Companion:
`issues/flowability-growth-invalidation-method-calls.md` (the residual
this design closes) and the landed same-scope gates (commit 8b0b67b1).

**Owner constraints this design satisfies:** maximize static checking;
ZERO runtime checks/overhead (perf target 0–15% of C); keep the language
simple and LLM-friendly.

This document is written for an implementing agent. Follow
`AGENTS.md` + `.github/instructions/` (especially
`yo-syntax.instructions.md`, `testing.instructions.md`). Standing rules
that apply to EVERY phase below:

- Every TS evaluator change must be mirrored 1:1 in yo-self (same logic,
  same order of checks, same error text).
- `./yo-cli fmt <file>` every `.yo` file you create or modify.
- Run the validation gates listed in each phase before committing.

---

## Part I — Language design

### 1. The parameter convention family

Yo parameter conventions are DECLARED (not inferred). The receiver
`self` is a parameter like any other.

```rust
f :: (fn(
  a : T,          // DEFAULT: immutable access (Hylo `let`). The body may
                  // read a but may not mutate the object a refers to.
  mut(b) : T,     // may mutate the object's CONTENTS (Hylo `inout`-as-mutation)
  own(c) : T,     // consumes the caller's handle (Hylo `sink`); implies mut
  ref(d) : T,     // existing second-class reference (write-back lvalue);
                  // unchanged semantics; mut(ref(x)) is an ERROR (redundant/conflict)
) -> unit)(...)
```

Scope: the immutability rule and the exclusivity law apply to
**RC object-typed parameters only** (`object` types — ArrayList, String,
HashMap, user objects). Value types (`struct`, scalars, `str`) are
copied or immutable by construction; they are exempt from every check in
this document. Note that parameter BINDING reassignment (`a = v` where
`a` is a param) is ALREADY rejected today unless the param is `ref`
(`isReassignable: parameter.isRef`, `src/evaluator/calls/helper.ts:581`)
— v3 adds nothing there. v3 is exclusively about INTERIOR mutation of
the referenced object.

`mut` vs the existing `inout`: `inout(x)`/`ref(x)` means "may reassign
the caller's *binding*" (slot write-back, lowered to `T*` in C). `mut(x)`
means "may mutate the *object's contents*" through a normal by-value
handle. Different axes; the docs phase must state this distinction.

### 2. What "immutable parameter" means (definition-site rules)

For an immutable object parameter `p`, the body may not:

1. **Write a field** rooted in `p`: `p.f = v`, `p.f.g = v`.
2. **Call a `mut(self)` method** on `p`: `p.push(v)`.
3. **Pass `p` into a `mut`/`own` parameter position** of any call
   (including as receiver).
4. **Mutate through an alias**: `q := p; q.push(v)` — aliases of `p`
   (the existing alias-group machinery, `isOwningTheSameRcValueAs`)
   inherit the restriction. Closure captures of `p` are aliases too.
5. **Store `p` into a global or into an object field**
   (`g = p`, `h.f = p`) — storing creates an unrestricted alias the
   checker cannot follow; it requires `mut(p)` (conservative escape
   rule). **Returning `p` is allowed** (mutation can then only happen
   after the call completes, which is safe for the law).

Everything else is allowed: reads, non-mut method calls, passing `p` to
immutable positions, comparisons, printing.

**Immutability is DEEP (transitive), and rules 1–5 apply to DERIVED
handles as if they were `p` itself.** A handle is *derived from `p`*
when it is bound from: a direct alias (`q := p`); a field read at any
depth (`xs := p.array_list`, `xs := p.a.b`); or the return value of a
method/function call whose receiver or argument chain roots in a derived
handle — EXCEPT when the callee is **returns-fresh** (§4: its return
value is a new allocation, e.g. `.clone()`), which BREAKS the chain.
Without depth, one field extraction would launder any interior mutation
(`xs := data.array_list; xs.push(v)` mutates `data`'s reachable state).
The idiom for "modify what I was given, without `mut`" is therefore
always *copy, then mutate*:

```rust
process :: (fn(data : Data) -> unit)({
  xs := data.array_list;          // derived from immutable `data`
  xs.push(v);                     // ERROR: mutates data's interior
  xs = other_list;                // OK: rebinding the LOCAL binding is free
  ys := data.array_list.clone();  // returns-fresh breaks the chain
  ys.push(v);                     // OK: your own copy
});
```

Note the asymmetry is binding-vs-object: the local BINDING `xs` stays
reassignable (locals are mutable, §7); only the OBJECT it refers to
inherits `data`'s convention. `mut(data)` is deep in the same way:
it permits interior mutation through any derived handle.

### 3. The call-site exclusivity law

> **At every call, the argument bound to each `mut` or `own` parameter
> must be provably a distinct object from every other object argument in
> the same call** (including the receiver).

This is Hylo's Law of Exclusivity. The crucial property: checking is
**purely local — no summaries, no obligation propagation**. The
induction that makes this work:

- To pass its own parameter `y` into a `mut` position, a function `g`
  must itself declare `mut(y)` (rule 3 above).
- Therefore every CALLER of `g` proves `y`'s argument distinct from all
  other arguments.
- Therefore inside `g`, the pair (`x`, `y`) where `y` is `mut` may be
  ASSUMED distinct. The proof obligation discharges itself one level up,
  at every level, terminating at fresh allocations in `main`/top-level.

```rust
copy_first :: (fn(mut(dst) : ArrayList(String), src : ArrayList(String)) -> unit)({
  ref(e) := src.project(usize(0));
  dst.push(e.clone());
});

a := ArrayList(String).new();
b := ArrayList(String).new();
copy_first(a, b);   // OK: two distinct fresh allocations
copy_first(a, a);   // ERROR: `a` passed as both mut(dst) and src

g :: (fn(x : ArrayList(String), mut(y) : ArrayList(String)) -> unit)(
  copy_first(y, x)  // OK inside g: y is mut in g's signature, so every
);                  // caller of g already proved x ≠ y  (the induction)
g(a, a);            // ERROR: resolved HERE, at the birth scope
```

**Distinctness proofs** (in order of attempt):

1. *Same variable / same alias group* → immediate, precise ERROR.
2. *Two distinct fresh roots* → provably distinct (two separate
   allocations are different objects forever; later escapes do not merge
   objects). "Fresh root" defined in §4.
3. *Parameter-vs-parameter of the current function, where at least one
   is `mut`/`own` in the current signature* → distinct by the induction.
4. *Fresh-and-never-escaped vs anything* → distinct (no heap path can
   have aliased it).
5. Otherwise → **compile error**: "cannot prove these arguments refer to
   distinct objects" + the copy-out workaround in the message.

Case 5 is the honest residue (e.g. two handles pulled out of a
`HashMap`). It is REJECTED, never runtime-checked. If this proves too
strict in practice, the v1 dynamic borrow counter (git history of this
file, commit e7507f7c) can be revived ONLY at statically-unproven sites.

### 4. Fresh-allocation roots

A variable is a **fresh root** when bound by `:=` to:

- a direct object construction (`Holder(s : ..., n : ...)`), or
- a call to a function that *returns fresh* — defined bottom-up: every
  return-position value of the function is itself a direct construction
  or a call to a returns-fresh function. Memoized per specialized
  `funcId` (the evaluator specializes per call site, so this sees
  concrete callees). Anything else (returns a param, a global, a field
  read, a conditional mix) → not returns-fresh, conservatively.

This makes `ArrayList(String).new()` a fresh root (its body returns a
construction). Freshness lives on the alias-group ROOT; rebinding a
variable to a non-fresh source moves it to that source's group (existing
machinery). A separate **never-escaped** bit is cleared when the
variable (or any group member) is stored into a field/global or passed
as ANY call argument (conservative — callees may store it; only proof
rule 4 needs this bit, and rule 2 covers the common cases without it).

### 5. Trait signatures, dyn dispatch, and variance

- Trait method signatures declare `mut(self)` (and `mut` params) like
  any function. `dyn` dispatch reads effects from the TRAIT signature —
  exact, no pessimism.
- Conformance variance: an impl may be LESS mutating than the trait
  (trait `mut(self)`, impl plain `self` → OK), never MORE (trait plain
  `self`, impl `mut(self)` → ERROR). Same rule for function-value
  compatibility: a fn type with a `mut` param accepts an actual fn whose
  corresponding param is non-mut; the reverse is rejected.
- Std traits that will need `mut(self)`: `Iterator.next` is the big one;
  audit all traits in `std/` during migration.

### 6. Refinement of the existing same-scope gates

The landed freeze-while-borrowed gates (commit 8b0b67b1) currently
reject ANY method call / call-argument use of a borrowed source, because
mutation was signature-invisible. With declared conventions they refine
to: **only `mut`/`own` uses invalidate**. `xs.len()` while `ref(e) :=
xs.project(0)` lives becomes LEGAL. This subsumes and replaces the old
Option C (`readonly(self)`).

### 7. Non-goals (recorded decisions — do NOT implement)

- **No `mut` for local variables.** `x := 12` stays mutable;
  `mut(x) := 12` is not introduced. Rationale: locals have no
  abstraction boundary — the compiler sees every use, and the borrow
  gates already reject the only dangerous mutations (while borrowed).
  Local `mut` would buy zero soundness, overload the keyword with a
  second meaning (rebinding vs interior mutation), and drown the most
  common imperative patterns (accumulators, builders) in annotations.
- **No `mut` for comptime bindings** (`x :: 12`), same rationale; CTFE
  accumulator loops would be the worst hit.
- **No `let`/`var` binding keywords.** The language rule stays one
  sentence: *mutability is declared at function boundaries and free
  inside them.*
- **No runtime checks.** Ever, in this design.

---

## Part II — Implementation plan

Phases are ordered; each ends with validation gates + a commit. Do not
reorder 1→4 (the migration needs the warn-mode checker; the error flip
needs the migration). 5–7 build on 4.

### Canonical validation gates

```bash
# G1 — TS build + evaluator unit tests (457 expected)
bun run build && bun test src/tests/fixme.test.ts --timeout 10000

# G2 — evaluator-only checks (fast)
./yo-cli check ./std          # 152/152 expected at baseline
./yo-cli check ./tests        # baseline: all pass except known fixtures

# G3 — targeted codegen tests (always --parallel 1 for single files)
./yo-cli test ./tests/ref_binding.test.yo --bail -v --parallel 1
./yo-cli test ./tests/ref_borrow_invalidation.test.yo --bail -v --parallel 1
./yo-cli test ./tests/ref_field_borrow.test.yo --bail -v --parallel 1
./yo-cli test ./tests/ref_params.test.yo --bail -v --parallel 1
./yo-cli test ./tests/fn.test.yo --bail -v --parallel 1
./yo-cli test ./tests/trait.test.yo --bail -v --parallel 1

# G4 — yo-self build + sweeps (~12-15 min build; NO --release)
./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin &> /tmp/yoself_build.log
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./std     # 152/152
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./tests   # 143/145 (2 circular_error_{a,b} = baseline)
YO_MAIN_STACK_MB=4096 /tmp/yo-self-bin check ./yo-self # 237/237
# Classify yo-self-bin results by EXIT CODE (0 pass, 1 eval error, 138/139 crash).

# G5 — full integration suite (~30 min; run at phase milestones 4, 7, 9)
./yo-cli test --bail
```

Save verbose output to files (`&> out.txt`) to avoid truncation. CI must
be green after each push (`gh run list --branch feat/slice-rework`).

### Phase 1 — parse and represent `mut` (no enforcement yet)

**TS:**

1. `src/expr.ts` — add `mut: ["mut"]` to `BuiltinKeywords` (next to
   `ref` at ~line 659), with a doc comment: parameter modifier, interior
   mutation permission.
2. `src/evaluator/types/function.ts:258–297` — alongside the existing
   `own`/`ref` wrapper extraction, recognize
   `exprIsFunctionCallOf(lhsExpr, BuiltinKeywords.mut)`:
   - arity must be 1 (same error shape as `own`);
   - `mut` + `ref` on one param → error
     `"mut" cannot be combined with "ref"/"inout" — a ref parameter is a write-back reference already`
     (mirror the existing own+ref conflict at lines 279–283);
   - `mut` + `own` → error `"own" already implies mutation permission; drop "mut"`;
   - set a new local `isMutable = true`, unwrap `lhsExpr = lhsExpr.args[0]!`.
3. `src/types/definitions.ts` — add to `FunctionParameter`
   (lines 383–431): `isMutable?: boolean;` with a doc comment defining
   §2 semantics. Grep every site that CONSTRUCTS `FunctionParameter`
   objects (`/usr/bin/grep -rn "isOwningTheRcValue:" src/types src/evaluator --include="*.ts"`)
   and thread the field where parameters are built or cloned
   (substitution/specialization paths usually spread-copy — verify each).
4. `src/types/compatibility.ts` — function-type compatibility: expected
   param `isMutable` true accepts actual false; expected false rejects
   actual true (variance, §5). Trait-impl conformance flows through the
   same comparison — verify with a trait test in step 6.
5. Binding: `src/evaluator/calls/helper.ts:565–584` — when creating the
   parameter `Variable`, pass a new field `isMutableParam:
   parameter.isMutable || parameter.isOwningTheRcValue || undefined`.
   Add `isMutableParam?: boolean` to `Variable` in `src/env.ts`
   (next to `isParameter` at ~line 149), documented.

**yo-self mirrors (1:1):**

6. `yo-self/evaluator/types/function.yo:764–793` — add the `mut`
   extraction with identical ordering/arity/conflict errors. Check how
   `BK_REF` is defined (token.yo / expr-keyword table) and add `BK_MUT`
   the same way.
7. `yo-self/types/definitions.yo` — add `param_is_mut :
   ArrayList(bool)` parallel array to `Func` (mirror `param_is_ref`,
   lines ~105–112). **This touches every `Func(...)` construction
   site** — grep `param_is_ref` first to enumerate them (this is the
   exact precedent; follow how it was threaded).
8. `yo-self/types/compatibility.yo` — mirror the variance rule.
9. `yo-self/evaluator/calls/helper.yo:543–563` — parameter binding
   currently calls `add_variable_to_env` (hardcoded flags); the correct
   target is `add_parameter_to_env` (`yo-self/env.yo:620–673`), which
   already takes `is_ref`/`is_parameter`. Add an `is_mutable_param`
   field to `Variable` (`yo-self/env.yo:68–129` — grep
   `ref_borrowed_by` for the construction-site churn precedent) and a
   matching parameter on `add_parameter_to_env`; bind from
   `param_is_mut` (or own).

**Tests (this phase):** a new `tests/mut_param_syntax.test.yo` —
signatures with `mut(x) : T` and `mut(self) : Self` parse and run
(no enforcement yet, so bodies can mutate freely);
`comptime_expect_error` for `mut(ref(x))`, `mut(own(x))`, and wrong
arity. Prefer `comptime_expect_error` over TS gate tests (project
convention).

**Gates:** G1, G2 (must be unchanged — zero behavior change), G3
(fn/trait), G4. Commit: `evaluator: parse + represent the mut parameter
modifier (both compilers, no enforcement)`.

### Phase 2 — definition-site checker, WARN mode

Add a mode with three levels: `off | warn | error`. CLI flag
`--mut-check <mode>` on `check`, `compile`, and `test` in
`src/yo-cli.ts`, default **warn** for now (flips in Phase 4). Carry it
on the evaluator context (`src/evaluator/context.ts`, mirroring how
existing flags travel; yo-self `evaluator/context.yo` +
`calls/function_type.yo` construction sites — same pattern as
`is_evaluating_ref_binding_rhs`).

**The checks** (all gated on the variable being an RC object-typed
parameter with `isParameter && !isMutableParam && !isRef`, OR an alias
whose group root is one — reuse `aliasGroupRoot` / `collectAliasGroup`
from `src/evaluator/types/flowability.ts`; add a shared helper there:
`findImmutableParamRootForVariable(variable, env)`):

1. **Field write** — `src/evaluator/exprs/assignment.ts`: when the LHS
   resolves through property access whose base atom is (or aliases) an
   immutable param → violation `cannot assign to a field of immutable
   parameter "xs" — declare it "mut(xs) : T" if this function is meant
   to mutate it`.
2. **mut-method receiver / mut-argument** —
   `src/evaluator/calls/helper.ts` inside
   `tryToCallFunctionWithArguments`, in the binding loop (lines
   ~565–584), AFTER the callee's `FunctionType` is resolved: if
   `parameter.isMutable || parameter.isOwningTheRcValue` and the bound
   argument expr is an atom resolving to (or aliasing) an immutable
   param → violation `cannot pass immutable parameter "xs" to the
   mut parameter "dst" of "copy_first" — declare "mut(xs)" in this
   function's signature`. The receiver of a method call is args[0] of
   the `.` call and binds to `self` — the same loop covers it; the
   message should special-case `self` ("cannot call mut method "push"
   on immutable parameter "xs"...").
   Keep the existing exemptions VERBATIM from the borrow gates:
   compiler-synthesized uses (`expr.token.modulePath.startsWith("auto-generated://")`),
   RC internals (`___drop`/`___dup`/`___dispose`), and
   `context.isEvaluatingRefBindingRhs`.
3. **Escape** — `src/evaluator/exprs/assignment.ts` (store into a
   module-level variable or an object field where the RHS atom is an
   immutable param) and object-construction argument positions that
   store handles: violation `storing immutable parameter "xs" creates
   an untracked alias — declare "mut(xs)" or store a copy`. Returning
   is explicitly allowed — do not check return positions.
4. **Alias inheritance** is NOT a separate check — it falls out of
   `findImmutableParamRootForVariable` walking the alias group. Verify
   closure captures land in the group (test it; if captures bypass
   `isOwningTheSameRcValueAs`, extend the capture path in the closure
   machinery to link them — find it via
   `/usr/bin/grep -rn "capture" src/evaluator/calls/closure-type.ts`).
5. **Derived-handle marking (deep immutability, §2)** — in
   `src/evaluator/exprs/initialization-assignment.ts`, when `:=` binds
   from (a) a property-access chain whose base atom resolves to an
   immutable param or a derived/aliased handle of one, or (b) a call
   whose receiver/argument chain roots in one AND whose callee is NOT
   returns-fresh, set a new `Variable` field
   `derivedFromImmutableParam?: Variable` (pointing at the originating
   parameter; yo-self: `derived_from_immutable_param :
   Option(Box(Variable))` — construction-site churn precedent applies).
   `findImmutableParamRootForVariable` must then answer "yes" for: the
   param itself, alias-group members, and derived handles (follow the
   chain, cycle-capped). **The returns-fresh predicate is therefore
   needed HERE, not first in Phase 6** — implement it in this phase
   (in `src/evaluator/types/flowability.ts` as specified in Phase 6
   step 3) and let Phase 6 reuse it. Conditional RHS (`cond`/`match`
   mixing derived and non-derived branches) → derived if ANY branch is.

**Warn vs error mechanics:** one helper,
`reportMutViolation(context, token, message)` — `off` → no-op; `warn` →
print once (dedupe on `modulePath:line:col:message` in a `Set` on the
context — REQUIRED because trial-eval/specialization evaluates bodies
repeatedly) via `formatWarningMessages` (`src/error.ts:159`, currently
unconsumed — wire it to stderr); `error` → `throw formatErrorMessage(...)`.
yo-self mirror: same three-way helper, stderr printing, a dedup set on
the context object.

**Landmine:** in error mode the throw happens during body evaluation,
which trial-eval can swallow (this is the same position as the landed
borrow gates, which work — follow their precedent exactly; do not invent
a new error channel). In warn mode nothing throws, so overload
resolution is untouched — this is why migration happens under warn.

**Tests:** none yet beyond G1/G2 unchanged-behavior runs (warnings are
transitional; the durable tests come in Phase 4 as
`comptime_expect_error`). Manually verify warnings fire:
`./yo-cli check ./std --mut-check warn &> /tmp/mut_warnings_std.txt` and
eyeball a few known mutators (ArrayList.push).

**Gates:** G1–G4 (all numerically unchanged — warn mode must not alter
results). Commit.

### Phase 3 — migrate std → tests → yo-self (annotation sweep)

Use the warnings as the worklist. For each batch:
`./yo-cli check <dir> --mut-check warn &> /tmp/mut_<dir>.txt`, add
`mut(...)` exactly where reported, re-run until silent, `./yo-cli fmt`
every touched file, run that batch's gates, commit.

- **Batch A — `std/`** (gate: G1 + G2-std + G3 + a `./yo-cli test
  ./tests --bail` smoke at the end of the batch). Expected hot spots:
  `std/collections/array_list.yo` (push/insert/remove/set/clear/sort/
  reserve/...), `hash_map.yo`, `string.yo` (push_byte/push_str/...),
  buffers/io writers, and TRAIT signatures (`Iterator.next` →
  `mut(self)`; audit every trait — the variance rule means traits must
  declare the UNION of what impls need).
- **Batch B — `tests/`** (gate: G5 full suite). Test files mostly call
  rather than define, so expect a small batch.
- **Batch C — `yo-self/`** (gate: G4 sweeps + `./yo-cli check
  ./yo-self`). This is the largest batch (env mutators, registries,
  ArrayList-heavy evaluator code). Mechanical, warning-driven.
- **Batch D —** `src/tests/*.yo` scratch/fixture files and
  `docs/` code snippets that fail checks, if any.

Rule for annotating: add `mut` ONLY where a warning demands it (the
checker is the source of truth — no speculative annotations).

### Phase 4 — flip the default to `error`

1. Default `--mut-check` to `error` in `src/yo-cli.ts` (+ yo-self CLI
   mirror in `yo-self/main.yo`'s arg handling). Keep `warn`/`off`
   available for downstream migrations.
2. **The durable test battery** — new `tests/mut_param.test.yo` using
   `comptime_expect_error` (project convention) for: field write through
   immutable param; mut-method receiver; passing immutable param to a
   mut position; mutation through a local alias (`q := p; q.push(...)`);
   mutation through a DERIVED handle — field extraction
   (`xs := p.array_list; xs.push(v)`), nested depth (`xs := p.a.b`),
   and a non-returns-fresh method-return handle; mutation through a
   closure capture; store-into-global escape; store-into-field escape.
   Positives: reads + non-mut methods on immutable params; `mut` param
   mutating freely (including through derived handles — deep `mut`);
   `own` param mutating freely; returning an immutable param;
   clone-then-mutate (`ys := p.array_list.clone(); ys.push(v)` —
   returns-fresh breaks the derivation chain); REBINDING a derived
   local (`xs := p.f; xs = other` is legal — binding vs object); trait
   impl declaring non-mut where trait says mut. Negative: trait impl declaring mut where the
   trait says non-mut (variance).
3. Verify each negative FAILS before the enforcement existed (sanity:
   temporarily `--mut-check off`) and passes with it on.

**Gates:** G1–G5, CI green. Commit + push. **Milestone: the language now
has verified immutable-by-default parameters.**

### Phase 5 — refine the borrow-invalidation gates with declared effects

In `src/evaluator/calls/function.ts` (the gate added in 8b0b67b1) and
its yo-self mirror `yo-self/evaluator/calls/function.yo`: the freeze
currently fires on ANY receiver/argument use of a borrowed source.
Refine: fire ONLY when the bound parameter is `mut`/`own`. Note the
ordering problem: the current gate sits at `evaluateFunctionCall` entry,
BEFORE the callee type is resolved — the refined check needs
`FunctionType.parameters`, so MOVE the receiver/argument gate into
`tryToCallFunctionWithArguments`' binding loop (where Phase 2's check
#2 already lives — they become one check with two error messages: "while
borrowed" vs "immutable param"). Keep the reassign/move/alias gates
where they are (they don't need callee info). Keep all exemptions.

Update `tests/ref_borrow_invalidation.test.yo`: the
`method_call_while_borrowed` negative must now use a MUT method
(`push`); add a new positive — `xs.len()` and `xs.get(...)` while
`ref(e) := xs.project(...)` lives are LEGAL. Update
`docs/en-US/FLOWABILITY.md` + zh-CN in Phase 9.

**Gates:** G1–G4 (+ G3 ref battery especially). Commit.

### Phase 6 — fresh-allocation roots

1. `src/env.ts` `Variable`: add `isFreshAllocationRoot?: boolean` and
   `mayHaveEscaped?: boolean` (doc comments per §4). yo-self
   `env.yo` mirror (`is_fresh_allocation_root`, `may_have_escaped` —
   construction-site churn again; grep `ref_borrowed_by` precedent).
2. Set the fresh bit in
   `src/evaluator/exprs/initialization-assignment.ts` when the RHS is a
   direct object construction, or a call to a returns-fresh function.
3. **returns-fresh analysis** — ALREADY IMPLEMENTED in Phase 2 check #5
   (deep immutability needs it to break derivation chains); reuse it
   here. For reference, the spec: a memoized predicate keyed by
   specialized `funcId` (side-table, mirroring the default-args
   side-table precedent in yo-self) — walk the function's
   return-position exprs: construction → fresh; call → recurse (cycle →
   false); anything else → false. Place it in
   `src/evaluator/types/flowability.ts` next to the gate helpers;
   yo-self mirror in `yo-self/types/flowability.yo`.
4. Clear/avoid: a variable whose `:=` RHS is a param/global/field-read
   atom joins that group (existing) and is NOT fresh. Set
   `mayHaveEscaped` on a fresh variable when it (or a group member) is
   stored into a field/global or passed as any call argument — hook the
   same sites as Phase 2's checks #2/#3.

**Tests:** internal — exercised via Phase 7's positives (two fresh lists
accepted). No standalone test file needed.

**Gates:** G1–G4 unchanged. Commit (can be squashed with Phase 7).

### Phase 7 — the call-site exclusivity law

In `tryToCallFunctionWithArguments` (`src/evaluator/calls/helper.ts`,
same binding loop) + yo-self `calls/helper.yo`: after all argument
exprs are resolved against parameters, for every parameter `pj` with
`isMutable || isOwningTheRcValue` whose argument is an RC object,
check against EVERY other object argument `ai` (i≠j, including `self`):

1. same variable or same alias group (`aliasGroupRoot(ai) ===
   aliasGroupRoot(aj)`) → ERROR
   `"a" is passed to the mut parameter "dst" and also as "src" — a
   mut argument must not alias any other argument`;
2. distinct fresh roots → OK;
3. both are params of the CURRENT function and at least one is
   `mut`/`own` in the current signature → OK (the induction; the
   "current function's signature" is reachable from the context's
   current-function state — find it via how `recur` resolves the
   enclosing function, `src/evaluator/exprs/recur.ts`);
4. one side fresh && !mayHaveEscaped → OK;
5. otherwise → ERROR `cannot prove "h1" and "h2" refer to distinct
   objects ... — copy the element out ("h1.get(...)/clone()") or
   restructure so the mut argument is passed alone`.

Skip pairs where either side is not an atom-resolvable object variable
(temporaries/call results are unique by construction → OK), skip effect
params (`isEffectParam`), skip variadic packs' non-object members, and
keep the standard exemptions (auto-generated://, RC internals,
`isEvaluatingRefBindingRhs`).

**Tests** — new `tests/mut_exclusivity.test.yo` (`comptime_expect_error`
negatives + positives):

- `copy_first(a, a)` → error (rule 1); `b := a; copy_first(a, b)` →
  error (rule 1, alias group); `copy_first(a, b)` with two fresh lists →
  OK (rule 2).
- the `g(x, mut(y))` induction family: body `copy_first(y, x)` is OK;
  `g(a, a)` → error at the call site; `g(a, b)` → OK; two-level nesting
  (`h` calls `g` calls `copy_first`) resolving at the top → OK/error
  pair.
- receiver pairing: a `mut(self)` method taking another list argument,
  called as `xs.merge_from(xs)` → error.
- heap-mediated rejection: two values out of a container passed as
  (mut, immutable) pair → error (rule 5); the copy-out version → OK.
- own pairing: `f(own(c), d)` with c≡d → error.

**Gates:** G1–G5 + CI. Commit + push. **Milestone: the cross-function
aliasing residual is CLOSED — update
`issues/flowability-growth-invalidation-method-calls.md` → move to
`issues/fixed/`.**

### Phase 8 — sweep for newly-surfaced violations

The law may reject patterns inside `std`/`tests`/`yo-self` that were
legal before Phase 7 (e.g. real aliased mut calls). Run G2/G4/G5; fix
each finding properly (restructure or copy-out — never weaken the
check); document any non-obvious one in `issues/`. This phase is the
empirical test of "is case-5 rejection too strict": record the count of
case-5 errors hit in real code in the commit message. If it is large,
STOP and consult the owner before weakening anything (the documented
relaxation paths: BORROWS-only pairing inference, or the v1 dynamic
counter at unproven sites).

### Phase 9 — documentation + knowledge files

All docs in BOTH `docs/en-US/` and `docs/zh-CN/`; use ```rust fences
for Yo code:

1. `FLOWABILITY.md` — replace the "known limitation: cross-function
   aliasing" section with the law; document `mut`, the immutability
   rules (§2), the proof rules (§3), the copy-out idiom, and the
   non-goals (§7, especially "locals stay mutable" with the one-sentence
   rule).
2. `MEMORY_SAFETY.md` — update the soundness story: same-scope gates +
   definition-site immutability + call-site law = no UAF residual.
3. `GRAMMAR.md` — currently documents NO parameter modifiers; add a
   "Function signatures & parameter modifiers" section covering
   `ref`/`inout`, `own`, `mut` together (one place, the family table
   from §1).
4. `.github/instructions/yo-syntax.instructions.md` +
   `.github/skills/yo-syntax/syntax-cheatsheet.md` +
   `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md` — add
   the modifier family, the one-sentence law, and the two most common
   fixes (add `mut`, copy out).
5. Error-message hygiene: messages must NOT reference `plans/*.md`
   paths (project rule).
6. Update `plans/BOOTSTRAPPING_CODEGEN.md` if the codegen-port spec
   enumerates parameter flags (it must now include `isMutable` /
   `param_is_mut`).

**Gates:** G1–G2 + `./yo-cli fmt --check` on touched `.yo` snippets in
docs tests if any. Final commit + push + CI green.

### Known landmines (read before starting)

- **yo-self Func/Variable field additions churn every construction
  site.** Grep `param_is_ref` / `ref_borrowed_by` for the exact
  precedent diffs. Build yo-self EARLY and often (G4 is slow; budget
  it). NO `--release` in the yo-self loop.
- **Trial-eval swallows thrown errors** during overload/specialization
  attempts — the borrow gates already live in this regime and work;
  mirror their placement. Warnings must be DEDUPED (bodies evaluate
  multiple times: def-time eval + per-call specialization).
- **Def-time body evaluation** means definition-site checks fire at
  `check` time for all function bodies — that is the intended behavior
  (it is how `check ./std` produces the migration worklist).
- **`continue` in while loops** with RC allocations has a known codegen
  corruption — use `if/else` shapes in new yo-self code.
- **Never pragma a flowability test file** (skip_prelude etc. break the
  gates' preconditions).
- **Single-expression fn bodies must NOT have braces** in Yo; `()` is
  the unit VALUE, `unit` the type; no forward references — grep yo-self
  before adding a "missing" helper.
- The shell `grep` wrapper skips gitignored files — use `/usr/bin/grep`.
- `bun` can drop from PATH in long sessions:
  `export PATH="/nix/store/9zgnq216jb56ai0xpm6c6j2fblnp8vxy-devenv-profile/bin:$PATH"`.

---

## Appendix — design history

- **v1 (superseded):** Swift-style dynamic Law of Exclusivity — a
  `borrow_count` in the RC header padding, asserts in mutating std
  methods, panic on violation. Rejected as the primary design because
  the owner requires zero runtime overhead; retained as a documented
  fallback ONLY for statically-unproven sites if Phase 8 shows case-5
  rejections are too common. Full design in this file's git history
  (commit e7507f7c).
- **v2 (superseded):** inferred per-function MUTATES/BORROWS/ESCAPES
  summaries + call-site overlap checking with obligation propagation.
  Zero new syntax, but effects stayed invisible in signatures (LLM- and
  reader-hostile), errors surfaced far from their cause through
  propagation chains, and recursion/dyn/extern needed pessimism. v3's
  declared `mut` keeps the same call-site law but makes checking purely
  local (the §3 induction), with signatures as documentation.
- **Option C (`readonly(self)`, superseded):** subsumed by v3 with the
  polarity flipped — immutable is the default, `mut` marks the minority.
