# Type-error diagnostics point into std/prelude, use inconsistent codes, and leak internal names

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 4).
**Status:** FIXED 2026-09-25 (`plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 4.4); see "Resolution". Diagnostics quality; complements
`issues/diagnostic-codes-are-assigned-by-substring-matching-the-message-text.md`.
**Measured:** yo 0.2.39 seed (`yo explain --list` knows 30 codes); the unknown-field row re-verified
on a develop build `d455b6a67`.

## Findings

| # | Shape | What the user sees | Problem |
| --- | --- | --- | --- |
| 1 | `println(p)` where `P` has no `ToString` | `E0602 Type P does not implement required trait ToString.` located at `std/fmt/index.yo:63` | the user's call site is never shown |
| 2 | `i32(2147483647) + i32(1)` at comptime | `E1102 ... exceeds i32 range` located at `std/prelude.yo:2069 __yo_comptime_i32_add` | wrong file, internal builtin name |
| 3 | comptime `x / 0` | `error: Division by zero in comptime integer operation: __yo_comptime_i32_div` | no code, prelude location, internal name |
| 4 | `f(true)` for `f(x : i32)` | `E0601 Cannot unify incompatible types: Expected "i32" Given "bool"` | caret on the enclosing fn body `{`, not the argument |
| 5 | `(x : Option(i32)) = .Some(true)` | `E0605 Type mismatch for type member "value"` | same mistake class as #4, different code |
| 6 | `n(i32(1))` where `n : i32` | `E0610 No matching call found` | `E0606 argument is not callable` exists and is unused here |
| 7 | missing method `p.to_string()` | `E0610 No matching call found ...: (p.to_string)()` | `yo explain E0610` says to check the receiver type in the message; the message has none |
| 8 | `f(x : i32(1), z : i32(2))` | `...Label is only used for readibility` | typo ("readibility", `src/evaluator/calls/helper.yo` ~689 and `src/evaluator/calls/function.yo` ~5214); no code |
| 9 | `(c : Color) = .Purple` | `E0402 Enum variant "Purple" not found in enum` | does not name the enum; no suggestion |
| 10 | missing ctor field `P(x : i32(1))` | `Type member "y" is not provided...` | no code; caret on fn body `{` |
| 11 | `T :: cond(b => i32, true => i64)` with runtime `b` | `Expected "::" instead of ":=" for compile-time known value assignment`, then `Expected type for rhs, got T` | calls a runtime value "compile-time known" |
| 12 | unbound type name in a comptime `cond` (`comptime_string`) | `Cannot convert a value of type Type(1) to i32` | should be E0401 with a did-you-mean |
| 13 | tuple pattern `match(t, (1, _) => ...)` | `... comparing them yields unit, not bool` | leaks the `==`-yields-unit mechanism |
| 14 | `Box` payload pattern | `... has type Box(<enum:enum_decl_b1_r1c5__self_shell>)` | leaks `__self_shell` |
| 15 | `unwind` in a plain fn | `...function that has an enclosing function` | misleading wording |
| 16 | `V :: { z : bool(true) }` (a cast inside a record field) | `evaluate_function_call: TypeVal callee with unsupported type (Phase 5)` | internal fn name and a porting-phase label in a user error |

`docs/en-US/ERROR_DIAGNOSTICS.md` states that "the same underlying mistake always produces the same
code"; #4/#5 and #6/#7 contradict it.

## Fix direction

1. Report a diagnostic at the outermost frame inside a user file, with a "required by" note that
   points into std (fixes #1-#3).
2. Carry the argument's token into the call-site check (#4, #10).
3. One code per mistake class; register every uncoded error in `src/diagnostics_registry.yo`
   (#3, #5, #6, #8, #10).
4. Name the type or enum involved and add did-you-mean on field, variant and type names (#7, #9, #12).
5. Replace internal names in user-facing text (#2, #3, #13, #14), fix the typo (#8), and reword
   #11 and #15.

## Resolution (2026-09-25, Phase 4.4)

The mechanisms:
- **Anchoring.** A call written in user code reports an error raised inside the
  standard library at itself, with the std location as a `note: raised here, inside the
  standard library` (`evaluate_function_call` / `_reported_at_user_call`,
  `src/evaluator/calls/function.yo`; `reanchor_primary_at`, `src/error.yo`).
- **Re-raises keep their span.** The flow-violation channel holds the thrown `YoError`,
  so an error re-raised after a definition-time trial keeps the raise site's span (it
  used to be re-anchored on the enclosing function's `{`).
- **Codes.** A raise site names its code with `with_code`, instead of the substring
  classifier inferring it (see `issues/fixed/diagnostic-codes-are-assigned-by-substring-matching-the-message-text.md`).

| # | Now |
| --- | --- |
| 1 | E0602 at the user's `println(p)`, with the std `where` clause as a note |
| 2 | E1102 at the user's `+`, with the prelude builtin as a note |
| 3 | E1103 (new: compile-time division by zero) at the user's `/`: `Division by zero in compile-time evaluation: 1 / 0` |
| 4 | E0601 at the argument `true` |
| 5 | E0601: `Incompatible types for field "value"` (was E0605) |
| 6 | E0606: `n is not callable: it has type i32.` (E0606 is now "value is not callable") |
| 7 | E0610: `No method "to_string" on P: the type has no field or method with that name.` |
| 8 | E0615 (new: argument label mismatch); the typo is gone |
| 9 | `Enum variant "Purple" not found in enum Color. Its variants: Red, Green.` |
| 10 | E0603 at `P`: `Missing field "y" in the call to P: the field has no default value.` |
| 11 | A runtime condition that selects a compile-time-only value is rejected at the condition; a `::` over a runtime `cond`/`if` is rejected (it used to pass `check`, `issues/fixed/a-comptime-binding-accepts-a-cond-over-a-runtime-condition.md`) |
| 12 | Already E0401 with a did-you-mean when re-measured |
| 13 | The tuple-pattern error says tuple patterns are not supported yet, without the `==`-yields-unit mechanism |
| 14 | A recursive enum's self-shell prints as the enum's name |
| 15 | `unwind` explains what it exits and suggests `return(...)` |
| 16 | E0606: `Type bool cannot be called: a type is callable only as a numeric conversion … or as a constructor` |

Also: `Impl(...)` and `Future(...)` types print as written (they printed as
`Impl : (…)` and `Future[Future](T) E : E`), and human/short renders print a
demand-loaded module's path without its `file://` scheme.

Regression tests: the CLI goldens named in the Phase 4.4 PRs (`tests/cli-cases/*`: one per
row above), `tests/internal/error.test.yo` (`reanchor_primary_at`, the classifier's
negative cases).
