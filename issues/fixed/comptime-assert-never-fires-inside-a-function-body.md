# `comptime_assert` never fires inside a function body — 1559 assertions in `tests/` assert nothing (FIXED 2026-09-05)

**Status: FIXED.** `src/evaluator/builtins/comptime_assert.yo` — a condition
that folds to a CONCRETE `BoolVal(false)` now throws in the validation path as
well as the executing one, through one shared `_throw_assert_failed` so the two
cannot drift. An `UnknownVal` still only type-checks, so a runtime condition or
an unspecialized generic body is untouched.

**Vacuity guard:** `tests/cli-cases/compile-comptime-assert-in-fn-body` — a
`compile` case (not `check`: `check` is evaluator-only and does not raise this
diagnostic even at module level) with a `stdout_keep_match` pinning THE failure
rather than A failure. Verified RED on v0.2.24, where the harness reports
`stdout_keep_match matched nothing — vacuous`, which is precisely the bug.

**The fallout triage is in the section at the bottom of this file.**

**Severity: hollow gate.** Not a wrong answer — an *absent* answer, over the
entire compile-time-evaluation surface. `comptime_assert` is the only mechanism
the suite has for pinning CTFE results, and it is inert everywhere the suite
uses it.

**Found** 2026-09-04, while writing a regression test for
`issues/fixed/comptime-u64-div-mod-cmp-shr-are-signed.md`. The new test passed
on the *unfixed* compiler, which is how the vacuity surfaced.

## Reproducer

```rust
main :: (fn() -> unit)({
  comptime_assert(false);
});
export(main);
```

```
$ yo compile ca1.yo --optimize 2 -o ca1.out
$ echo $?
0
```

Accepted. At module level the same call is correctly rejected:

```rust
comptime_assert(false);
main :: (fn() -> unit)({});
export(main);
```

```
error[E1101]: Assertion failed for "comptime_assert":
false
  --> ca2.yo:1:1
  |
1 | comptime_assert(false);
```

Measured on v0.2.24, `comptime_assert(false)` in each position:

| position | result |
| --- | --- |
| module level | **REJECTED** (E1101) — correct |
| inside `main`'s body | accepted, silently |
| inside a plain `fn` that IS called from `main` | accepted, silently |
| inside a plain `fn` that is never called | accepted, silently |
| inside a `fn(...) -> comptime(T)` body | accepted, silently |

`yo check` accepts it in every position including module level, but that is
expected: `check` is evaluator-only and this diagnostic is raised on the
compile path.

## Scale

A `test("name", { ... })` body **is** a function body, so every
`comptime_assert` in the suite is in the inert position:

```
$ grep -rh 'comptime_assert' tests/ | wc -l
1559
$ grep -rc 'comptime_assert' tests/*.test.yo | sort -t: -k2 -rn | head -5
tests/comptime.test.yo:1064
tests/basic.test.yo:172
tests/type_reflection.test.yo:103
tests/index.test.yo:58
tests/variadic_comptime.test.yo:34
```

`tests/comptime.test.yo` is the primary gate on constant folding, comptime
strings, comptime collections and type reflection. It reports 31 passing tests
and verifies none of their comptime claims.

This is exactly how the u64 signed-arithmetic bug above survived: `Test
comptime u64` contains `comptime_assert(quot == …)` lines that would have
caught a mis-folded division if they had run.

## Why this matters beyond the count

Two of the audit's own conventions lean on `comptime_assert`:

- the O7 `Acyclic` pins use `comptime_assert(Type.impls(payload, Send))` to
  guarantee "the expected error can only be Acyclic's"
  (`plans/STD_API_AUDIT.md` §8 O7) — an inert guard there means the
  `comptime_expect_error` tests may be passing for the wrong reason;
- `std/prelude.yo`'s own `for`-macro validation uses
  `comptime_assert(args.len() == 2, …)` inside a macro body, which is a
  function body.

## Root cause — ESTABLISHED

It is **not** the def-eval swallow it resembles: `YO_DEBUG_SWALLOW=1` shows the
body trialled with no swallow after it. `evaluate_comptime_assert` returned
early whenever `ctx.is_validating_function_definition || !ctx.is_executing`,
and a function body is *validated* rather than *executed* — so in that position
the builtin was reduced to a type check on its argument. That early return is a
faithful 1:1 port of the TypeScript original, and it is RIGHT for an
**unresolved** condition (a generic body's types are not bound yet) but wrong
for a resolved one.

The original filing's guesses, kept for the record:

- the diagnostic is `E1101` and is reachable, so the check exists and the
  message is wired;
- position is what decides, not reachability — an uncalled function behaves the
  same as `main`, which rules out "the body was never evaluated" as the whole
  story;
- the shape strongly resembles the **def-eval swallow** family already
  documented in this repo, where a real error raised during a function's
  definition-time trial evaluation is caught and discarded. C18 and C19 were
  both this: *"the check FIRED but was SWALLOWED in async-closure/generic
  def-eval, leaving codegen no ExprInfo"*, and the fix there was to flag the
  flow-violation channel before throwing so the swallow re-raises it at check
  time (`issues/fixed/struct-literal-missing-field-silently-accepted.md`,
  `issues/fixed/int-vs-i32-mismatch-reaches-codegen-and-emits-malformed-c.md`).

Start there: find where `comptime_assert` is evaluated (the builtin dispatch in
`src/evaluator/builtins/`), and find which handler swallows its throw when the
enclosing expression is a function body rather than a module-level statement.

## Fix shape

1. Make `comptime_assert` fire in a function body, by the same
   flow-violation-channel route C18/C19 used, so the def-eval trial cannot
   discard it.
2. **Then triage the fallout.** Turning on 1559 dormant assertions will go red
   in places, and every red one is either a real bug or a stale assertion. That
   triage is the substance of this work, not a side effect — budget for it, and
   do not weaken assertions to get green. Land the fix and the triage together
   so the suite is never knowingly hollow on `develop`.
3. Add a **vacuity guard** so this cannot regress: a test that asserts
   `comptime_assert(false)` inside a function body is REJECTED. The natural
   home is a `tests/cli-cases/` golden (a compile that must fail with E1101),
   since the assertion is about a compile failing.

## Guidance for test authors (updated)

`comptime_assert` now fires inside a `test(...)` body whenever its condition
folds to a concrete `false`. It still only TYPE-CHECKS when the condition is
not comptime-decidable — a runtime value, or a generic body whose type
parameters are unbound — so an assertion over an unresolved generic is still no
gate. For those, and for anything you want proof against future comptime
machinery changes, the **module-level `::` binding observed by a runtime
`assert`** shape stays the strongest: the binding is folded at comptime and the
runtime assert observes what the folder produced.

---

## THE FALLOUT TRIAGE

The suite compiles each test file as one batch, so a live-and-false
`comptime_assert` fails the whole file's compile. The fallout was enumerated by
re-running the fast suite and excluding each failing file in turn.

**1553 assertions came alive** (`grep -rho comptime_assert tests/ --exclude-dir=cli-cases`).
Enumerating took six suite runs. **Six findings across three files: four real,
PRE-EXISTING compiler bugs and two genuinely stale assertions.** Every one of
the four bugs reproduced identically on the released v0.2.24 seed, so none is a
regression from this change or from PR #429.

Where the bug is out of scope, the assertion is pinned to the MEASURED value
with a comment naming the filed issue and stating the value it should have, and
stays LIVE — when the bug is fixed it goes red, and that red is the reminder to
restore the correct value. Nothing was weakened or deleted.

| # | file | assertion | measured | classification | action |
|---|------|-----------|----------|----------------|--------|
| 1 | `tests/basic.test.yo` | `Type.impls(Tuple(i32), Comptime)`, `Tuple(comptime_int)` | `false`, want `true` | **real bug — small** | **FIXED here.** Tuples derive NO auto-derived marker at all: `Comptime`, `Send`, `Runtime` and `Acyclic` are all `false` for every tuple, where the identical nominal struct is `true`. Fixing it exposed a second defect in the same block — the recursion guard keyed by nominal id, which is `""` for every structural type, so a nested one was cut (`*(*(i32))` was not `Send`). `issues/fixed/tuple-types-derive-no-auto-derived-marker.md` |
| 2 | `tests/comptime.test.yo` | `__yo_are_types_compatible(fn(generic(T),…)->T, fn(generic(Z),…)->Z) == true` ×3 | `false`, want `true` | **real bug — large, filed** | Generic fn types are compared by BINDER NAME, not alpha-equivalence. `issues/generic-fn-type-compatibility-is-not-alpha-equivalent.md`. Pinned to measured, kept live. |
| 3 | `tests/operator_grouping.test.yo` | `(20 - 5 - 4 - 3) == 8` | `16` | **real bug — large, filed** | A same-operator chain of FOUR or more operands is not left-associative: it parses as `(a - (b - c)) - d`. Three operands and explicit parentheses are correct. `issues/same-operator-chain-of-four-or-more-is-not-left-associative.md`. Pinned to measured, kept live. |
| 4 | `tests/comptime.test.yo` | `c1.radius == 10.0` after a comptime enum-payload assignment | `5.0` | **real bug — filed** | Assigning to a comptime ENUM payload field is a silent no-op; comptime struct/array/tuple mutation and RUNTIME enum mutation all work. `issues/comptime-enum-payload-field-assignment-is-a-silent-no-op.md`. Pinned to measured, kept live. |
| 5 | `tests/comptime.test.yo` | `quote(1 +⏎ 2 +⏎ 3) == quote(1 + (2 + 3))` | `(1 + 2) + 3` | **stale assertion** | **Corrected to the TRUE value.** It encoded the removed newline-associativity rule (a trailing operator at end of line made a chain right-associate); `plans/archive/OPERATOR_ASSOCIATIVITY.md` deleted that rule, so both layouts left-associate now. A `right == left` assertion was added — that the two LAYOUTS agree is exactly what "source layout no longer affects grouping" means. |
| 6 | `tests/basic.test.yo` | `Type.impls(T, Runtime)` for an unconstrained `comptime(T) : Type` | `false`, want `true` | **stale assertion** | **Corrected to the TRUE value.** It encoded "an unconstrained type parameter is Runtime by default", which neither compiler implements — `type_implements_runtime_builtin` has no SomeType case in either, so an unconstrained `T` falls through to its empty constraint list. `false` is also the RIGHT answer: `T` could be instantiated at `comptime_int`. The sibling `Comptime` test asserts exactly this polarity for the identical shape and always has. |

Note on #6: the same test's `fn3` shape (`generic(T : Type), v : T`) yields an
`UnknownVal`, not a concrete `false` — both `Type.impls(T, Runtime)` and its
negation compile there — so that assertion is still no gate. That is the
documented limit of this fix, not an oversight.

Nothing was weakened or deleted. The two pinned assertions stay live so that a
future fix flips them red — which is the reminder to restore the correct value.

### What did NOT break, and why that matters

* **`std/prelude.yo`'s `for` macro** (`comptime_assert(false, "…")` in
  untaken `cond` arms, inside a macro body — a function body) survives. A macro
  body is trialled on the DEFERRED-generic path, whose swallow is faithful to
  the TS `catch { return; }`; only the CONCRETE-fn path re-raises. `yo check
  ./std` is clean with the fixed binary.
* **`std/collections/{array_list,hash_map,hash_set}.yo`** and
  `std/encoding/json.yo` guard their macros/derive rules with
  `comptime_assert` over a condition that is unknown at definition time — those
  still only type-check, as intended.
* **The audit's O7 pins** (`comptime_assert(Type.impls(payload, Send))` before
  a `comptime_expect_error`, in `tests/imm_vec.test.yo` and every
  `tests/sync/*.test.yo`) were the ones the audit worried about most. They are
  now LIVE and they PASS, so the `Acyclic` expect-errors really are Acyclic's
  and not the Send bound firing first.
* **No `comptime_expect_error` test changed verdict.** The suite has 299 of
  them, and only THREE contain a `comptime_assert` — `tests/comptime.test.yo`'s
  "comptime_assert validates argument type even in function body", which
  exercises the builtin's argument TYPE check. This change leaves that check
  untouched: the new throw is added after it, on the same argument info.

