# Method Overloading → Rust-Style Trait-Bound Generics (Redesign)

**Status:** PLANNED — **deferred until the self-host fixpoint (P1) is green.** Do NOT
start mid-bootstrap; see [Sequencing](#sequencing-why-later). This doc exists so the
decision is not lost.

**Owner decision (2026-06-22):** adopt Rust's approach — replace argument-type method
overloading with a single generic method parameterized over a trait-bounded pattern
type. Keep the existing overloading working (via the codegen first-hit fix below)
until the migration lands.

---

## 1. The problem

Yo today bans overloading on **inherent** methods (see the comment at
`std/string/string.yo:1554`), but the `StrPattern` trait reintroduces overloading by
**argument type**:

```rust
// std/string/string.yo
impl(String, /* ... */ starts_with : (fn(self : Self, prefix : Self, (position : usize) ?= 0) -> bool)( /* String-prefix */ ));   // inherent, prefix : String
StrPattern :: trait(starts_with : (fn(self : Self, prefix : str, (position : usize) ?= 0) -> bool), /* ... */);                     // trait,    prefix : str
impl(String, StrPattern(starts_with : (fn(self : Self, prefix : str, (position : usize) ?= 0) -> bool)(self.starts_with(String.from(prefix), position)), /* ... */));
```

Two methods named `starts_with` are both callable as `s.starts_with(x)`, and the
compiler **picks by the type of `x`**. That is ad-hoc overloading — the thing Rust
deliberately does not have. It forces real **overload-resolution machinery** in the
compiler:

- `getReceiverMethodsByNameFromEnv` collects _multiple_ candidates (TS
  `src/env.ts`; yo-self `env.yo`).
- The call evaluator filters to the type-matching candidate (TS
  `function.ts:1691`; yo-self `_select_matching_overload` trial-calls each candidate
  in `calls/function.yo`).
- Codegen must then honor the _evaluator-selected_ overload rather than re-resolve by
  name (yo-self `codegen/exprs/other_fn_call.yo`).

This complexity is bug-prone and bit the bootstrap **twice**:

1. Eval-level `"Cannot unify String and str"` — `_try_find_receiver_method` committed
   to `hits[0]` (the inherent) and threw. Fixed by adding `_select_matching_overload`
   (commit `b4788d38e`).
2. Codegen-level — `other_fn_call.yo` re-resolved by name and took the **first**
   registry entry (the inherent `prefix:String`), passing a `__yo_str` to a `String`
   parameter → C type error. Fixed by preferring the evaluator-resolved method
   (`lookup_method_callee_value`) over the registry first-hit (this session;
   `issues/yo-self-p1-transpile-tail.md` "(cont. 2)").

Both fixes _entrench_ overloading. The redesign removes the need for it.

**Why it is wrong, precisely (inherent-first priority).** Rust resolves methods
**inherent-first**: a type (inherent) method has higher priority than a trait method of
the same name. Under that rule, `s.starts_with("Hi")` on a `String` must resolve to the
**inherent** `String.starts_with(self, prefix : String, …)` (higher priority), and
because `"Hi"` is a `str` (not `String`), it must be a **type error** — resolution must
**not** fall through to the `StrPattern` trait's `str` overload. Yo's current arg-type
overload resolution **violates** this: it treats the inherent and trait methods as equal
candidates and silently picks the one whose parameter matches the argument. That
fall-through is the **core bug** (present in _both_ compilers — TS does it too; the
bootstrap fix only made yo-self match TS).

Note this is **not** "Rust rejects `s.starts_with("lit")`" — Rust _accepts_ it, but only
because Rust has **no** inherent `String.starts_with(String)`: it has exactly one generic
`str::starts_with<P: Pattern>` (reached via `Deref`), so there is no inherent-vs-trait
conflict to resolve. §4 restores that situation for Yo (one method, no conflict); see §4.
Keeping a separate inherent `String.starts_with(String)` instead would make
`s.starts_with("lit")` a type error under correct inherent-first resolution.

**Affected std idioms (the overload sites):** `StrPattern` —
`contains`/`starts_with`/`ends_with`/`index_of`/`last_index_of`/`split` — plus any
other inherent+trait same-name pairs. Audit before migrating (Phase 1).

---

## 2. How Rust does it (the model to follow)

Rust has **no** overloading. `str::starts_with` is a single generic method:

```rust
pub fn starts_with<P: Pattern>(&self, pat: P) -> bool
```

`Pattern` is implemented by `&str`, `char`, `&[char]`, `FnMut(char) -> bool`, etc., so
`"hi".starts_with("h")`, `.starts_with('h')`, `.starts_with(|c| ...)` all work through
**one** function — monomorphized per `P`, with ordinary trait resolution picking the
`Pattern` impl for the concrete argument type. There is no arg-type selection between
same-named methods; when an inherent and a trait method share a name, Rust picks the
inherent one by a fixed rule.

Key detail: Rust's `Pattern` does **not** convert the pattern to a common type — the
**pattern itself implements the matching** (`Searcher`: `is_prefix_of`,
`is_contained_in`, …). This matters for Yo (see §3, the `as_str()` constraint).

---

## 3. Yo-specific constraint: `as_str()` is gone

`plans/SLICE_REWORK.md` **deletes `String.as_str()`** (and `ArrayList.as_slice()`),
and migrated the dominant `x.as_str() == "literal"` pattern (~2186 sites in yo-self)
to direct `x == "literal"`. The `StrPattern` `str`-overloads were _introduced by the
slice rework_ precisely as the `as_str()` replacement for
`starts_with`/`ends_with`/`contains`/… with a literal argument
(`plans/SLICE_REWORK.md` step "starts_with/ends_with/contains(str) overloads").

**Therefore the redesign must NOT reintroduce `as_str()`.** A "convert the pattern to
`str`, then match" design is off the table. We mirror Rust's actual `Pattern`: the
**pattern type implements the match against a `String` haystack**.

This also means the redesign _supersedes_ part of the slice-rework's chosen mechanism
(overloads) with a generic-method mechanism — call it out when editing
`SLICE_REWORK.md`.

---

## 4. Proposed design

A `StrPattern` trait whose implementors (`str`, `String`, later `char`) know how to
match themselves against a `String` haystack — no `as_str()`:

```rust
StrPattern :: trait(
  is_prefix_of    : (fn(self : Self, haystack : String, position : usize) -> bool),
  is_suffix_of    : (fn(self : Self, haystack : String, end_position : usize) -> bool),
  is_contained_in : (fn(self : Self, haystack : String, from_index : usize) -> bool),
  index_in        : (fn(self : Self, haystack : String, from_index : usize) -> Option(usize)),
  last_index_in   : (fn(self : Self, haystack : String, from_index : usize) -> Option(usize))
);
impl(str,    StrPattern( /* match a str literal against a String haystack */ ));
impl(String, StrPattern( /* match a String pattern against a String haystack */ ));
```

The inherent `String` methods become **single generic methods** over the pattern:

```rust
impl(String,
  starts_with : (fn(forall(P : Type), self : Self, prefix : P, (position : usize) ?= 0, where(P <: StrPattern)) -> bool)(
    prefix.is_prefix_of(self, position)
  ),
  contains : (fn(forall(P : Type), self : Self, pat : P, (from_index : usize) ?= 0, where(P <: StrPattern)) -> bool)(
    pat.is_contained_in(self, from_index)
  )
  // … ends_with / index_of / last_index_of likewise …
);
```

Then `s.starts_with("lit")` resolves `P = str` → `str`'s `is_prefix_of`;
`s.starts_with(other_string)` resolves `P = String` → `String`'s `is_prefix_of`.
**One** method, dispatched by generic instantiation + trait resolution — no
overload-selection step.

`split` returns `ArrayList(Self)` and is pattern-driven; decide during Phase 2 whether
it joins the trait or stays a small set of concrete methods.

**This is Rust's approach.** §4 mirrors `str::starts_with<P: Pattern>(&self, pat: P)`
one-to-one: one generic method, a `Pattern`-style trait where the _pattern_ implements
the match, and concrete dispatch via monomorphization + trait resolution. (§4b below is
Rust's _general_ inherent-vs-trait rule — **not** how Rust solves this case; it is
recorded only as a simpler-compiler fallback.) Two fidelity notes for the implementer:

- **Pass the haystack by reference.** Rust's haystack is `&str` — borrowed, no copy. A
  by-value `haystack : String` would clone the buffer on _every_ pattern check; use a
  borrow (e.g. `ref(String)`) so `prefix.is_prefix_of(s, …)` does not copy `s`.
- **Keep `StrPattern` open, like Rust's `Pattern`.** Rust implements `Pattern` for
  `char`, `&str`, `&[char]`, and `FnMut(char) -> bool` closures. The design should
  admit `char` (and, later, a predicate closure) implementors **without** changing the
  generic `String` methods — that openness is the whole payoff of the trait-bound form.

### 4b. Why not the existing `(Type <: Trait).method()` form for `starts_with`

Yo **already supports** explicit trait-method disambiguation:
`(String <: StrPattern).starts_with(s, x)` is existing syntax (Yo's UFCS), **not** new.
So a tempting alternative is to keep _both_ methods (inherent + trait), let the inherent
always win, and require this form to reach the trait variant — Rust's _general_
name-collision rule (`<String as StrPattern>::starts_with`).

**We reject this for `starts_with`** (owner, 2026-06-22) — note the rejection is about
_using it to dispatch `starts_with`_, not about the feature itself:

- **It is not Rust's approach to this problem.** Rust uses the generic method (§4) for
  `starts_with`; inherent-wins + explicit disambiguation is the general escape hatch for
  accidental name collisions, not the mechanism for accepting multiple argument types.
- **It forces call-site friction on the common case.** The inherent `starts_with` takes
  `prefix : String`, but the dominant post-slice-rework call is `s.starts_with("lit")`
  (a `str`). "Inherent always wins" then breaks the common case unless every literal
  site is rewritten `(String <: StrPattern).starts_with(s, "lit")` (verbose — the
  majority of sites), or the inherent is flipped to take `str` (inverting which type is
  privileged).
- **§4 needs no disambiguation at all** — one generic method, both arg types resolve by
  inference + trait dispatch.

`(Type <: Trait).method()` remains a useful **general** feature for genuine cross-trait
name collisions; it just is not how `starts_with` (or the other `StrPattern` methods)
should dispatch.

§4's one cost is **generic-arg inference** (P inferred from the argument) — standard,
and Yo already has the specialization machinery for it. Confirm it in the Phase-0 spike
(below); there is no UFCS fallback to fall back on, so inference is a hard prerequisite.

**Feasibility prerequisites (confirm in Phase 0):**

- **Generic-arg type inference:** the caller writes `s.starts_with("lit")` without
  passing `P` explicitly, so `P` must be **inferred from the value argument's type**.
  Confirm Yo infers a generic type param from a value param (`prefix : P`) at a method
  call. If only `comptime(P)`-passed-explicitly is supported, that is a prerequisite
  to build first.
- **`where(P <: StrPattern)` value-param bound** lowers + dispatches correctly through
  monomorphization (the `prefix.is_prefix_of(self, …)` value-call on a bounded generic
  must codegen to the concrete impl). Build a tiny repro first.
- The generic-method path may have its **own yo-self codegen gaps** distinct from the
  overloading path — surface them with a minimal repro **before** the std-wide sweep.

---

## 5. Migration plan (phases)

0. **Prereqs / spike. ✅ DONE (2026-06-22).** Confirmed generic-arg inference +
   `where`-bound value-call dispatch on _both_ compilers with a `fixme.yo` repro
   (`show<P: Describable>(p)` + a `Holder.check<P>` method; impls for `i32`/`bool`).
   Result: both TS and yo-self **infer `P` from the value argument** (no explicit
   pass), at free-fn _and_ method calls, monomorphize per `P`, and dispatch the
   bounded `p.describe()` to the concrete impl — 0 errors, 0 transpile markers. So
   the generic-method form is viable; no inference work needed first.
1. **Audit every overload site.** Enumerate all methods relying on arg-type
   overloading: grep for inherent+trait same-name pairs; instrument the multi-candidate
   path (`all_hits.len() > 1` in yo-self `function.yo`; the `functionsToCall` filter at
   TS `function.ts:1691`). Produce the full list — `StrPattern` is the known cluster,
   but verify there are no others (operators, numeric conversions, `Eq`/`Ord` across
   types, etc.).
2. **Design the generic replacement per site.** Most are `StrPattern`-shaped (pattern
   implements the match). Document each.
3. **Change std.** Rewrite `StrPattern` (§4) and the inherent `String` methods to the
   generic form. Update `plans/SLICE_REWORK.md` to reflect that overloads are replaced
   by generics.

   **✅ slice 1 done + TS-validated (2026-06-22): `starts_with`.** `check ./std`
   152/152; a behavioral test (`s.starts_with("he")` / `…(String.from("he"))` / negative
   cases / `position` arg) compiles + runs clean — both `str` and `String` patterns flow
   through the one generic method. Edits in `std/string/string.yo`: renamed inherent
   `starts_with` → private `_has_prefix` (body unchanged); added `Pattern :: trait(is_prefix_of)`

   - `impl(String, Pattern)` (→ `haystack._has_prefix(self, pos)`) + `impl(str, Pattern)`
     (→ `haystack._has_prefix(String.from(self), pos)`); added the generic
     `starts_with<P : Pattern>` in a separate `impl(String, …)`; removed `starts_with`
     from the `StrPattern` trait + impl.

   **Per-method transform recipe (apply to `contains`/`ends_with`/`index_of`/`last_index_of`):**
   (a) rename inherent `X(self, arg : String, …)` → private `_X_impl` (body unchanged);
   (b) add `is_<X>`/`<X>_in` to the `Pattern` trait; (c) `impl` it for `String` (delegate
   `haystack._X_impl(self, …)`) and `str` (delegate via `String.from(self)`); (d) add the
   generic `X<P : Pattern>(self, arg : P, …)` delegating to the pattern method;
   (e) remove `X` from `StrPattern` (trait + impl). `split` is special — the separator is
   the pattern and the result is `ArrayList(haystack)`; give `Pattern` a split helper or
   keep `split` concrete (decide in this step). Inherent locations (pre-sweep):
   `index_of`:516, `contains`:612, `split`:623, `last_index_of`:730, `ends_with`:927.
   `Pattern` is a generic name exported from `std/string` — consider `StrPat` or
   namespacing to avoid collisions before finalizing.

   slice 1 was also validated on **yo-self** (compiles + runs the `starts_with` calls,
   correctly specialized per `P`). One yo-self prerequisite it surfaced: the known
   **default-arg DIRECT-call gap** — `assert(cond)` (omitted default message) C-fails
   "too few arguments" in yo-self codegen (the `function.yo ~2424` inline-FuncVal arm).
   The redesign's `comptime_expect_error` tests and any std/test code using `assert(cond)`
   need this fixed before step 4 (yo-self) can validate them. Tracked separately.

   **✅ FULL CLUSTER DONE + validated on BOTH compilers (2026-06-22).** All six methods
   (`starts_with`/`ends_with`/`contains`/`index_of`/`last_index_of`/`split`) are now §4
   generic methods over `Pattern`; the `StrPattern` trait + impl are removed; `Pattern`
   replaces it in the export list. Validation: `check ./std` 152/152 (TS); a behavioral
   test exercising all six with both `str` and `String` patterns compiles + runs clean on
   **TS** (with `assert`) and **yo-self** (without `assert`, due to the default-arg gap).
   Edits in `std/string/string.yo`: 5 inherent methods renamed to private `_X_impl`
   (byte logic unchanged) + the one `contains`→`index_of` cross-call fixed to `_index_of_impl`;
   `Pattern` trait grown to 6 methods (`is_prefix_of`/`is_suffix_of`/`is_contained_in`/
   `index_in`/`last_index_in`/`split_of`) with `str` + `String` impls; 6 generic methods
   added in a separate `impl(String, …)`. **The overload-resolution path for the string
   methods is now gone** — each name maps to exactly one (generic) method.

   **Step 3 — inherent-first resolution. ✅ DONE on TS (2026-06-22).** A type's inherent
   method now SHADOWS a same-name trait method; a call matching only the trait ERRORS
   instead of silently falling through. Implemented in `src/env.ts`
   `getReceiverMethodsByNameFromEnv`: the impl'd-trait collection (both the `receiverType`
   and `dereferencedReceiverType` blocks) is gated on `directMethods.length === 0`, so
   trait methods are candidates only when no direct/inherent method of the name exists.
   (Methods provided purely by traits — e.g. `==` via `Eq(String)`/`Eq(str)` — have no
   direct field, so they are still collected + argument-type-dispatched among themselves;
   heterogeneous-operator overloading is unaffected.) VALIDATION: the
   `comptime_expect_error` test (`tests/inherent_first_resolution.test.yo`) is GREEN
   (inherent-first error + §4 where-bound error both reported); `check ./std` 152/152; full
   `./yo-cli test` 2606/2606 — the one affected test (`impl.test.yo`'s former
   "delegating-to-inherent-overload" case) was updated to assert the inherent-first error,
   as it encoded exactly the removed overload behavior. **✅ ALSO ported to yo-self**
   (commit `2a7cdee3f`): `impl.yo` tags trait-impl methods with their trait id;
   `env.yo` `get_receiver_methods_by_name_from_env` drops trait candidates when an
   inherent one exists. yo-self `check ./std` 152/152, corpus 83/83; the repro resolves
   inherent-first (yo-self emits a "Failed to transpile" marker where TS reports a clean
   error — a pre-existing def-eval-wall limitation, not a resolution difference).

4. **Verify both compilers resolve via generics, not overloading.** Call sites should
   need _no_ overload resolution. Run the differential corpus + `check ./std`.
5. **Delete the overload-resolution machinery** once std + tests are green on both
   compilers:
   - yo-self: `_select_matching_overload`, `_trial_call_overload_candidate` (if unused
     elsewhere), `_build_receiver_call_args`, the `all_hits` field on
     `ReceiverMethodResult`, and the multi-hit branch at the property-access caller.
   - TS: the `functionsToCall` multi-candidate filter at `function.ts:1691` and the
     candidate collection that supports it (keep only single-candidate resolution).
   - Codegen: the registry first-hit path can be simplified once a method name maps to
     exactly one method (the side-table-first ordering from this session can stay; it
     becomes trivially correct).
6. **Validate:** differential corpus 83/83, `check ./std` 151/151, full TS suite, full
   `./yo-cli test`, and the self-host fixpoint (stage-2 ≡ stage-3).

---

## 6. Clear error messages (Rust-style diagnostics)

Removing overloading must make _failures_ deterministic too. The overloading era
produced cryptic errors — the eval-level `"Cannot unify String and str"` (the bug that
bit the bootstrap) leaked the **inherent overload's** parameter type, not the user's
actual mistake; "no matching overload" never said which types are accepted. The
redesign must replace these with a clear, actionable diagnostic.

Under §4, calling `s.starts_with(x)` where `typeof(x)` does not implement `StrPattern`
should mirror Rust's `E0277`:

Rust:

```text
error[E0277]: the trait bound `Foo: Pattern` is not satisfied
 --> src/main.rs:3:19
  |
3 |     s.starts_with(foo);
  |       ----------- ^^^ the trait `Pattern` is not implemented for `Foo`
  |       |
  |       required by a bound introduced by this call
  |
  = help: the following other types implement trait `Pattern`:
            char, &str, String, &[char], ...
  = note: required by a bound in `str::starts_with`
```

Yo target (the redesign must emit something equivalent):

```text
error: `Foo` does not implement `StrPattern`
 --> app.yo:3:19
  |
3 |     s.starts_with(foo)
  |       ^^^^^^^^^^^ required by `where(P <: StrPattern)` on `String.starts_with`
  |
  = the following types implement `StrPattern`: str, String
  = help: to match a `Foo` pattern, implement `StrPattern` for it; otherwise pass a
          `str` literal or a `String`
```

Requirements:

1. Name the **offending** type (the argument's type) — **never** an internal parameter
   type. The old `"Cannot unify String and str"` leaked the inherent's `String` param;
   that is exactly the anti-pattern to kill.
2. Name the **unsatisfied bound** and **where** it is required (`where(P <: StrPattern)`
   on `String.starts_with`).
3. List the types that **do** implement the trait (`str`, `String`) — actionable.
4. Suggest a fix (implement the trait for the type, or pass a supported type).
5. Point the span at the **argument**, not the method definition.

This is a **general** win — it is the diagnostic for _any_ unsatisfied
`where(T <: Trait)` bound, not just `StrPattern` — so implementing it well retires a
whole class of confusing failures from the overload-resolution era.

**Where to implement:** the where-clause / trait-bound satisfaction checker (where
`P <: StrPattern` is verified at the call site) — TS `src/evaluator/` where-clause
validation and its yo-self mirror (`yo-self/evaluator/…`). Emit the structured error
there. Prerequisite: the trait registry must enumerate a trait's implementors for the
"the following types implement `StrPattern`" hint — confirm/add that query. Keep the
message free of internal/`plans/*.md` references (it is user-facing).

**Acceptance test (the resolution-error report must exist).** `issues/fixed/yo-inherent-first-resolution.md`
holds an isolated repro + a `comptime_expect_error` test: a type with an inherent `m`
and a same-name trait `m`, called with an arg matching only the trait, **must error**
(inherent-first), not silently resolve to the trait. It is **verified-failing today**
(both compilers silently pick the trait — confirmed on TS, EXIT 0). It becomes the
green acceptance criterion once inherent-first resolution lands, and then promotes to
`tests/`. This locks in "the redesign still reports resolution errors" rather than
silently mis-resolving.

---

## 7. Sequencing (why later)

A cross-compiler + std refactor is the **most dangerous** thing to attempt while
yo-self is red: there is no green baseline to diff against, and the generic-method
replacement may hide its own yo-self codegen gaps. Do it **after** the self-host
fixpoint is green, so the self-hosted compiler is the **validation net** — every change
can be checked by confirming both compilers emit identical behavior. The codegen
first-hit fix keeps overloading working in the meantime, so there is no urgency.

---

## 8. Payoff

- Removes an entire class of compiler complexity (overload resolution) from **both**
  compilers — fewer bug classes, simpler method dispatch.
- Aligns Yo with Rust's proven model (single generic method + trait bound).
- Makes dispatch deterministic: a method name maps to exactly one method; the argument
  drives a trait impl, not a hidden selection between same-named methods.

---

## 9. Risks

- **Generic-arg inference** for value params is a **hard prerequisite** (we dropped the
  UFCS fallback): if Yo can't infer `P` from the argument's type at the call site, it
  must be built first (Phase 0). It is a standard capability and Yo already has the
  specialization machinery, so this is expected to be confirmation, not new work.
- **`where`-bound value-call dispatch** through monomorphization may have yo-self gaps
  → spike first (Phase 0).
- **Performance:** the pattern-implements-match indirection must monomorphize away (no
  dynamic dispatch); confirm the emitted C is a direct call, like the current inherent
  methods.
- **Scope creep:** the audit (Phase 1) may surface overload sites beyond `StrPattern`;
  budget for them before deleting the machinery (Phase 5).

---

## 10. References

- `std/string/string.yo:1554-1565` (`StrPattern` trait), `:1566+` (`impl(String,
StrPattern(...))`), `:842` (inherent `starts_with`).
- `plans/SLICE_REWORK.md` — `as_str()`/`as_slice()` deletion and the str-overload
  replacement strategy this redesign supersedes.
- `issues/yo-self-p1-transpile-tail.md` — the two overloading bugs (eval-level
  `b4788d38e`; codegen first-hit, this session) and the dispatch internals.
- TS overload resolution: `src/env.ts` (`getReceiverMethodsByNameFromEnv`),
  `src/evaluator/calls/function.ts:330,1691`; codegen `src/codegen/exprs/other-fn-call.ts:453`.
- yo-self overload resolution: `yo-self/evaluator/calls/function.yo`
  (`_try_find_receiver_method`, `_select_matching_overload`),
  `yo-self/codegen/exprs/other_fn_call.yo` (dispatch).
