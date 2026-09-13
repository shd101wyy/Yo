# `match` — real pattern matching: audit, design, implementation plan

**Status: ACTIVE (2026-09-13).** Design + execution plan. **P0 LANDED
2026-09-13 (#672, 28/28 CI green):** B1 float chain, B3 duplicate variant
arm, A2 wildcard-last on primitives, #661 gaps 1/3/4 (exhaustiveness,
`-1`, loud string-payload rejection), the async emitter's same-variant
grouping with literal guards (gap 2) and its labeled/curly destructuring
rewrite (A3), the shared literal helpers in `codegen/utils/index.yo`, and
the dead `=> rename` branch deleted. Two of the three issues the audit
filed are closed (`issues/fixed/pr661-string-literal-payload-…`,
`issues/fixed/async-match-arm-labeled-…`). P1 is next; §8's decision on
`src/pattern.yo` still blocks it.
Companion of PR #661 (`match: a literal payload in an enum pattern is COMPARED,
not bound`), the narrow stop-gap for one row of the audit below. §3 says what it
fixes, what it leaves open, and how it fits this plan — **including one
regression it introduces that should block its merge** (§3 gap 4), measured
against a compiler built from its branch.

**Goal (maintainer, 2026-09-13):** *"improve our current `match` expr, make it
real pattern matching. Right now we don't support matching arms by values, like
Rust does."*

**Measured against:** tree `1780b90cb` (develop, v0.2.32 bump), `yo 0.2.30` on
PATH and the v0.2.31 seed in `~/.cache/yo/versions/0.2.31`, `--std-path ./std`.
Every row of §2 was run, not read. Probe sources are described inline so they
can be re-run; the ones that become tests are listed per phase in §6.

---

## 0. TL;DR

- **Value matching already exists, but only on one narrow path.** A scrutinee
  whose type is an integer, `bool`, `u8`/`u32` (char literals), or a
  `comptime_*` primitive goes through `evaluate_primitive_match`, which accepts
  literals, comptime-known **named constants** (`TEN => …` compares, it does not
  bind), and or-patterns spelled `(1 | 2)` / `|(1, 2)`, and lowers to a C
  `switch`. Everything else — an enum scrutinee — goes through a second,
  hand-rolled path that accepts exactly `.Variant`, `.Variant(binders…)`, and
  `_`. **Neither path composes with the other**: a literal inside a variant
  payload is a *binding named `0`*, `.A | .B` is "Invalid pattern", `.Ok(.Some(v))`
  is rejected, and a `str`/`String`/tuple/struct scrutinee is rejected outright.
- **Three shapes pass `yo check` and then fail in the C compiler** (float
  scrutinee → `switch` on `double`; a literal payload at runtime →
  `int32_t 0 = …` + duplicate `case`; a duplicated enum arm → duplicate `case`),
  and **three shapes give a silent wrong answer** (a literal payload with a
  comptime-known scrutinee picks the first same-variant arm; `_` before a
  literal arm on a primitive is order-insensitive; a labeled/curly pattern in
  an await-carrying arm binds nothing and the body reads zeros). Details in §2.
- **The design (§4) keeps the surface syntax** — a pattern stays an ordinary
  expression the parser already produces, so nothing changes in
  `src/parser.yo` and the formatter/LSP keep working — and replaces the two
  hand-rolled interpreters with **one compiled `Pattern` IR** consumed by the
  evaluator (typing, CTFE, exhaustiveness via the usefulness algorithm), the
  sync C emitter, the async state-machine emitter, and (later) the verifier.
  Codegen keeps today's `switch` for every match that is switch-shaped
  (emit-diff gate: byte-identical) and adds an ordered test-chain lowering for
  everything the switch cannot express.
- **New forms, in Rust's order of value for this codebase:** literal payloads
  and nested variant patterns; string patterns (401 `cond` arms in `src/`+`std/`
  compare against string literals today, 126 of them in `src/main.yo`);
  or-patterns on variants; an identifier catch-all; guards spelled
  `(pattern && (cond)) => body`; whole-value bindings spelled
  `(name := pattern) => body`; ranges `(1..=5) => body`; tuple and struct
  scrutinees. No new tokens (`@` is not in the closed operator set and is not
  worth opening it for).
- **Plan (§6):** P0 closes the check-green/C-red holes and absorbs #661's
  evaluator half with the exhaustiveness fix and the string-payload rejection it
  lacks (§3 gaps 1 and 4 — as it stands #661 turns a compile error into a silent
  wrong answer for `.Tag("a")`); P1 introduces the IR
  behind the existing behaviour (no new syntax, emit-diff identical); P2 turns
  on nested/literal/or/catch-all with the test-chain lowering in BOTH emitters;
  P3 adds strings, ranges, guards, `:=`; P4 tuples/structs; P5 docs + adoption
  in `src/`/`std/` (seed-gated); P6 verifier subset extension.

---

## 1. How `match` is built today

### 1.1 There is no pattern grammar

`match(scrutinee, p1 => b1, p2 => b2, …)` is a plain `FnCall` whose callee is
the builtin keyword `match` (`BK_MATCH`). Each arm is the reserved infix `=>`
applied to two ordinary expressions. **A pattern is whatever expression the
parser produced**; the evaluator interprets it structurally afterwards. Three
consequences shape everything below:

| Fact | Where | Consequence for patterns |
| --- | --- | --- |
| `.Variant(a, b)` parses as `(.(Variant))(a, b)` — a call whose callee is the one-arg `.` call; bare `.Variant` is `.(Variant)`. | `src/parser.yo`, read back by `_arm_variant_and_params` (`src/codegen/exprs/match.yo:1089`) | The evaluator recognises a variant arm by *shape of the call*, not by a pattern node. |
| `{a, b: c}` in ANY expression position is the anonymous struct literal `_(a: a, b: c)` (`BK_ANON_STRUCT`). | `parse_curly_bracket_expr`, `src/parser.yo:950-1110` | The "curly destructuring" form documented in `.github/instructions/yo-syntax.instructions.md` is just the match evaluator unwrapping a one-arg `_(...)`. |
| Yo has **no operator precedence**: two different adjacent infix operators are a parse error (`error[E0003]: Adjacent different operators need parentheses`). | `plans/reference/OPERATOR_SET_AND_PRECEDENCE.md` | Every infix pattern operator needs its own parentheses: `(2 \| 3) => …` (already required today), and in this design `(p && (g)) => …`, `(x := p) => …`, `(1..=5) => …`. |

Nothing else in the front end knows about patterns: `src/expr_traversal.yo`
walks both sides of every `=>` arg uniformly; `src/formatter.yo` formats a
pattern as an expression; the LSP resolves pattern bindings by spelling
(`issues/lsp-references-and-rename-match-by-spelling.md`).

### 1.2 The evaluator — two hand-rolled interpreters

`evaluate_match` (`src/evaluator/exprs/match.yo:1165`) evaluates the scrutinee
(as a *place* when it is a variable / field chain, so no owning temp is minted —
`is_place_expression`), derefs one pointer level, resolves a leaked enum
self-shell, then dispatches **on the scrutinee type**:

| Scrutinee type | Path | Accepted arm shapes | Exhaustiveness | Notes |
| --- | --- | --- | --- | --- |
| `is_matchable_primitive_type`: integers, floats, C-compatible ints, `bool`, `comptime_int`/`comptime_float`/`comptime_str` | `evaluate_primitive_match` (`:254`) | `_`; any expression that **evaluates to a compile-time-known value** of a type compatible with the scrutinee (literal, typed literal, negative literal, char literal, `::` constant); or-patterns `\|(a, b)` flattened by `flatten_or_pattern` | bool: needs both `true` and `false` or `_`; everything else: **requires `_`** | Duplicate literal → error. A runtime identifier → `Match patterns must be compile-time known values`. The pattern values are stashed on the arm's `ExprInfo` (`primitive_pattern_values`) and the match is stamped `is_primitive_match` for codegen. |
| `is_enum_type` (after deref / shell resolution) | the arm loop in `evaluate_match` | fieldless `.V` (also allowed for variants WITH fields — "bind nothing"), `_`, with-fields `.V(p…)` where every `p` is an identifier, `_`, `label : identifier`, `label : _`, or the single curly `_(…)` wrapper | variant-name coverage: every variant not in `checked_variant_names` and GADT-reachable is reported | Anything else in a payload position → `Expected identifier, "_", or labeled pattern (label: variable)`. Anything else as an arm → `Invalid pattern in match expression … Supported patterns: .VariantName / .VariantName(param…) / _`. |
| anything else (`str`, `String`, tuple, struct, `Type`, …) | — | — | — | `Expected enum type or primitive type (integer, bool) for match expression, got T` |

Per-arm bookkeeping shared by both paths: `case_executed` on the pattern node
(comptime branch elimination — codegen skips arms whose pattern was never
"executed"), the running result type threaded as `expected_type` into the next
arm body (bare `.None` inference), `is_executing` toggled per arm from the
scrutinee's known value, env-frame discipline (`base_frame_count`,
`pop_frame_nonmutating`) and the env merge across non-returning bodies.
GADT refinement (`_is_gadt_branch_reachable`, `_gadt_refined_expected`) lives on
the enum path only.

### 1.3 Codegen — four lowerings, plus two more emitters that know about arms

`generate_match_expression` (`src/codegen/exprs/match.yo:1223`) declares the
result temp, materialises the subject (dup if the evaluator deferred one), then:

| Condition | Lowering | Function |
| --- | --- | --- |
| `is_primitive_match` | `switch (x) { case <lit>: … default: … }` — or-pattern → stacked `case` labels; `_c_literal_from_value` renders `IntLit`/`FloatLit`/`BoolVal` | `generate_primitive_match_expression` |
| `can_optimize_as_nullable_pointer` (Option-like enum over a pointer) | `if (p == NULL) … else …` | `_gen_nullable_ptr_match` |
| `can_optimize_as_simple_enum` (fieldless) | `switch (tag)` | `_gen_simple_enum_match` |
| otherwise | `switch (x.tag) { case TAG: { <binds from .data.V.field>; body; break; } }` | `_gen_tagged_union_match` + `_emit_destructure_binds` |

Two other emitters re-implement arm handling and must move in lock-step with any
pattern change:

- **The async state machine** (`_generate_match_with_await_impl`,
  `src/codegen/async/state_code_gen.yo:3340`): its own `switch (tag)`, its own
  destructuring loop that binds **positional atoms only**
  (`if(ast_expr_is_atom(dvar), …)` at `:3580`) into SM fields or C locals. It
  shares no helper with `codegen/exprs/match.yo`, and it is already wrong for
  the labeled/curly forms the sync emitter accepts (§2.1 A3,
  `issues/async-match-arm-labeled-destructure-binds-nothing.md`).
- **The verifier** (`src/verifier/vc.yo:985-1230`, V3): encodes variant patterns
  as SMT datatype tests; any non-variant, non-wildcard pattern is
  `_fail_subset("non-variant match pattern (outside the V3 subset)")`.

`derive(...)` rules generate `match` ASTs with positional `.V(a, b)` patterns
only, so they are unaffected by additions (and are a canary for regressions).

### 1.4 One dead branch

`_emit_variant_arm_body` / `_gen_tagged_union_match` carry a "`=> rename`
caseBody form: bind the whole matched value to a name" branch
(`src/codegen/exprs/match.yo:1178-1193`). The evaluator has no counterpart —
`pattern => name => body` parses left-associatively into an "Invalid pattern",
and `pattern => (name => body)` is a closure literal. It is a TS-era vestige and
should be deleted, not extended (the `:=` binding in §4.2 replaces the idea).

---

## 2. Audit — measured behaviour on `1780b90cb`

"CT" = compile-time-known scrutinee (a module-level `K :: …`); "RT" = runtime
scrutinee (derived from `args().len()` so no folding). A bare literal scrutinee
`match(7, …)` is rejected at check with `Failed to evaluate the match
scrutinee expression: 7` (it has no `variable_name`); every CT probe used a
named constant.

### 2.1 Silent wrong answers (highest severity)

| # | Shape | Result |
| --- | --- | --- |
| A1 | `K :: Option(i32).Some(i32(5)); match(K, .Some(0) => "zero", .Some(v) => "nonzero", .None => "none")` | prints **`zero`**. `0` is bound as a variable named `0`; the first same-variant arm wins. No diagnostic. (The runtime twin at least dies in the C compiler — B2.) **PR #661 fixes this row.** |
| A2 | `match(x, _ => "a", 1 => "b")` on `i32`, x = 1 | prints **`b`**. The `switch` is order-insensitive; Rust returns `"a"` and flags the unreachable arm. The `"_" … must be the last match arm` message only fires on a SECOND `_`. On an enum the same shape IS rejected — the two paths disagree. |
| A3 | inside `io.async`, an arm with an `await` and a labeled or curly pattern: `.Rect({ width, height : h }) => { io.await(yield(io), io); (width * h) }` on `Rect(4, 5)` | prints **`0`** (expected 20). The async emitter's own destructuring loop binds bare atoms only, so the labeled/curly bindings are never assigned and the body reads zeroed state-machine fields; the positional twin prints 20. Same on develop + v0.2.31 seed and on the #661 build. Filed: `issues/async-match-arm-labeled-destructure-binds-nothing.md` (+ repro). |

### 2.2 `yo check` green, C compile red

| # | Shape | C error |
| --- | --- | --- |
| B1 | `match(f : f64, 1.5 => …, 2.0 => …, _ => …)` (CT version folds correctly) | `statement requires expression of integer type ('double' invalid)` — `is_matchable_primitive_type` admits floats, `generate_primitive_match_expression` emits `switch`. |
| B2 | `.Some(0) => …, .Some(v) => …` with a runtime scrutinee | `int32_t 0 = o.data.Some.value;` and `duplicate case value '__YO_T15_SOME'`. **#661 fixes this row.** |
| B3 | `.Red => r1, .Red => r2` | `duplicate case value '__YO_T7_RED'`. The primitive path reports `Duplicate pattern value: 1` for the same mistake; the enum path has no check. |

### 2.3 Rejected today, wanted

| # | Form | Today's error (verbatim) |
| --- | --- | --- |
| C1 | `str` / `String` scrutinee: `match(s, "a" => …, _ => …)` | `Expected enum type or primitive type (integer, bool) for match expression, got str` (same with `String`). `comptime_str` works (CT only). |
| C2 | nested `.Ok(.Some(v))` | `Expected identifier, "_", or labeled pattern (label: variable) for destructuring parameter, got .Some(v)` |
| C3 | or-pattern on variants `(.Red \| .Green)` / `\|(.Red, .Green)` | `Invalid pattern in match expression: .Red \| .Green` (bare `.Red \| .Green =>` is the E0003 paren error). Or-patterns exist ONLY on the primitive path. |
| C4 | ranges `(1..5)`, `(1..=5)` | `Failed to evaluate pattern expression: 1 .. 5` — the `..` trait call yields a `Range(i32)` struct, which the primitive path then rejects as a pattern value. |
| C5 | guards, every spelling tried (`x if x > 5`, `if(x > 5) =>`, `.Some(v) if (…)`, `.Some(v) where (…)`) | `error[E0008]: paren-less function and operator calls are not supported` / `Failed to evaluate pattern expression: if(x > 5)` |
| C6 | identifier catch-all `other => …` | int: `Failed to evaluate pattern expression: other`; enum: `Invalid pattern in match expression: other` |
| C7 | whole-value binding (`whole @ .Circle(r)`, `=> rename`) | `error[E0006]: unknown operator in '@'` ; `Invalid pattern in match expression: .Circle(r) => whole` |
| C8 | tuple scrutinee `match((a, b), (0, 0) => …)` | `Expected enum type or primitive type (integer, bool) for match expression, got Tuple(0 : i32, 1 : i32)` |
| C9 | struct scrutinee `match(p, Point(x : 0, y) => …)` / `{x, y} => …` | `… got Point` |
| C10 | enum-constant / qualified-variant patterns `RED :: Color.Red; match(c, RED => …)`, `Color.Red => …` | `Invalid pattern in match expression: RED` / `…: (Color.Red)` |
| C11 | `Type` dispatch `match(T, i32 => …, _ => …)` | `… got Type` (out of scope here — §5) |

### 2.4 What works today (keep working, byte-identical emit)

| Form | CT | RT | Emit |
| --- | --- | --- | --- |
| int literals `1`, `i32(1)`, `-1`; `u8`/`u32` with char literals `'a'` | ✅ | ✅ | `switch`, `case -1:` |
| `bool` `true`/`false` (exhaustive by enumeration) | ✅ | ✅ | `switch` |
| named comptime constant as a comparison: `LIMIT :: i32(5); … LIMIT => …` | ✅ | ✅ | `case 5:` (`tests/basic.test.yo` "classify_tens" depends on this) |
| or-patterns `(1 \| 2)`, `\|(1, 2)`, nested `\|(\|(1, 2), 3)` | ✅ | ✅ | stacked `case` labels |
| `comptime_str` scrutinee with string-literal arms | ✅ | n/a | folded |
| enum: `.V`, `.V(a, b)`, `.V(label : x)`, `.V({a, b: c})`, `.V({})`, `_`, pointer auto-deref, GADT refinement | ✅ | ✅ | tag `switch` / nullable-pointer `if` |
| exhaustiveness: missing variant, int without `_`, bool missing a value; duplicate literal | ✅ | ✅ | — |

### 2.5 Usage in this repository (motivation numbers)

| Measure | Count |
| --- | --- |
| `match(` in `src/` + `std/` | 13,552 |
| `cond(` in `src/` + `std/` | 2,759 |
| `cond`/`match` arms whose test is `<expr> == "literal"` | **401** (`src/main.yo` 126, `src/verifier/vc.yo` 35, `src/evaluator/builtins/comptime_numeric_fns.yo` 35, `src/evaluator/exprs/identifer_and_operator.yo` 32, …) |
| arms of the shape `… => match(` (two-level matching because nesting is rejected) | 1,366 |
| `primitive_pattern_values` setter calls per self-emit (`src/expr_info.yo:351`) | **4** — the primitive path is essentially unused by the compiler itself |

String matching and nested variant patterns are the two forms this codebase
would use immediately; everything in §2.4 is what it uses today.

---

## 3. PR #661 — what it fixes, what it leaves

#661 (branch `fix-enum-pattern-bool-payload`) makes a **literal payload atom**
in a variant pattern — an atom whose token kind is `Bool`, `Integer` or `Float`
— a comparison instead of a binding:

- evaluator: `_pattern_param_is_literal`, `_pattern_literals_match_scrutinee`
  gate `matched_body_idx` for a comptime scrutinee; literal params bind nothing;
- codegen (sync only): same-variant arms share ONE `case` block, each literal
  arm guarded by `if ((x).data.V.f == lit)`, an unguarded same-variant arm is
  the catch-all, a trailing `break;` stops fall-through.

It closes A1 and B2 exactly and grows `tests/match_bind_nothing.test.yo` by
four cases. It is the right stop-gap **provided four gaps are closed with it or
right after** — all four are consequences of adding a *refutable* sub-pattern
without touching the exhaustiveness/ordering model:

1. **Exhaustiveness hole.** `checked_variant_names.push` still fires for a
   literal-guarded arm, so `match(o, .Some(true) => 1, .None => 0)` passes the
   variant-coverage check with `Some` "covered". At runtime a `.Some(false)`
   enters the `case`, fails the guard, hits the trailing `break;`, and the result
   temp is **never assigned** (C: indeterminate value; -O2 may fold anything).
   Fix: an arm with any refutable sub-pattern must not count as covering its
   variant unless a same-variant arm with only irrefutable sub-patterns (or `_`)
   exists — this is exactly the "usefulness" question §4.6 answers in general.
2. **Async emitter untouched.** `_generate_match_with_await_impl` still emits
   one `case TAG:` per arm and binds every positional atom, so the same source
   inside an `io.async` body with an `await` in an arm is B2 again (duplicate
   `case`), or — with #661's evaluator change and an arm whose payload atom is
   skipped — an unbound name.
3. **Coverage of "literal".** `-1` is a prefix-`-` call, not an atom → still
   rejected with `Expected identifier, "_", or labeled pattern …, got -(1)`
   (measured). Acceptable for a stop-gap, but the plan below must not inherit
   the token-kind test as its definition of "literal".
4. **A STRING literal payload becomes a silent wrong answer — a regression.**
   The PR's description says strings "still fail loudly at the existing
   `Expected identifier, …` guard". They do not: a string literal *is* an
   `Atom`, so it passes that guard, and `TokenKind.StringLit` is not in the
   Bool/Integer/Float set the new `_pattern_param_is_literal` tests. Result:
   the arm is treated as a BINDING, the new grouping merges it into the
   variant's single `case` with **no guard**, and the first arm wins
   unconditionally. On develop the same source is a loud C error
   (`duplicate case value`); on #661 it compiles and answers wrongly — see
   §3.1. Fix: reject a string/char literal in payload position explicitly
   (`Pattern "<lit>" is not supported in a payload position yet`) until P3
   implements string patterns properly. Filed with its reproducer:
   `issues/pr661-string-literal-payload-binds-instead-of-comparing.md`.

Recommendation: **do not merge #661 as it stands.** Gap 4 turns a compile error
into a silent wrong answer, which is strictly worse than the bug being fixed.
Merge after (a) gap 4 is rejected loudly, (b) gap 1's exhaustiveness rule is
added with a red-first test (`.Some(true)` + `.None` without a `.Some(_)` must
be `Match expression is not exhaustive`); gap 2 (async) is filed against P0
below, and P1/P2 then replace the grouping/guard emitter with the general
lowering. Everything asserted here was measured against a compiler built from
the branch — §3.1.

### 3.1 Verification record — measured on a compiler built from `fix-enum-pattern-bool-payload` (`6fe1f8203`, v0.2.31 seed, 2026-09-13)

| Probe | Result |
| --- | --- |
| #661's own case: `.Some(false) => 200, .Some(true) => 100, .None => 0` at runtime | ✅ `a=200 b=100 c=0` — the fix works. |
| **Gap 1** — `pick :: (fn(o : Option(bool)) -> i32)(match(o, .Some(true) => 1, .None => 0))` called with a runtime `.Some(false)` | `yo check` **passes**; the binary prints `r=1` — an indeterminate result temp (the value happens to be the other arm's). Emitted C: |
| **Gap 2** — the same two literal arms inside `io.async` with an `await` in each arm | `yo check` passes; C compile fails: `error: duplicate case value '__YO_T_17610571303979907226_SOME'` — the async emitter still emits one `case` per arm. |
| **Gap 3** — `.Some(-1) => …` | rejected: `Expected identifier, "_", or labeled pattern (label: variable) for destructuring parameter, got -(1)` (a prefix-minus call is not an atom). |
| **Gap 4** — `E :: enum(Tag(name : str), Empty); match(e, .Tag("a") => 1, .Tag(n) => 2, .Empty => 0)` | **REGRESSION.** develop: C compile fails, `duplicate case value '__YO_T15_TAG'`. #661: compiles and prints `a=1` where 2 is correct — `.Tag("zzz")` takes the `"a"` arm. Emitted C below. |
| **A3** (independent of #661) — curly pattern in an await-carrying arm | prints `result=0`; positional control prints `result=20` (see §2.1). |

```c
static inline int32_t pick(Option_bool o) {
  int32_t __yo_tmp;
  switch ((o).tag) {
  case SOME: {
    if ((o.data.Some.value == true)) {
        __yo_tmp = 1;
        break;
    }
    break;                 // .Some(false): nothing assigns __yo_tmp
  }
  case NONE: { __yo_tmp = 0; break; break; }
  }
  return __yo_tmp;         // indeterminate
}
```

Gap 4's `case` on the #661 build — one block, no guard, the string literal
bound as a C variable and the second arm's binds emitted after an unconditional
`break;`:

```c
  case TAG: {
    __yo_str _u34_a_u34_ = e.data.Tag.name;   // the literal "a", bound
    __yo_tmp = 1;
    break;                                     // first arm always wins
    __yo_str __yo_pat_n = e.data.Tag.name;     // dead code
    __yo_str n = __yo_pat_n;
    __yo_tmp = 2;
    break;
    break;
  }
```

(Identifiers shortened; the originals are `yo_id_4160728081331058065000000`,
`_file____priv_temp_66478190099754336230` and
`__YO_T_17799744513434391442_TAG` in the `--emit-c` output.)

---

## 4. Design

### 4.1 Principles

1. **Syntax stays "patterns are expressions".** Every form in §4.2 already
   parses today — each one clears the parser and dies in the *evaluator*, which
   is exactly the layer this plan rewrites (measured with the v0.2.31 seed,
   2026-09-13):

   | Spelling | Today's error |
   | --- | --- |
   | `(whole := .Some(v)) => v` | `Invalid pattern in match expression: whole := .Some(v)` |
   | `(.Some(v) && (v > 100)) => 1` | `Invalid pattern in match expression: .Some(v) && (v > 100)` |
   | `(1..=5) => 1` | `Failed to evaluate pattern expression: 1 ..= 5` |
   | `"a" => 1` on a `str` | `Expected enum type or primitive type (integer, bool) …, got str` |
   | `.Ok(.Some(v)) => v` | `Expected identifier, "_", or labeled pattern …, got .Some(v)` |
   | `(0, 0) => 0` on a tuple | `Expected enum type or primitive type …, got Tuple(0 : i32, 1 : i32)` |

   The unparenthesized spellings (`x := .Some(v) =>`, `.Some(v) && (g) =>`,
   `1..=5 =>`) are the E0003 adjacent-operator parse error, per §1.1 — hence the
   parentheses in every form above. No change to `src/parser.yo`, no new tokens,
   the formatter and LSP see ordinary expressions, and `fmt` idempotence is a
   test not a feature.
2. **One Pattern IR, compiled once per arm, read by every consumer.** The
   evaluator stops interpreting arm ASTs ad hoc; the sync emitter, the async
   emitter and the verifier stop re-deriving variant/param structure from call
   shapes.
3. **Rust semantics where Yo can afford them:** first-match in source order,
   bindings introduced per arm, or-alternatives must bind the same names with
   the same types, guards see the bindings, exhaustiveness is checked by
   usefulness, an unreachable arm is diagnosed.
4. **Yo's existing permissiveness is kept:** bare `.V` and `.V({})` bind nothing
   even for variants with fields; labeled/curly forms are partial; positional
   form is exact-arity.
5. **Errors, not warnings, until the warnings channel exists**
   (`src/diagnostics.yo` has `Severity.Warning` but no channel). Unreachable arm
   = error, as `Duplicate pattern value` is today.
6. **Emit-diff gate:** every match that is switch-shaped today must emit
   byte-identical C after P1/P2 (`plans/backlog` memory rule "optimizer-change
   emit-diff gate" applies — compare per-function bodies with `__yo_tN`
   normalised).

### 4.2 Pattern forms

| Rust | Yo (this design) | Status | Notes |
| --- | --- | --- | --- |
| `_` | `_` | exists | wildcard |
| `x` (binding) | `x` | **new at top level / nested**; exists in payload position | see §4.3 for binding-vs-constant |
| `CONST` | `LIMIT`, `Color.Red`, `RED` | exists for primitives (`LIMIT`); **new for variants** (`Color.Red`, `RED :: Color.Red`) | compared with `==` (structural for enums) |
| `1`, `-1`, `1.5`, `true`, `'a'` | same | exists at top level (floats broken — B1); **new in payload/nested positions** | typed like `==` operands: coerced to the matched type |
| `"abc"` | `"abc"` | **new** for `str`/`String` scrutinees and payloads; exists for `comptime_str` | a `String` scrutinee against a `str` literal is exactly the existing heterogeneous `impl(String, Eq(str))` (`std/string/string.yo:1208-1215`), whose own doc comment calls `x == "literal"` "the dominant pattern" |
| `1..=5`, `1..5` | `(1..=5)`, `(1..5)` | **new** | the `RangeOp` trait call yields a comptime `Range(T)`/`RangeInclusive(T)` value; lowered to `lo <= x && x < hi` |
| `E::V`, `E::V(p, q)`, `E::V { a, b: c }` | `.V`, `.V(p, q)`, `.V(a : p)`, `.V({a, b : c})`, `.V({})` | exists | sub-patterns `p`, `q` may now be ANY pattern |
| `E::V(Inner::W(x))` | `.V(.W(x))` | **new** | any depth; pointer/`ref`/`Box` payloads are looked through (top-level already auto-derefs one pointer) |
| `(a, b)` | `(a, b)` | **new** | tuple scrutinee/sub-pattern; arity exact; `_` per element |
| `S { x: 0, y }` | `S(x : 0, y : y)`, `{x : 0, y}` | **new** | struct scrutinee/sub-pattern; labeled, partial like curly variants |
| `p \| q` | `(p \| q)`, `\|(p, q)` | exists for primitive literals; **new** for variants, nested, anywhere | alternatives must bind the same set of names with compatible types |
| `name @ p` | `(name := p)` | **new** | `:=` is reserved, parses today, and *means* "declare `name` as the value matched by `p`" |
| `p if g` | `(p && (g))` | **new** | `&&` is reserved; the arm matches when `p` matches AND `g` (with `p`'s bindings in scope) is true; parentheses per §1.1 |

Alternative spellings considered and not chosen: a new `@` token (needs a
lexer-table change and a `plans/reference/OPERATOR_SET_AND_PRECEDENCE.md`
amendment for one feature); `when(p, g)` / `if(p, g)` call-forms for guards
(reads as a call, hides that `g` sees `p`'s bindings). If the maintainer prefers
`when(...)`, only `compile_pattern`'s top-level case changes — nothing else in
this design depends on the spelling.

### 4.3 Identifier resolution in pattern position

Rust's rule, adopted verbatim: **a bare identifier is a binding unless it
resolves, in the enclosing scope, to a compile-time-only value** (a `::`
constant, an enum variant value, a unit struct), in which case it is a
*constant pattern* compared with `==`. `_` is the wildcard. `_x` is an ordinary
binding (kept as today; Rust's "unused" nuance is a lint we do not have).

This unifies the two paths: today the primitive path treats every identifier
as a constant (and errors on a runtime one) while the enum payload path treats
every identifier as a binding. `tests/basic.test.yo` "classify_tens"
(`TEN | TWENTY | THIRTY`) keeps working; `other => …` becomes a catch-all.

The shadowing hazard (a local `::` named like a payload you meant to bind) is
real in Rust too; the evaluator reports `Pattern "n" compares against the
constant n :: … in scope; write _n or rename the constant to bind` when the
constant's type is not comparable with the field, and the cheatsheet keeps its
"avoid a pattern binding named like an existing definition" note.

### 4.4 Typing of patterns

`compile_pattern(ast, expected : TypeValue, env, ctx) -> Pattern` is typed
top-down from the scrutinee type:

- **Variant** `.V(...)`: `expected` must be an enum (after deref/shell
  resolution); `V` must exist; positional sub-patterns are exact-arity, labeled
  /curly are partial, `{}`/bare bind nothing. Each sub-pattern is compiled
  against the field type. GADT: `_is_gadt_branch_reachable` decides whether the
  arm is reachable and `_gadt_refined_expected` refines the arm body's expected
  type exactly as today.
- **Literal / constant / range**: the expression is evaluated with
  `expected_type = expected` (today's trick, so `1` against an `i32` field folds
  to `i32`), must have a compile-time value, and `are_types_compatible(pattern,
  expected)` must hold (argument roles as in today's `evaluate_primitive_match`
  — pattern is *actual*, scrutinee *expected*). For a `String` scrutinee a
  `str` literal is accepted because `impl(String, Eq(str))` exists; the test
  lowers through the same `==` dispatch the operator uses. A range's bounds must both
  be compile-time values of the matched type; `RangeInclusive` may not be empty
  (`lo <= hi`), `Range` must satisfy `lo < hi`.
- **Tuple** `(p, q)`: `expected` is a `Tuple` of the same arity; elements
  compiled against element types.
- **Struct** `S(a : p)` / `{a : p}`: `expected` is that struct (or any struct
  for the anonymous curly form); labels must exist; partial allowed.
- **Binding**: takes the type of the position it stands in; for a pointer/`ref`
  position it binds the value (the same borrow semantics as today's payload
  binders — no dup, the binding is a view into the scrutinee for the arm's
  duration).
- **Or**: every alternative is compiled against the same `expected`; the
  binding sets must be equal as *names* and pairwise `are_types_compatible`.
- **Guard**: compiled after the pattern with the pattern's bindings pushed on a
  fresh frame; must be `bool`.
- **`name := p`**: `p` compiled against `expected`; `name` bound to `expected`.

Pointer scrutinees keep the one-level auto-deref; inside patterns, a
sub-pattern applied to a `Pointer(T)` / `ref` struct / `Box(T)` position is
compiled against `T` and the access path records the deref (§4.8).

### 4.5 Matching semantics

- **Order:** arms are tested in source order; the first arm whose pattern
  matches and whose guard holds runs. This replaces today's order-insensitive
  `switch` semantics on the primitive path (A2 becomes an *unreachable arm*
  error, matching the enum path).
- **Bindings** are introduced in a fresh env frame per arm, exactly where
  today's `env.push_frame(false)` happens; the guard is evaluated in that frame
  as a begin-expression (its temps are dropped before the arm body runs, and
  again on the fall-through path — §4.8).
- **Or-patterns with bindings:** the body sees one binding per name; which
  alternative bound it is invisible.
- **`_` and identifier catch-alls** are ordinary irrefutable patterns; the
  "only one `_`, and last" rule is subsumed by "no unreachable arm".
- **Bare `.V` / `.V({})`** on a variant with fields stays legal (design
  decision recorded in the cheatsheet; more permissive than Rust).

### 4.6 Exhaustiveness and unreachability

Replace the two coverage scans (variant-name list on the enum path; "has `_`" /
`true`+`false` on the primitive path) with the standard **usefulness**
algorithm (Maranget, "Warnings for pattern matching", 2007) over the Pattern IR:

- `is_useful(matrix P, vector q)` with constructor sets per type: enum variants
  (GADT-unreachable variants excluded, as today); `bool` = {`true`, `false`};
  tuple/struct/unit = one constructor; **integers, floats, chars, strings and
  ranges are treated as infinite domains** — only a wildcard/binding/constant-
  free alternative covers them (Rust's integer-range exhaustiveness is deferred,
  §5).
- **Exhaustiveness:** `is_useful(P, [_])` → `Match expression is not exhaustive.
  Missing cases: …` with a witness rendered in Yo pattern syntax
  (`.Some(false)`, `(_, 0)`); for infinite domains: `… requires a wildcard or
  binding arm` (today's wording kept).
- **Unreachability:** for each arm `i`, `!is_useful(P[0..i], p_i)` →
  `Unreachable match arm: …` (error). Each or-alternative is checked the same
  way against the rows above it plus its earlier siblings (subsumes today's
  `Duplicate pattern value`). A guarded arm never contributes to `P` for the
  rows below it (a guard can fail), which is precisely the rule #661 is missing.
- **Comptime-eliminated arms** (a known scrutinee that cannot match) still take
  part in the checks — exhaustiveness is a property of the source, as today
  (`checked_variant_names.push` happens BEFORE the skip check).

Complexity is fine: arms are short, the matrix is tiny; `derive(Eq)` on a
~46-variant enum is the largest generated match and stays O(variants × arms).

### 4.7 Compile-time scrutinee (CTFE)

`match_value(p : Pattern, v : EvalValue) -> Option(ArrayList(Binding))` decides
statically; `EvalValue.UnknownVal` at any position makes the result `.None`
("unknown"). The arm loop keeps its shape: for a known scrutinee the first arm
whose pattern matches (and whose guard, evaluated with the bound comptime
values, is `true`) is the executed arm; arms whose pattern definitely cannot
match are evaluated for typing only with `case_executed` left `.None` (today's
elimination channel, generalised from "variant name differs" to "pattern
cannot match"); a guard whose value is unknown at comptime makes the arm
"possibly executed" (no elimination). `matched_body_idx`, the env merge and the
single-body direct-env path are unchanged.

### 4.8 Lowering

Two strategies, chosen per match by `pattern_matrix_is_switch_shaped`:

**Fast path (unchanged emit).** Every arm is one of: `_`, a top-level
literal/constant/or-of-literals on an integer/bool/char scrutinee, a variant
with only irrefutable sub-patterns (bindings, `_`, labels thereof) and no
guard, and no two arms name the same variant. Then today's four lowerings run
verbatim (`switch` on value / on tag / nullable-pointer `if`). The emit-diff
gate proves this covers every match in `src/`+`std/`+`tests/` today.

**General path (new).** An ordered test chain with per-match unique labels
(`__yo_m<id>_arm<k>`, `__yo_m<id>_end`, unique per match node id — nested
matches in async bodies already taught us duplicate C labels are a real
failure):

```c
T __yo_tN;
{
  // arm 0: .Ok(.Some(v)) && (v > 0)
  if (!(s.tag == TAG_Ok && s.data.Ok.value.tag == TAG_Some)) goto __yo_m17_arm1;
  int32_t v = s.data.Ok.value.data.Some.value;
  if (!(v > 0)) { /* guard temps drop */ goto __yo_m17_arm1; }
  __yo_tN = /* body */; goto __yo_m17_end;
}
__yo_m17_arm1: {
  // arm 1: (.Ok(.None) | .Ok(.Some(_)))
  if (!((s.tag == TAG_Ok && s.data.Ok.value.tag == TAG_None) ||
        (s.tag == TAG_Ok && s.data.Ok.value.tag == TAG_Some))) goto __yo_m17_arm2;
  __yo_tN = /* body */; goto __yo_m17_end;
}
__yo_m17_arm2: {
  // arm 2: .Error(e)   (irrefutable given exhaustiveness → no test)
  __yo_str e = s.data.Error.value;
  __yo_tN = /* body */;
}
__yo_m17_end:;
```

- **Tests** are built from the access path (`s.data.V.f`, `->` for pointer/
  `ref` scrutinees, `(*p)` through `Box`/pointer payloads), one conjunct per
  refutable node: tag compare, `==` against a rendered literal (integers,
  bools, chars, floats — floats compare with `==`, never `switch`), the string
  equality call the `==` operator lowers to for `str`/`String`, `lo <= x &&
  x < hi` for ranges.
- **Or-patterns with bindings:** the per-alternative binding assignments are
  emitted as `if (alt_k test) { binds_k; } else if …` after the disjunctive
  test succeeds (each alternative binds the same names, declared once before
  the chain).
- **Bindings borrow.** Same as today's `_emit_destructure_binds`: a plain C
  copy of the field, no dup, `_shadow_add`/`_remove_arm_shadows` so the body
  resolves the source name to the arm-local C declaration.
- **Guards** are emitted via `_call_generate_expr` in the arm block; the
  guard's deferred drops are flushed on both the success path (before the
  body) and the failure path (before the `goto`). `emitted_deferred_drop_ids`
  keeps the flush idempotent (`AGENTS.md` "single-expression begin block"
  pitfall).
- **The last arm** of an exhaustive match with an irrefutable pattern gets no
  test (avoids a dead `else` and an "uninitialised temp" warning at -O2).
- **Result temp / unit / control-flow bodies:** `_emit_case_body_and_break`'s
  logic is reused with `goto __yo_m<id>_end` in place of `break;`; `return`/
  `break`/`continue` bodies are emitted as today (they never reach the goto).
- **Primitive scrutinee, float or string:** the general path is the ONLY path
  (B1 and C1 land here). Integer/bool/char literal matches stay on the switch.

### 4.9 The async state machine and the verifier

- **Async:** extract the two things the SM emitter needs — "the C test
  expression for arm k" and "the binding assignments for arm k, given a target
  (C local or `sm->field`)" — into `src/codegen/exprs/pattern_emit.yo` helpers
  parameterised by an access-path renderer, and make BOTH emitters call them.
  The SM keeps its `sm->cond_branch_N` recording and its
  `_resolve_pattern_binding_sm_field` storage; only the test/bind derivation
  changes. Its own positional-only destructuring loop is deleted (it is the
  reason labeled/curly patterns in await-carrying arms are unverified today —
  P0 adds the canary).
- **Verifier (V3):** literal, nested-variant and or-patterns are direct in SMT
  (accessor equalities, disjunction); guards are conjuncts; ranges are two
  inequalities; strings remain outside the subset (`_fail_subset`, unchanged
  message). P6, optional — nothing in P0–P5 needs it, but a verified function
  that adopts a new form must fail loudly, which it already does.

### 4.10 Diagnostics (new/changed messages)

| Code (registry) | Message |
| --- | --- |
| E-match-nonexhaustive | `Match expression is not exhaustive. Missing cases: <witness>[, <witness>…]` (enum witnesses rendered `.V(.W(_), _)`) |
| E-match-nonexhaustive-infinite | `Match expression on <T> requires a wildcard or binding arm for exhaustiveness.` (today's wording) |
| E-match-unreachable | `Unreachable match arm: <pattern>` — subsumes `Duplicate pattern value` and the second-`_` message |
| E-match-or-bindings | `Or-pattern alternatives bind different names: <a> binds {x, y}, <b> binds {x}` |
| E-match-guard-type | `Match guard must be bool, got <T>` |
| E-match-pattern-type | `Pattern <p> of type <T> cannot match a value of type <U>` (today's `Pattern type … is not compatible with scrutinee type …`) |
| E-match-const-shadow | `Pattern "n" compares against the constant n :: <T> in scope …` (§4.3, only when the constant's type is incompatible) |
| E-match-unsupported-scrutinee | `Cannot match on a value of type <T>` (replaces `Expected enum type or primitive type (integer, bool) …`; `Type` and function values land here) |

The arm-shape message `Expected ":" for match pattern` (`match.yo:1339`, a
copy-paste of the cond message) becomes `Expected "=>" for match arm`.
Diagnostic codes go through `src/diagnostics_registry.yo` (not
message-substring matching — `issues/diagnostic-codes-are-assigned-by-substring-matching-the-message-text.md`).

### 4.11 Where the code lives

| Piece | File | New? |
| --- | --- | --- |
| `Pattern` enum (Wildcard, Bind(name), Const(EvalValue, ty), Range(lo, hi, inclusive), Variant(name, idx, subs : ArrayList((label, Pattern))), Tuple(subs), Struct(fields), Or(alts), At(name, sub)) + `Arm(pattern, guard : Option(AstExpr), body)`; `compile_pattern`; `match_value` (CTFE); `is_useful` + witness rendering | `src/pattern.yo` | **new file** (the one new module this plan asks for — `AGENTS.md` forbids ad-hoc new `.yo` files, so this needs the maintainer's yes; the alternative is growing `src/evaluator/exprs/match.yo` past 3,000 lines) |
| arm loop rewritten over `Arm`/`Pattern`; env/frame/result-type/GADT/CTFE plumbing kept | `src/evaluator/exprs/match.yo` | rewrite in place |
| `PatternTable : HashMap(usize, Arm)` keyed by arm-node id, owned next to the shared `ExprInfoTable` (module_manager's codegen table), **not** a field of `ExprInfo` (`src/expr_info.yo:340-356` rare-group memory rule: profile before adding a field; this is per-arm, not per-expr) | `src/expr_info.yo` (table owner), `src/module_manager.yo` | extend |
| switch-shaped predicate; general test-chain emitter; per-arm test/bind helpers with an access-path renderer | `src/codegen/exprs/match.yo`, `src/codegen/exprs/pattern_emit.yo` (**new file**, or a section of `match.yo` if a second new file is refused) | rewrite/extend |
| SM emitter calls the shared helpers; own destructure loop deleted | `src/codegen/async/state_code_gen.yo` | edit |
| optional subset extension | `src/verifier/vc.yo` | P6 |

---

## 5. Non-goals (deferred, recorded so they are not re-litigated)

- Integer-range exhaustiveness (`0..=255` on `u8` without `_`): Rust does it;
  we treat integers as infinite. Revisit when a real program needs it.
- Slice/array patterns `[a, b, rest..]`, `..` rest in tuples/structs. Partial
  labeled/curly already covers the struct case.
- Binding modes (`ref`, `mut`), move-out-of-payload: bindings borrow, as today.
- `box`/deref patterns as a *syntax*: pointer/`ref`/`Box` payloads are looked
  through implicitly instead.
- `match` on `Type` values (C11): comptime type dispatch is a different feature
  (`plans/reference/TYPE_REFLECTION.md` has `Type.get_info` for it).
- Warnings for unreachable arms: errors until the warnings channel exists.
- Rewriting the 401 string `cond` chains and the 1,366 two-level matches in
  `src/`/`std/`: an adoption sweep after the seed carries P2/P3 (P5), never
  before — `tests/internal` compile the compiler with the SEED.

---

## 6. Implementation plan

Conventions for every phase: red-first tests in `tests/` (a `*.test.yo` per
feature, plus a `tests/cli-cases/` check-level case for every new *diagnostic*,
because `comptime_expect_error` cannot observe swallowed def-eval throws —
memory rule "cee cannot pin a swallowed check error"); `yo check ./src` and
`yo compile src/main.yo --skip-c-compiler` before pushing (the async rules fire
in codegen only); the emit-diff gate on the whole tree for P1/P2; the fast suite
before merge; a fixpoint run (`scripts/bootstrap/fixpoint_only.sh`) for any
phase that touches codegen output. **Seed rule:** no new pattern form appears
in `src/` or `std/` until `SEED_VERSION` carries it
(`plans/backlog/SEED_VERSION_AUTOMATION.md`); `tests/` may use a form the
moment its phase lands because the tree's own compiler compiles them.

### P0 — stop the bleeding (small PRs, ship first)

Goal: nothing that passes `yo check` fails in the C compiler or answers wrongly.

| Item | Change | Red-first test |
| --- | --- | --- |
| B1 float `switch` | `generate_primitive_match_expression`: when the scrutinee type is a float, emit an `if (x == lit) … else if …` chain (or reject at check — but floats are useful and the CT version already works) | `tests/match_primitive_values.test.yo`: f64 arms at runtime |
| B3 duplicate variant arm | evaluator: two arms naming the same variant with no refutable sub-pattern → `Unreachable match arm` (interim wording until §4.10 lands) | cli-case `match-duplicate-variant-arm` |
| A2 `_` not last on primitives | evaluator primitive path: any arm after `_` → same error (the enum path already rejects) | cli-case `match-wildcard-not-last-primitive` |
| A1/B2 literal payload (= #661) | take #661's evaluator half and sync-codegen half **plus**: (a) a literal-guarded arm does not mark its variant covered unless an unguarded same-variant arm or `_` exists (gap 1); (b) a string/char literal in payload position is rejected loudly instead of silently binding (gap 4 — the regression #661 would ship); (c) `-1` (prefix-minus call whose operand is an integer atom) counts as a literal (gap 3) | #661's four tests + `.Some(true), .None` without `.Some(_)` must fail check + `.Tag("a")` must fail check + `.Some(-1)` must discriminate + async twin |
| async emitter (A3 + #661 gap 2) | `_generate_match_with_await_impl`: group same-variant arms into one `case` with literal guards exactly as the sync emitter does (shared helper `_cg_literal_arm_guards` moved to a file both import); bind labeled/curly params by reusing `_emit_destructure_binds`' label→index resolution (today positional atoms only — `issues/async-match-arm-labeled-destructure-binds-nothing.md`) | `tests/match_async_arms.test.yo`: `.Some(true)`/`.Some(false)` with an `await` in each arm; `.V({a, b : c})` and `.V(label : x)` with an `await` in the arm (the repro in `issues/repros/`) |
| dead code | delete the `=> rename` branch in `codegen/exprs/match.yo` (§1.4) | none — no evaluator path produces the shape it reads, so its deletion cannot change any emit (the emit-diff gate proves it) |

Exit: fast suite green; each of the six probes in §2.1/§2.2 either answers
correctly or fails at `yo check` with the intended message (none reaches the C
compiler); fixpoint holds.

### P1 — the Pattern IR behind the existing behaviour

Goal: same accepted language, same emit, one interpreter.

1. `src/pattern.yo`: `Pattern`/`Arm`, `compile_pattern` covering exactly
   today's accepted forms (wildcard, variant with binder/`_`/labeled/curly
   sub-patterns, primitive literal/constant/or), `match_value`, `is_useful` +
   witness rendering, `pattern_matrix_is_switch_shaped` (true for every match in
   the tree at this point — assert it in a self-compile with a counter).
2. `evaluate_match` rewritten over `Arm`: one arm loop (no primitive/enum
   split), env/frame/result-type/CTFE/GADT plumbing lifted unchanged; the
   `PatternTable` populated; `case_executed`/`primitive_pattern_values`/
   `is_primitive_match` still written for codegen (removed in P2).
3. Exhaustiveness/unreachability from `is_useful`; the messages of §4.10 with
   registry codes; every existing cli-case golden that mentions the old
   messages re-recorded (`scripts/cli-diff-test.sh --record`), each diff read.
4. Gates: `tests/internal/` files that import `evaluator/exprs/match.yo`
   (`grep -l "exprs/match" tests/internal/*.yo`) + the fast suite + **emit-diff
   over `src/`+`std/`+`tests/` byte-identical** + fixpoint.

### P2 — general lowering; nested, literal, or, catch-all, constants

1. `src/codegen/exprs/pattern_emit.yo`: access-path renderer (`.`/`->`/`(*p)`),
   `arm_test_code(arm, path) -> String`, `arm_bind_code(arm, path, target)`.
2. `_gen_general_match` (test chain with `goto`, §4.8) in
   `codegen/exprs/match.yo`; dispatcher: switch-shaped → today's four
   lowerings, else general. Delete `primitive_pattern_values`/
   `is_primitive_match` reads once the switch path reads the `PatternTable`.
3. Async: `_generate_match_with_await_impl` uses the same helpers; its
   positional-only loop and P0's interim grouping go away.
4. `compile_pattern` accepts: nested variant sub-patterns; literal/constant
   sub-patterns at any depth; `Color.Red`/`RED` constant patterns for enums;
   or-patterns anywhere (binding-set check); identifier catch-all (§4.3 rule).
5. Tests (all red first): `tests/match_nested.test.yo` (two/three levels,
   through `Box` in a recursive enum, through a pointer scrutinee, comptime
   scrutinee twins), `tests/match_or_variants.test.yo` (with and without
   bindings, mismatched binding set → cli-case), `tests/match_catch_all.test.yo`
   (binding the scrutinee; a `::` constant of the same name compares),
   `tests/match_exhaustive.test.yo` (witnesses: `.Some(false)`, `.Ok(.None)`,
   unreachable after `_`, guarded arm not covering), async twins of nested
   + or in `tests/match_async_arms.test.yo`, a `derive(Eq)` canary
   (unchanged emit), the RC canaries: a nested binding used after the arm is
   not possible; a scrutinee that is an owning temp (`match(f(), …)`) gets ONE
   drop on every path including guard failure (Dispose-counter oracle, memory
   rule "Leak gates need a Dispose counter").
6. Gates as P1; emit-diff must show changes ONLY in the new test files.

### P3 — strings, ranges, guards, `:=`

1. `compile_pattern`: string literals against `str`/`String` (and `comptime_str`
   as today); `(lo..hi)`/`(lo..=hi)` from a comptime `Range`/`RangeInclusive`
   value; `(p && (g))` → `Arm.guard`; `(name := p)` → `At`.
2. Emit: string equality via the operator's lowering (one helper that renders
   `a == b` for a given type — reuse whatever `identifer_and_operator.yo`
   codegen emits for `str == str`, `String == str`); range conjuncts; guard
   emission with drop flushing on both paths (§4.8).
3. CTFE: guards with comptime bindings; unknown guard → no elimination.
4. Tests: `tests/match_strings.test.yo` (`str`, `String`, or-of-strings, in a
   payload, in an async arm), `tests/match_ranges.test.yo` (inclusive/
   exclusive, negative, `u8` full range still needs `_`, empty range → cli-
   case), `tests/match_guards.test.yo` (guard sees bindings, guard on `_`,
   guard temps dropped on failure — Dispose oracle, guard in async arm),
   `tests/match_at_binding.test.yo`; fmt idempotence cases for each spelling
   in `tests/internal/formatter.test.yo`.

### P4 — tuple and struct scrutinees

1. `compile_pattern`: `Tuple`, `Struct` (named + anonymous curly); scrutinee
   dispatch accepts tuple/struct types.
2. Emit: field access paths; a tuple scrutinee built inline (`match((a, b), …)`)
   is materialised into the subject temp once (today's begin-scrutinee path).
3. Tests: `tests/match_tuples.test.yo` (`(0, 0)`, `(x, 0)`, nested variants in
   elements, exhaustiveness witness `(_, 1)`), `tests/match_structs.test.yo`.

### P5 — documentation and adoption

- `docs/en-US/DESIGN.md` + `docs/zh-CN/DESIGN.md` "Pattern Matching": the §4.2
  table, the identifier rule, the parens rule, exhaustiveness/unreachability
  semantics, one example per form.
- `.github/instructions/yo-syntax.instructions.md` and
  `.github/skills/yo-syntax/syntax-cheatsheet.md`: delete "Nested destructuring
  patterns are NOT supported" and "Enum pattern matching does NOT support
  literal values"; replace with the new rules and the `(p && (g))` / `(x := p)`
  paren reminder. Re-record the `skills-install` cli goldens (memory rule).
- `issues/fixed/pattern-match-literal-in-enum-destructure.md`: status updated.
- Adoption in `src/`/`std/` **only after** `SEED_VERSION` carries P2/P3: the
  string `cond` chains in `src/main.yo` first (126 arms, `yo --help`-style
  dispatch), then two-level matches where the inner scrutinee is the outer
  binding.

### P6 — verifier subset (optional)

Extend `src/verifier/vc.yo` `_arm_under_pattern` to literal/nested/or/guard
patterns (accessor equalities, disjunctions, conjuncts); strings stay outside
the subset. Tests in `tests/verify_*.test.yo` alongside the V3 datatype cases.

---

## 7. Risks

- **The general lowering touches RC.** Bindings borrow (no new dups), but a
  *guard* is a new expression evaluation site with temps on a path that may
  not run the body. The dup/drop optimizer (`_optimize_dup_drop_pairs`) must
  see the guard as part of the arm; the Dispose-counter tests in P3 are the
  gate, and `--allocator system --sanitize address` on Linux CI catches what
  the counter misses.
- **`goto` in async bodies.** The SM emitter already uses labels; per-match
  unique label names are mandatory (`issues/fixed/*duplicate C labels*`).
- **Exhaustiveness strictness.** Turning A2 and B3 into errors could break
  code that compiles today; the tree-wide `yo check ./src` + `./std` + the fast
  suite in P0/P1 measures the blast radius before merge (expected: zero — a
  `switch` with a dead arm is a bug, not a style).
- **Two-generation seed rule.** Adoption in `src/`/`std/` is the phase most
  likely to be attempted early; `fixpoint-arm64.yml` builds gen-1 with the
  seed, so an early use fails CI loudly, which is the intended guard.
- **Message churn.** P1 re-records cli goldens; each must be read, not bulk-
  accepted.

## 8. Decisions requested from the maintainer

1. New module(s) `src/pattern.yo` (+ `src/codegen/exprs/pattern_emit.yo`) —
   yes/no (§4.11).
2. Guard spelling: `(p && (g))` (recommended) vs `when(p, g)`.
3. Whole-value binding: `(name := p)` (recommended, no new token) vs adding `@`
   to the closed operator set.
4. Unreachable arm: error (recommended until a warnings channel exists) vs
   silently accepted.
5. #661: fix gaps 1 and 4 in the PR and then merge (recommended) vs close it in
   favour of P0 here. Either way it must not merge as it stands — gap 4 is a
   regression from a compile error to a silent wrong answer.
