# Diagnostic E-codes are assigned by substring-matching the rendered message, so unrelated errors inherit the wrong code — and `yo explain` then gives wrong advice

**Found**: 2026-09-04, probing parser/evaluator diagnostics with `yo check` on
yo 0.2.24 while checking documented Yo-syntax pitfalls. **Severity:** MEDIUM
(wrong value on a user-facing channel): a destructuring-label error is reported as
`error[E0401]`, the *name not found* family, and the `yo explain E0401` text it
points the user at is about spelling and definition ORDER — neither of which has
anything to do with the failure.

## Reproducer

`p_destr.yo`:

```rust
{ println } :: import("std/fmt");
S :: struct(a : i32, b : i32);
main :: (fn() -> unit)({
  s := S(a : i32(1), b : i32(2));
  { a, zzz } := s;
  println(a.to_string());
  println(zzz.to_string());
});
export(main);
```

```
$ yo check p_destr.yo          # yo 0.2.24
error[E0401]: Label "zzz" being destructured not found.
  --> p_destr.yo:5:3
  |
5 |   { a, zzz } := s;
  |   ^
help: run `yo explain E0401` for more information
```

And the advice that hint leads to:

```
$ yo explain E0401
E0401 — name not found

No binding with this name is visible at this point.

Check the spelling first. Then check ORDER: module-level definitions are processed top-to-bottom, so a function must be defined BEFORE its callers (helpers first, callers last). An identifier from another module needs the module imported, and a type from it is reached through the module value.
…
`helper` is defined after its caller — move it above.
```

Expected: either no code (honest — the design permits codeless diagnostics) or a code
for the destructuring/field family. `zzz` is not an unresolved *name*; it is a label
that `S` has no field for, and no amount of reordering or importing will fix it.

## Root cause

Codes are not attached at the site that raises the error. They are inferred
afterwards by matching substrings of the already-rendered English message —
`_classify_message`, `src/error.yo:89-188`, a 25-branch chain of
`starts_with`/`contains` tests. Every diagnostic constructor routes through it:
`_diagnostic_of_token` (`src/error.yo:190-200`, used by `format_error_message`
`:225-227`, `format_error_message_with_help` `:230-243` and `format_error_messages`
`:259-278`) and `format_raw_error` (`:246-256`).

The E0401 branch is `src/error.yo:128-132`:

```rust
if(msg.contains(String.from("not found.")) || msg.contains(
  String.from("not found ")
) || msg.contains(String.from("\" not found")), {
  return(_coded(E_VARIABLE_NOT_FOUND));
});
```

Three of the loosest substrings in the tree. The message raised at
`src/evaluator/exprs/destructuring_assignment.yo:327` —
``Label "${label}" being destructured not found.`` — matches all three, so it is
coded as a variable-not-found error even though it is raised from the
destructuring path.

By the same reading, other messages in unrelated families are captured too:

| message | raised at | band it belongs to | code it gets |
|---|---|---|---|
| `Label "X" being destructured not found.` | `src/evaluator/exprs/destructuring_assignment.yo:327` | patterns / destructuring | E0401 (reproduced above) |
| `Field "X" not found in trait "Y".` | `src/evaluator/calls/trait_type.yo:164` | types & traits, E06xx | E0401 |
| `Effect row variable "X" not found in scope. Declare it with generic(…)` | `src/evaluator/types/function.yo:2759`, `src/evaluator/types/future_trait.yo:82`, `:233` | effects, E09xx | E0401 |
| `Label "X" is not found in the extended module type.` | `src/evaluator/values/anonymous_module.yo:257`, `:301` | modules, E04xx | E0401 |

The same mechanism produces the mirror-image failure — a real family that gets no
code because its wording happens not to match. `E_EXPECTED_TOKEN` is
`msg.starts_with(String.from("expected "))` (`src/error.yo:95-97`), lowercase, which
is the parser's spelling (`src/parser.yo:682`, `:717`, `:749`). The evaluator
writes 273 messages beginning with a capital `Expected ` (counted over `src/**.yo`,
excluding the generated `src/yo-self-bin.c`), and none of them match:

```
$ cat p_comptime.yo
{ println } :: import("std/fmt");
id :: (fn(comptime(T : Type), x : i32) -> i32)(x);
main :: (fn() -> unit)({ println(`hi`); });
export(main);

$ yo check p_comptime.yo
error: Expected a label for function parameter, got comptime(T : Type)
  --> p_comptime.yo:2:11
  |
2 | id :: (fn(comptime(T : Type), x : i32) -> i32)(x);
  |           ^^^^^^^^
```

No code, no `yo explain` hint — for exactly the error a newcomer hits guessing Yo's
function-signature syntax, while the neighbouring mistakes do carry them
(`error[E0007]` for a brace-block written without semicolons, `error[E0001]` for a
trailing comma before `)`). Codeless diagnostics are by design —
`plans/reference/ERROR_DIAGNOSTICS_OVERHAUL.md:436-440` says allocation is
"incremental and frequency-driven … Unassigned sites render codeless", ratcheting
down — so the gap alone is expected. The mis-assignment is not.

Two further consequences of classifying on text follow directly:

- **Message text is silently load-bearing.** The design doc froze it for P1–P2
  (`plans/reference/ERROR_DIAGNOSTICS_OVERHAUL.md:519`) but expects catalog work to
  reword families afterwards (`:432-435`). Nothing links a wording to its code, so
  rewording a message drops or changes its E-code with no test failing and no
  reviewer signal — and codes are declared "never renumbered" (`:441-442`), a
  promise this mechanism cannot keep.
- **Ordering decides ties.** The 25 branches are tried in file order, so a message
  matching two families gets whichever appears first in `src/error.yo:89-188`, not
  the correct one.

## Fix

Attach the code where the error is raised, not by pattern-matching afterwards.

1. Add a code-carrying constructor next to the existing ones in `src/error.yo` —
   `format_error_message_coded(token, code, message)` — and let the raise site name
   the family from the `E_*` constants in `src/diagnostics.yo:52-80`. This is the
   channel `plans/reference/ERROR_DIAGNOSTICS_OVERHAUL.md` §5 describes ("codes are
   allocated per error FAMILY, not per site", `:432-435`); families stay coarse,
   only the *attachment* moves.
2. Convert sites family by family, highest-frequency first, exactly the incremental
   order the design already prescribes. `_classify_message` stays as the fallback
   for unconverted sites so nothing regresses, but it must be **narrowed as sites
   convert** — every pattern whose family is fully converted is deleted, and the
   loose ones (`"not found "`, `"not found."`, `"\" not found"`) go first, since
   they are the ones producing wrong codes today.
3. Give the destructuring and trait-field cases a correct home immediately: either
   a new E06xx family for "no such field/label on this type", or route them to the
   existing `E_MODULE_FIELD_NOT_FOUND` / a new sibling. Whichever is chosen needs a
   registry entry in `src/diagnostics_registry.yo` (bilingual, with `bad`/`good`
   examples — the registry test requires both,
   `plans/reference/ERROR_DIAGNOSTICS_OVERHAUL.md:467-475`).

Alternative considered and rejected: tightening the three `not found` substrings so
they no longer over-match. That fixes today's four messages and leaves the mechanism
— code determined by prose — in place, so the next reworded message re-creates the
bug. The maintainer's standing rule is that defects get fixed properly.

**Note for whoever converts sites**: `_classify_message` is exported
(`src/error.yo:423`) and directly tested, so its behaviour is pinned; narrowing it
means editing `tests/internal/error.test.yo:208-250` in the same change.

## Regression test

`tests/internal/error.test.yo` already asserts, per family, that a representative
message classifies (`:210-248`) and that unfamiliar text stays uncoded (`:249`).
What it lacks is the negative direction — that a message from family A does not
collect family B's code. Add:

- `_classify_message(`Label "zzz" being destructured not found.`)` must NOT be
  `E0401` (and, once the family exists, must be its own code);
- `_classify_message(`Field "x" not found in trait "T".`)` must NOT be `E0401`;
- `_classify_message(`Effect row variable "e" not found in scope.`)` must NOT be
  `E0401`;
- once a coded constructor exists, an end-to-end case in the same file rendering a
  destructuring error and asserting the `error[E…]` header and the
  `help: run \`yo explain E…\`` tail name the right family.

An end-to-end pin also belongs in the CLI corpus, where diagnostic output is already
golden-scored (`tests/cli-cases/*`, `stdout_keep_match=`).
