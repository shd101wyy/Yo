# Strict Parentheses for Function Calls

## Problem

Yo currently allows function calls without parentheses:

```rust
add 3, 4         // same as add(3, 4)
return x         // same as return(x)
escape x         // same as escape(x)
&x               // unary-prefix form of &(x)
!x               // unary-prefix form of !(x)
```

This produces several classes of ambiguity:

1. **Unary-vs-tuple ambiguity.** `&x, y` parses as `&(x, y)` because the
   prefix form greedily consumes the entire following comma-separated list.
2. **`return` swallowing branches.** Inside `match` / `cond`, a paren-less
   `return x, .Other => …` swallows the next branch as a second argument
   (already documented in `.github/instructions/yo-syntax.instructions.md:476`).
3. **Prefix-vs-infix visual ambiguity.** Yo deliberately has **no operator
   precedence** (`stringIsOperator` in `src/token.ts` is a purely lexical
   test). Without precedence, expressions like `!ok && ready`, `-x + y`,
   `!a == b` are visually ambiguous to a human or LLM reader, regardless
   of how the parser actually disambiguates them.
4. **No structural rule.** "Sometimes parens are required, sometimes they
   aren't, and which case you're in depends on context (statement position,
   inside `cond`, comma vs newline, prefix vs infix)" is hard for both
   humans and LLMs to internalize.

Yo's design goal is to be **LLM-friendly with maximally unambiguous syntax.**
The current rule violates that goal.

## Proposed change

**Strict-parens rule for all non-infix applications**: every application
that is _not_ a binary infix or unary postfix operator must be written
with parentheses around its argument list. This includes:

- Identifier-form callees: `add`, `return`, `escape`, `throw`, `panic`,
  `comptime_assert`, etc.
- Symbolic prefix operators: `&`, `*`-deref, `!`, unary `-`, etc.

**Symbolic infix and postfix operators keep operator syntax** because
their visual structure (`a OP b`, `expr OP`) is inherently unambiguous
even without precedence.

```rust
// Before                       // After
add 3, 4                        add(3, 4)
return x                        return(x)
return ()                       return(())
escape ()                       escape(())
throw err                       throw(err)
&x                              &(x)
*p                              *(p)
!ok                             !(ok)
-n                              -(n)
&x, y                           &(x), y       // unambiguous

// Infix and postfix unchanged
a + b                           a + b
a == b                          a == b
a && b                          a && b
result?                         result?

// Composition is unambiguous in both parse and reading
!(ok) && ready                  // == not(ok), then && ready
!(ok && ready)                  // == not(ok && ready)
f(&(x), y)                      // 2-arg call: first arg &(x), second y
&(x, y)                         // & applied to (x,y); arity-error today
                                // since & is unary, but parse is fine
```

### Why prefix operators must also use parens

A first cut considered keeping `&x`, `!ok`, `-n` as bare prefix syntax with
the parse rule "prefix consumes one primary." That rule disambiguates the
_parser_, but it does **not** disambiguate the _human reader_, because Yo
has no operator precedence to fall back on. Without precedence, expressions
like:

```rust
!ok && ready    // is this !(ok && ready) or (!ok) && ready ?
-x + y          // is this -(x + y) or (-x) + y ?
!a == b         // is this !(a == b) or (!a) == b ?
```

are visually ambiguous to anyone (including LLMs) skimming the code. The
only honest fix in a no-precedence language is to require explicit grouping
around prefix operands. This makes the **visual structure** match the
**parse structure**:

> `OP` followed by `(` → prefix application of `OP`.
> `OP` between two expressions → infix application of `OP`.
> Anything else → parse error.

### What does NOT change

- **Infix binary operators** (`+`, `-`, `*`, `/`, `==`, `!=`, `<`, `>`, `<=`,
  `>=`, `&&`, `||`, `<<`, `>>`, `&+`, `&-`, etc.) keep infix syntax.
- **Pointer arithmetic operators** `&+`, `&-`, `&<`, `&>`, `&<=`, `&>=`
  remain infix (the `&` is part of the operator name, not a prefix).
- **Postfix operators** (`?` for Result unwrap, etc.) keep postfix syntax.
- **Method-call sugar** `x.method(args)` is unchanged — already paren-required.
- **Path / member access** `Module.Item`, `obj.field` is unchanged.
- **Type application** `Result(T, E)`, `Option(T)`, `Vec(u8)` — already
  paren-required, no change.
- **`if(cond, then, else)`, `cond(...)`, `match(scrutinee, ...)`** — already
  paren-required.
- **Bare expression statements** `expr;` — `;` is a statement separator, not
  an argument list.
- **String / template / numeric literals** — unchanged.
- **`break`, `continue`** with no argument remain bare (`break;`,
  `continue;`). Labeled forms (if added later) would use `break(label)`.

## Why this is the right call

1. **One rule, zero exceptions within each syntactic position.**
   - Application that is not infix-or-postfix → parens required.
   - Infix → `a OP b` form, no parens needed.
   - Postfix → `expr OP` form, no parens needed.
2. **Eliminates the entire ambiguity class.** No more `return x, .Other =>`
   swallow-the-branch, no more `&x, y` mis-grouping, no more `!ok && ready`
   visual ambiguity. All resolved by the same rule.
3. **Honest to the semantics.** In Yo, `return`, `escape`, `throw`, and
   the symbolic builtins are all functions in `BuiltinKeywords`. Parens
   make their call sites match every other call site.
4. **No precedence introduced.** The fix is purely syntactic
   (parens-required-here), not a precedence change. Yo's no-precedence
   design is preserved.
5. **Trivial parser surface.** The parser becomes "callee then `(`" for
   every non-infix application. The greedy "consume comma-list" code path
   is removed entirely. The self-hosted parser (`yo-self/parser.yo`) shrinks.
6. **Negligible token cost.** `return(x)`, `&(x)`, `!(ok)` are 2 chars
   longer than `return x`, `&x`, `!ok`. LLMs already emit parenthesized
   calls natively across all major models, and the uniform rule reduces
   their error rate further.

## Resolved decisions

| #   | Question                           | Decision                                                                                                                                 |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Whitespace between callee and `(`? | **Disallowed.** `f (x)` is a parse error. Required form: `f(x)`.                                                                         |
| Q2  | Zero-arg `return` / `escape`?      | **Both `return;` and `return();` are valid** and desugar to `return(())`. Same for `escape`. No zero-arg shorthand for any other callee. |
| Q3  | Range `a..b`, `a..=b`?             | **Unchanged** — infix operators.                                                                                                         |
| Q4  | Lambda call `((x) => …)(5)`?       | **Unchanged** — already paren-required.                                                                                                  |
| Q5  | Migration tool?                    | **Not needed.** Migrate the Yo codebase manually; no backwards compat for external code.                                                 |

## Implementation phases

### Phase 1 — Parser

- `src/parser.ts`: remove the paren-less call code paths.
  - For any callee where the next token is _not_ `(`, raise a parse error
    suggesting the parenthesized form. This covers both identifier-form
    callees (`return x` → `return(x)`) and symbolic prefix callees
    (`&x` → `&(x)`).
  - Whitespace between callee and `(` is **disallowed** (Q1). The lexer/
    parser must enforce that `(` immediately follows the callee token with
    no intervening whitespace; otherwise treat as separate tokens (which
    will then fail to parse, producing a clear error).
  - Special-case for control-flow builtins (`return`, `escape`, optionally
    `throw`): also accept the bare-statement form `return;` / `escape;` and
    the zero-arg form `return()` / `escape()` — both desugar to
    `return(())` / `escape(())` in the evaluator (Phase 3.5).
  - Keep current logic for infix operators, postfix `?`, `.field`,
    `.method(...)`, `[index]`.
- Improve error messages: when the parser sees the old form, emit a clear
  diagnostic suggesting the parenthesized form, e.g.
  `error: function/operator call requires parentheses; did you mean 'return(x)'?`.

### Phase 2 — Migrate the Yo codebase

Manually rewrite all `.yo` files to the strict-parens form. No migration
tool is shipped; we don't preserve backwards compatibility for external
code at this stage. Cover:

- `std/`
- `tests/`
- `yo-self/`
- `docs/en-US/` and `docs/zh-CN/` code blocks
- `examples/`, `vscode-extension/snippets/` if present
- `src/tests/fixme.yo` and any other in-repo `.yo` files

Recommended approach: do this phase as a single mechanical commit per
directory tree, after Phase 1 lands so the parser itself catches any
missed sites at compile time.

### Phase 3 — Self-hosted compiler

- Update `yo-self/lexer.yo` and `yo-self/parser.yo` to enforce the new rule
  (mirror the changes made in Phase 1 to `src/parser.ts`).
- Update `yo-self/tests/` AST-shape assertions where needed.

### Phase 3.5 — Evaluator: zero-arg `return` / `escape` ⇒ unit

To keep the common "return nothing" case ergonomic, the evaluator treats
both `return;` (bare statement, already supported today) and `return()`
(new: zero-argument call) as equivalent to `return(())`. Same for
`escape`.

```rust
return();      // == return(())   ← NEW
return;        // == return(())   ← already works today
escape();      // == escape(())   ← NEW
escape;        // == escape(())   ← already works today
```

Justification:

- Local to a small set of control-flow builtins.
- Does not re-introduce the swallow-the-comma bug, because `return;` has
  no argument list at all and `return()` has an empty parenthesized list.
- Matches the natural reading from C, Rust, Swift, etc.

Implementation:

- Parser: accept `return` / `escape` as a bare callee in statement position
  when followed by `;` (already works); also accept the zero-arg call form
  `return()` / `escape()` (new).
- Evaluator: in the call-resolution path for these builtins, when the
  argument list is empty, synthesize a single `()` argument before type
  checking and codegen.

### Phase 4 — Documentation & instructions

- Update `.github/instructions/yo-syntax.instructions.md`:
  - Remove the "return without parentheses consumes all following…" section.
  - Remove the "`!x && y` parses as `!(x && y)`" pitfall section.
  - Add: "All non-infix/postfix applications require parentheses, including
    identifier-form callees and symbolic prefix operators (`&`, `*`, `!`,
    unary `-`). Whitespace between callee and `(` is disallowed.
    `return;`, `return()`, `escape;`, and `escape()` are sugar for
    `return(())` / `escape(())`."
- Update `.github/instructions/yo-design.instructions.md`.
- Update `.github/skills/yo-syntax/syntax-cheatsheet.md` and
  `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md`.
- Update `docs/en-US/` and `docs/zh-CN/` (both languages — see
  `documentation.instructions.md`).

### Phase 5 — VS Code extension

- `vscode-extension/syntaxes/`: TextMate grammar likely highlights `return`,
  `escape`, etc. as keywords. Verify highlighting still works (cosmetic
  only).

### Phase 6 — Verification

- `bun run build` (TypeScript clean).
- `bun test src/tests/build-system.test.ts --timeout 10000`.
- `./yo-cli test --bail` (full integration suite over `./tests/`,
  ~30 min on M4) — **must pass**.
- `./yo-cli test ./yo-self/tests/ --disable-sanitize --parallel 1` —
  **not gated**. The self-hosted test suite is not currently passing on
  this branch's baseline; we update its sources for the new syntax in
  Phase 3 but do not block on its results.
- Compile and run a few representative examples manually.

## Risks

- **Bootstrap churn.** `yo-self/` is mid-development; Phase 3 must be
  carefully sequenced after Phase 1 lands.
- **Doc code blocks.** Markdown code blocks need manual rewriting alongside
  the migration in Phase 2.
- **Hidden uses in tests.** Some `comptime_expect_error` tests may
  intentionally use the old form to assert error handling — those need
  manual review and may need updating to assert the _new_ error.
- **Verbosity for pointer-heavy code.** Code that uses `&`, `*` extensively
  (parts of `std/sys`, allocator code) becomes more verbose. Accepted as
  the cost of unambiguous prefix syntax in a no-precedence language.

## Non-goals

- Changing infix operator behavior or introducing precedence.
- Removing or changing `cond` / `match` / `if` syntax.
- Removing the `using` / `given` algebraic-effect syntax.
- Touching the type-application syntax.
- Backwards compatibility with old-syntax Yo code (Q5 — out of scope for now).

## Rollout

This is a breaking change with no backwards-compat shim. Bump the Yo
version (semver minor since pre-1.0) and document it in the changelog.
