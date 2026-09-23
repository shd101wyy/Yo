# Type-error diagnostics point into std/prelude, use inconsistent codes, and leak internal names

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 4).
**Status:** OPEN. Diagnostics quality; complements
`issues/diagnostic-codes-are-assigned-by-substring-matching-the-message-text.md`.
**Measured:** yo 0.2.39 seed (`yo explain --list` knows 30 codes).

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
