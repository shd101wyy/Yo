# PR #661 turns a string-literal enum payload from a C compile error into a silent wrong answer

**Status: OPEN against PR #661's branch (`fix-enum-pattern-bool-payload`,
`6fe1f8203`) — NOT a defect on `develop`.** Found 2026-09-13 while auditing
`match` for `plans/MATCH_PATTERN_MATCHING.md` (§3 gap 4). This should block that
PR's merge as it stands.

## Symptom

```rust
E :: enum(Tag(name : str), Empty);
pick :: (fn(e : E) -> i32)(
  match(e, .Tag("a") => 1, .Tag(n) => 2, .Empty => 0)
);
// pick(E.Tag("zzz"))  →  1   (expected 2)
```

| Compiler | Result |
| --- | --- |
| `develop` (`1780b90cb`, v0.2.31 seed) | **loud**: C compile fails, `error: duplicate case value '__YO_T15_TAG'` |
| a compiler built from #661's branch | **silent wrong answer**: compiles clean, `pick(E.Tag("zzz"))` returns `1` |

Reproducer: `issues/repros/pr661-string-literal-payload-binds-instead-of-comparing.yo`
— prints `a=1 (expect 2)  b=1 (expect 1)` on the #661 build.

## Root cause

#661 adds two token-kind tests that decide whether a payload parameter is a
literal to COMPARE or a name to BIND:

```rust
// src/evaluator/exprs/match.yo  and  src/codegen/exprs/match.yo
match(ast_expr_token(e).kind, .Bool => true, .Integer => true, .Float => true, _ => false)
```

`TokenKind.StringLit` is not in that set, and a string literal **is** an
`Atom` — so it sails past the pre-existing `Expected identifier, "_", or
labeled pattern` guard that the PR description assumed would catch it
("Strings/chars in payload positions still fail loudly … deliberately left").
It does not fail: it is treated as an ordinary binding whose name is the
literal's text.

The damage comes from the PR's other half. Same-variant arms are now merged
into ONE `case` block, and only arms with a recognised literal get an
`if (payload == lit)` guard. A string arm gets no guard, so it runs
unconditionally and its `break;` ends the case — the second arm's code is
emitted after that `break;` and is dead:

```c
  case TAG: {
    __yo_str _u34_a_u34_ = e.data.Tag.name;   // the literal "a", bound as a variable
    __yo_tmp = 1;
    break;                                     // first arm always wins
    __yo_str __yo_pat_n = e.data.Tag.name;     // dead code
    __yo_str n = __yo_pat_n;
    __yo_tmp = 2;
    break;
    break;
  }
```

Before #661 the two arms produced two `case TAG:` labels, which is why the C
compiler caught it.

## Fix

In the PR, reject a string (and char) literal in a payload position explicitly
rather than relying on the identifier guard — e.g. extend the literal test to
recognise `StringLit`/`CharLit` and throw
`Pattern "<lit>" is not supported in a payload position yet` at that point.
Real string patterns arrive in P3 of `plans/MATCH_PATTERN_MATCHING.md`.

Two neighbouring gaps found in the same pass, tracked in that plan's §3:

- **gap 1** — a literal-guarded arm still marks its variant covered, so
  `match(o, .Some(true) => 1, .None => 0)` passes exhaustiveness and leaves the
  result temp unassigned for `.Some(false)` (measured: returns `1`).
- **gap 2** — the async state-machine emitter is untouched, so the same source
  inside `io.async` with an `await` per arm is still `duplicate case value`.

## Verification (to add with the fix)

- The reproducer above must fail `yo check` with the new message.
- `tests/match_bind_nothing.test.yo`: a string payload arm is a check error.


**FIXED 2026-09-13 (match P0):** string/char literals in payload positions are now rejected loudly (`Pattern <lit> is not supported in a payload position yet`) at both the positional and the labeled slot; the evaluator never lets them through as binders, so the codegen grouping can never run one unguarded.