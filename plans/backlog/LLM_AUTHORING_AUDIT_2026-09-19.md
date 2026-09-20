# LLM authoring audit (2026-09-19): what Yo should add next, and what it should not

**Status:** PROPOSED 2026-09-19 — a read-only audit of the tree at
`49d75c665` (17 `yo check` probes against the tree's `std` with the
`yo 0.2.36` binary, three delegated sweeps over `std/`, the CLI surface and
`issues/`), reviewed by the maintainer the same day. **The rulings in §1 are
final and are not reopened here**; everything else is a proposal, nothing has
started. Sibling of the two competitor audits
([`ZEROLANG_AGENT_FIRST_LESSONS.md`](ZEROLANG_AGENT_FIRST_LESSONS.md),
[`BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`](BEND_LAWS_AND_AGENT_LOOP_LESSONS.md))
and of the closed toolchain campaign
([`../archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md`](../archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md)).

**Coordination.** The Bend plan's B0–B5 are in flight on another agent's
branches (PRs #773, #777, #782, #784, #785 at the time of writing) and OWN the
context pack (`yo guide` / `yo std`, B3), the evals corpus (B4) and the
repo-shape gate (B5). Nothing in this document duplicates them; §3 lists only
toolchain items no plan owns.

## 0. The baseline, measured

Yo's core already suits a model: one call syntax, no operator precedence, no
overloading, no implicit conversions, explicit effects, structured
diagnostics with codes, `yo explain`, `yo fix`, bundled skills. What the
audit measured is where the remaining cost sits.

| what | number | reading |
| --- | ---: | --- |
| `.yo` lines in `std/` / `src/` | 75,439 / 231,114 | the corpus the numbers below are over |
| `usize(` casts in `std/` / `src/` | 3,307 / 13,313 | integer casts are the largest token tax in the tree |
| `i32(` casts in `std/` | 2,834 | |
| `while(` vs `for(` in `std/` | 775 vs 0 | the loop macro is unused by the library; `src/` has one `for(` |
| `== "…"` compares in `src/main.yo` | 236 | string dispatch written as `cond` chains — a `match` gap |
| `.Err(e) =>` arms in `std/` | 104 | most exist only to `return(.Err(e))` |
| warning-phrased rules in the shipped agent docs | ~111 distinct | proxy for "features whose design costs authors most" |
| the four largest rule groups | match/destructuring 12, async placement 11, strings/templates 10, comptime/generics 10 | syntax (braces 7, parens 9) is NOT where the budget goes |
| E-codes / with a CLI golden / distinct `Repair` kinds | 27 / 5 / 1 | the only repair anywhere is the E0401 rename (`src/error.yo:266`) |
| `std/` files declaring `stable` | 14 of 176 | |
| open / fixed issues | 218 / 699 | evaluator 43, tooling 40, async 32, codegen 20, parser 7 |

The probe corpus is in Appendix A; every language claim below cites a probe.

## 1. Maintainer rulings (2026-09-19) — do not reopen

| audit item | ruling | what survives |
| --- | --- | --- |
| Literal inference through bindings and operators (`i := 0; while((i < n), …)` fails, `i` freezes to `i32`) | **DECLINED.** A bare integer literal is a `comptime_int` value and already converts to any runtime integer at argument positions; a `:=` local is a runtime `i32` by design. Explicit is better than implicit. | The RECEIVER-position asymmetry is a bug, not inference (§2.4); the unify error gets a `yo fix` repair (§2.6) |
| A capturing closure bound to a local without a type (`cb := (x => (x + base))`) | **REJECTED.** `x` has no type source in that position; no rule can infer it. | nothing |
| Order-free named arguments | **REJECTED.** Runtime + comptime parameters and partial application give argument order meaning; not a real cost for a model. | nothing |
| Closures capture by VALUE (`counter = (counter + 1)` inside `=>` edits a copy) | **BY DESIGN.** No diagnostic. | nothing |
| `try` for `Result` propagation | **YES, as a prelude macro like `for`** — with the 2026-08-21 removal history in §2.3 consciously reversed | §2.3 |
| `for(0..n, …)` failing with a comptime-parameter error | **A BUG; `for` stays a macro.** | §2.4, `issues/an-integer-literal-on-the-left-of-a-runtime-operand-is-rejected.md` |
| `yo run <file>` | **REJECTED.** `yo build run` exists. | nothing |
| `struct(generic(T), …)` sugar, the brace rule, no precedence, no overloading | previously decided ([`../archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md`](../archive/LLM_FRIENDLY_TOOLCHAIN_AND_SYNTAX.md) §4/§6, `../reference/`) | untouched |

## 2. Language items

### 2.1 Finish real pattern matching (the highest-value item, already designed)

[`../MATCH_PATTERN_MATCHING.md`](../MATCH_PATTERN_MATCHING.md) is ACTIVE with
P0 landed (#672). Today `.Some(.Some(v))` is a parse error (probe p10), a
`String` scrutinee is rejected (p5), and variants have no or-patterns or
guards. The shipped pitfall docs spend more rules on match and destructuring
than on any other feature, and `src/main.yo` alone carries 236 string compares
a model would write as a `match`. P1 (the `Pattern` IR behind existing
behaviour, emit-diff identical) is blocked only on that plan's §8 decision
about `src/pattern.yo`. Nothing to design here: **unblock §8 and run P1–P4 as
written.** Acceptance is that plan's.

### 2.2 Enum-variant inference for a local, from where the local flows

```rust
f :: (fn(x : i32) -> Result(i32, E))({
  r := .Ok(x);          // error: Failed to infer enum variant type.   (probe p13)
  return(r);
});
```

`return(.Ok(x))` infers from the function's return type today; binding the
same value first does not. The design cheatsheet's `io.async` rule ("return
`io.async(...)` directly — an intermediate variable prevents enum variant type
inference") is the same hole seen through async.

**Proposal.** Extend the inference that already exists at `return(...)` and at
typed slots to a `:=` local whose value is a bare variant literal: resolve the
variant's enum from the local's FIRST typed use in the same block — a
`return(local)`, an argument position, a typed assignment, a field store.
When there is no such use, or two uses disagree, keep today's error but say
what is missing ("annotate the binding: `(r : Result(i32, E)) = .Ok(x)`") with
that annotation as the `Repair`. This is deliberately NOT general bidirectional
inference: the variant literal is the only expression whose type is
unknowable without context, and the block-local forward look is the smallest
rule that covers the reported shapes.

**Open question for the maintainer** (explicit over implicit): accept the
forward look, or ship only the repair-carrying diagnostic? The recommendation
is the forward look for `return(local)` and argument positions only — those
two cover every case measured — and the repair for everything else.

Acceptance: probe p13 checks and runs; the `io.async` intermediate-variable
example from `.github/instructions/yo-design.instructions.md` compiles or is
rejected with the repair; the cheatsheet rule is rewritten to state the new
rule. No seed gate (evaluator only; `std` does not adopt the form until a seed
carries it).

### 2.3 `try(expr)` as a prelude macro — reversing the 2026-08-21 removal, knowingly

**History that must be read first.**
[`../reference/MACRO_POLICY.md`](../reference/MACRO_POLICY.md) records that
the std `try` macro was **REMOVED by user decision on 2026-08-21**: it had zero
call sites in `src/`/`std/`, it was the one std macro that injected a hidden
caller-frame `return`, and its name collided conceptually with algebraic
effects. A working copy survives in
`tests/codegen-bootstrap/try_macro_assign.yo` under
`pragma(Pragma.AllowMacroDef);`, and `tests/macro_def_pragma.test.yo`
re-creates it to keep the caller-frame-return path covered.

The 2026-09-19 ruling asks for it back as a prelude macro. The two 2026-08-21
objections still apply and are answered, not dismissed:

- *Hidden caller-frame `return`.* It is the whole point — the same point as
  Rust's `?` — and `for` already returns from the caller through `break`/
  `return` in its body. The macro is documented as "expands to a `match`
  whose `.Err` arm returns from the enclosing `fn`", with the expansion shown.
- *Collision with effects.* The std error-handling policy
  (`yo-design.instructions.md`, "three blessed styles") already separates
  them: effects for the I/O path, `Result` for pure fallible transforms.
  `try` belongs to the second row only; it never touches a handler.

**Design.** The prelude gets the three-line macro from the test file, verbatim
in shape:

```rust
try :: (fn(quote(expr) : Expr) -> unquote(Expr))({
  temp :: gensym("try");
  quote({
    unquote(temp) := unquote(expr);
    match(unquote(temp), .Ok(value) => value, .Err(error) => { return(.Err(error)); })
  })
});
```

`Result` only (the `Option` analogue is a later, separate decision). Std is
exempt from the `AllowMacroDef` gate as it is for `for`. The macro set in
`MACRO_POLICY.md` ("live std macro set is now 9") is updated to 10 and the
removal paragraph gains the reversal date.

**Constraints and their tests.**

1. `v := try(f(x));` as an init RHS in a multi-statement body — the shape the
   codegen-bootstrap file exists for (the returning arm must not leak `error`
   into the merged env).
2. `try(...)` as a statement, as a call argument, and as the tail of a `fn`
   body.
3. **Inside an async body**, `try(io.await(fut, io))` meets the open issue
   `io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await`
   ([`FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md`](FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md)):
   the argument is spliced into the expansion, so the await would compile as
   a BLOCKING await. Acceptance: either the transform sees through it, or the
   evaluator rejects `try` over an awaiting argument inside `io.async` with a
   diagnostic naming the workaround (`v := io.await(...); w := try(v);`). A
   silent blocking await is the one unacceptable outcome.
4. `unwind` inside the tried expression (an effect handler firing) must keep
   its own semantics — the `try` arm only sees a returned `.Err`.
5. `tests/try_macro.test.yo` is restored (deleted at the removal) with 1–4;
   `tests/codegen-bootstrap/try_macro_assign.yo` drops its local definition
   and calls the prelude's.

Seed gate: none for defining it (the seed evaluates the tree's prelude, as it
does for `for`); `std/` may only CALL it after the next release ships a
prelude that has it. Fixpoint + byte-identical emitted C on the corpus is the
gate for the prelude edit (no call sites change).

### 2.4 The receiver-position literal bug — `issues/an-integer-literal-on-the-left-of-a-runtime-operand-is-rejected.md`

`(0..n)`, `(3 == n)`, `(1 + n)` with `n : usize` are all rejected with
"Cannot assign runtime argument to compile-time parameter"; every mirror
image is accepted (probes a, e, f vs g). Binary operators dispatch on the
left operand's type, `comptime_int` has only the comptime operator impls, and
the literal→runtime conversion the language promises happens at argument
positions but never at the receiver. `for(0..n, …)` is this bug, not a `for`
bug; `for(0..5, …)` is its second half (`Range(comptime_int)` has no
`into_iter`, and the error blames the prelude).

Fix direction is in the issue: convert the left literal to the right
operand's runtime type before impl selection; for an all-literal range at
runtime, report at the range with a repair rather than guessing a type.
Tests listed there. No seed gate.

### 2.5 Raw string literals, and unknown escapes made loud

[`RAW_AND_FENCED_STRING_LITERALS.md`](RAW_AND_FENCED_STRING_LITERALS.md) stands
as written (the codegen templates hold 9,774 backticks; a model writes C,
JSON, regex and shell inside strings constantly). One addition from this
audit: the cheatsheet documents that the two string forms have different
escape tables and that **an unknown escape is silently literal in both**.
That is a silent-wrong-answer class. Make an unknown escape a lexer error
with the escape table in the message, and land it before or with the raw
literal so authors have a way to spell the literal they meant.

### 2.6 Repairs that replace the declined inference

Three diagnostics get a `Repair` so `yo fix` and `--error-format json` carry
the cast the maintainer wants spelled out:

| diagnostic | repair |
| --- | --- |
| E0601 `i32` vs `usize` (or any two integer types) where one side is a local initialised from a bare literal | rewrite the initialiser: `i := 0` → `i := usize(0)` |
| `Range(comptime_int)` reaches a runtime consumer (§2.4 second half) | `0..5` → `i32(0)..i32(5)` |
| "Failed to infer enum variant type" at a `:=` (§2.2 fallback) | annotate the binding with the enum type found by the forward look, when unique |

## 3. Toolchain items no plan owns

Excluded on purpose: the context pack (`yo guide` / `yo std`, Bend B3), the
evals corpus (B4), the repo-shape gate (B5), `yo run` (rejected).

### 3.1 `yo fix` — from one repair to the four the toolchain plan promised

The archived plan's status table says four repairs; the tree constructs a
`Repair` at exactly ONE site (`src/error.yo:266`, the E0401 rename). Add, each
with a cli-case golden showing the repaired file:

1. E0003 adjacent different operators → parenthesise the right-hand side.
2. `{ … }`-without-semicolons diagnostics → insert `;` after the last
   statement, or `{ x }` → `x` when the expected type is not a record (the §4.3
   item of the archived plan; the diagnostic exists, the repair does not).
3. E0401 where the name is exported by exactly one std module → add the
   `{ name } :: import("…")` line.
4. The three casts of §2.6.

Rule kept from the archived plan: a repair is offered only when it is the
unique fix, and `yo fix` never touches a line the compiler did not flag.

**Status 2026-09-20 (PR B of the toolchain series):** items 2 and 3 landed in
the form the uniqueness rule allows — E0007 inserts `;` before the `}` only
for the single-expression shape `{ f(x) }` (two comma-separated items may be
a block OR a record with a bad field); E0401 inserts the import line when
exactly one std module exports the name and no rename candidate exists, with
the std export index built by the CLI front doors from std's `export(...)`
lines (public file per directory). Goldens: `fix-inserts-block-semicolon`,
`fix-adds-a-std-import`, `check-std-import-help`, `check-std-import-repair-json`,
`check-struct-literal-vs-block`. Item 1 is **declined**: E0003 fires only for
DIFFERENT adjacent operators, where two groupings always exist, so no repair
is unique — `run_fix`'s own comment already records this. Item 4 is
**deferred**: the E0601 unify site sees two types and a token, not the local's
initializer, so the cast repair needs the binding plumbed to the unify site;
§2.6 row 2 disappears with the §2.4 bug fix; row 3 has no enum type to offer
when the hint is absent. `{ x }` → `x` (item 2's second half) is not a
diagnostic today: `{ x }` parses as the record `{ x : x }` and fails later as
a type mismatch that does not know it came from braces.

### 3.2 LSP: carry `Repair`, expose code actions

`src/lsp/diagnostics.yo` re-parses the human-rendered text and drops the
structured `Repair`, so the one mechanical fix the compiler knows never
reaches the editor. Read the typed stash the CLI already reads, keep the
repair on the LSP diagnostic, and serve `textDocument/codeAction` from it.
Inlay hints and semantic tokens are absent too and are lower priority.

### 3.3 The explain registry, verified by the compiler

All 27 registry entries carry `bad`/`good` prose, and no test compiles either
snippet. Add `tests/internal/diagnostics_registry_examples.test.yo`: every
`bad` snippet checks and emits exactly its code; every `good` snippet checks
clean. Add cli-case goldens for the 22 codes that have none. Allocate the
reserved E13xx (codegen) and E15xx (CLI/build/deps) bands for the ICE wrapper
and the `install`/`fetch` family so those failures stop being uncoded prose.

### 3.4 `yo test` for a machine reader

**Landed 2026-09-20 (PR A of the toolchain series).** `--list` prints
`<file>\t<name>` per selected test and compiles nothing; `--json` (a flag of
its own, not a mode of `--json-summary`) emits a `test` event per test
(`file`, `name`, `status`, `duration_ms`, on failure `message` + `output`) and
a closing `summary` event with the human lines suppressed. No `span`: the
runner learns a failure from the child's exit code and captured output, and
the `assert` message's own `file:line` is inside `output`. `--resume-from` /
`--accum-*` stay out of `--help` as the RSS valve's private plumbing.
Goldens: `tests/cli-cases/test-list`, `test-json-lines`, `help-test`.

`--json-summary` is three counters. Add `--list` (enumerate tests without
running) and per-test JSON Lines (`file`, `name`, `status`, `duration_ms`,
failure `message` + `span`) behind the same flag, and put every accepted flag
in `--help` (`--json-summary`, `--shard`, `--resume-from`, `--allocator`,
`--heap-size`, `--debug-heap` are accepted today and undocumented).

### 3.5 Help-text truth

**Landed 2026-09-20 (PR A).** The dispatch list is one constant
(`SUBCOMMAND_NAMES` in `src/main.yo`) shared by the unknown-subcommand error;
the help texts stay hand-written and are pinned by `help-top-level`,
`help-test`, `help-doc` and `unknown-subcommand-error` goldens instead of
being generated (a subcommand added without a help entry now fails the
`help-top-level` golden's review, not silently).

`yo --help` omits `explain`, `check`, `lsp`, `unsafe-report` and
`public-safe-report`; the unknown-subcommand usage string lists a `fetch`
subcommand with no dispatch arm and omits `explain`, `add`, `remove`,
`update`; `yo doc --help` omits the implemented `markdown` format. A
cli-case golden over each help text, generated from the dispatch table so
the two cannot drift again.

### 3.6 Effects report

`ZEROLANG_AGENT_FIRST_LESSONS.md` adopt item 3, unowned: `yo effects <path>
--json` — which effects each exported `fn` requires, from
`src/evaluator/effects/`, so an agent (or a sandbox) can answer "may this
program touch the network" without reading it.

## 4. `std/` candidates (additive, for the std lineage — not commitments)

From the coverage sweep (176 files, 14 stable). Ranked by leverage per line
for agent-written programs; each goes to the std stabilization lineage, not
to this plan's sequencing:

1. `derive(ToJson)` / `derive(FromJson)` via `derive_rule` — struct↔JSON is
   hand-written today, and `std/encoding/json.yo`'s own doc says "or later,
   derive".
2. Test helpers: an effect-throw assertion, `assert_contains`, snapshot
   goldens. `std/assert` stops at five functions.
3. ANSI colour/style constants (`std/term` exposes `supports_color` and
   nothing to colour with).
4. `std/cli` subcommands and `--` (the module's own header lists both).
5. HTTP server keep-alive + a router; server-side TLS.
6. `DateTime.format(pattern)` beyond RFC 3339.

Absent entirely and out of scope here: YAML, any database driver, WebSockets,
compression/archives.

## 5. Sequencing and gates

1. **Small, independent, no seed gate:** the §2.4 bug fix, the §2.6 repairs,
   §3.5 help truth. Each with its cli-case; `yo check ./src` +
   `compile --skip-c-compiler` + the fixpoint battery.
2. **`try` (§2.3)** once the maintainer has read the removal history above
   and confirmed the reversal in writing on the PR — the prelude edit takes
   the fixpoint + byte-identical-corpus gate.
3. **§2.2 variant inference**, after the open question is answered.
4. **§3.1 → §3.2** (`yo fix` repairs, then the LSP channel that surfaces
   them), **§3.3**, **§3.4**.
5. **§2.1 `match`** runs under its own plan; §2.5 under its own backlog doc.
6. §4 items go to the std lineage.

## Appendix A — the probe corpus (yo 0.2.36, tree 49d75c665, `--std-path ./std`)

Each probe was a standalone file with `main :: (fn() -> unit)` (or an exported
`fn`) run through `yo check`; p7 was also compiled and executed.

| id | shape | verdict |
| --- | --- | --- |
| p1 | `xs.push(1)`; `n := xs.len(); assert(n == 3, …)` | OK — literal converts at argument positions |
| p2 | `i := 0; while((i < n), …)` with `n : usize` | E0601 `i32` vs `usize` — `i` is a runtime `i32` local (by design, §1) |
| p3 | `for(0..n, (i) => …)` with runtime `n` | "runtime argument to compile-time parameter `end`" — §2.4 |
| p4 | `cb := (x => (x + base))` | "Expected a function type" — rejected item, §1 |
| p5 | `match(s, \`hello\` => …, _ => …)` on a `String` | "Expected enum type or primitive type" — §2.1 |
| p6 | `v := match(parse(x), .Ok(v) => v, .Err(e) => { return(.Err(e)); })` | OK — the hand-written `try` |
| p7 | `for(xs, (x) => { count = (count + x); })` then run | OK, prints 3 — the `for` body is inlined, so it mutates the outer local |
| p8 | `q := Point(x : i32(5), y : p.y)`; `(a, b) := (i32(1), i32(2))` | OK |
| p9 | `if((x > i32(2)), {…}, {…})`; `cond(...)` | OK |
| p10 | `match(a, .Some(.Some(v)) => v, _ => …)` | "Expected identifier, `_`, or labeled pattern" — §2.1 |
| p11 | `r := (usize(0)..n); for(r, (i) => …)` | OK — the range works once both ends are runtime |
| p12 | `i := usize(0); while((i < n), …)` | OK |
| p13 | `r := .Ok(x); return(r);` | "Failed to infer enum variant type" — §2.2 |
| p14 | `xs.into_iter().map(f).collect()` without a target type | "No matching call" — needs `collect(ArrayList(String))`, same as Rust |
| a | `r := (0..n)` | rejected, parameter `end` — §2.4 |
| b | `for(usize(0)..n, …)` | OK |
| c | `for(0..5, …)` | "No matching call … `(0 .. 5).into_iter`" at `std/prelude.yo:9982` — §2.4 second half |
| d | `for((0..n), …)` | rejected, parameter `end` |
| e | `(3 == n)` | rejected, parameter `rhs` — §2.4 |
| f | `(1 + n)` | rejected, parameter `rhs` — §2.4 |
| g | `(n + 1)`; `(n..usize(9))` | OK — the mirror images |

## Appendix B — warning-phrased rules in the shipped agent docs, by feature

Sources: `.github/skills/yo-syntax/syntax-cheatsheet.md` (171 lines),
`.github/instructions/yo-syntax.instructions.md` (114), the core-patterns and
async-effects cheatsheets (26). 329 warning-phrased lines, deduplicated to
~111 rules.

| feature group | rules |
| --- | ---: |
| enums / match / destructuring | 12 |
| async / effects / unwind | 11 |
| strings / templates | 10 |
| comptime / generics / traits / derive | 10 |
| precedence / parens / call syntax | 9 |
| unsafe / FFI / raw pointers | 9 |
| closures `=>` vs `fn` | 8 |
| `inout` / references / mutation | 8 |
| braces: records vs blocks | 7 |
| imports / modules | 6 |
| `return(...)` / body shape | 5 |
| `recur` / recursion | 5 |
| naming / reserved words / discard | 4 |
| arrays / tuples | 4 |
| contracts / verifier syntax | 3 |

Reading: the four largest groups are ~40% of all rules; the brace and
precedence rules are fewer but the most repeated across files. Syntax is not
where a model fails in Yo — the open-issue split (parser 7 of 218) says the
same thing from the other side.
