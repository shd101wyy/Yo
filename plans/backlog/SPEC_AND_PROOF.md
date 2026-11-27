# Spec and proof: `logic` and `lemma` replace `ghost_fn`

**Status:** BACKLOG — decided 2026-11-27 by VERDICTS-91 (Fable 5.2) and adopted by the maintainer the same day ("update the backlog directly with Fable's recommendation"). The spec-function form is spelled `logic` by VERDICTS-92 (Fable 5.2, adopted by the maintainer 2026-11-27: "lets go logic"), which replaced VERDICTS-91's `spec_fn`; no rule changed. Nothing is built. PR 0 filed the seven false-proof S1s this verdict found (§2.1).

Fact base: `docs/en-US/FORMAL_VERIFICATION.md`, `plans/backlog/FORMAL_VERIFICATION.md`, `THEOREM_PROVING_DIRECTION.md`, `THEOREM_PROVING_NEXT.md`, `DEFAULT_ON_VERIFICATION.md`, `BEND_LAWS_AND_AGENT_LOOP_LESSONS.md` §A2, `std/spec/`, `src/verifier/vc.yo` and `src/evaluator/builtins/contracts.yo` on develop `a471c290c`, a census of every `ghost_fn` in the tree (§6), and 37 probes in `~/Workspace/Yo-wt/v0273/probe-ghost/` (29 `yo verify` runs, 8 compiled and executed) with the installed v0.2.80 and Z3 5.1.0 (§11). Nothing in the repository was edited or filed. *Judgment* marks an assessment.

## 1. Decision

**Separate them.** `ghost_fn` is deleted and two forms take its place:

- **`logic`**: a total function used in specifications (in prose, a logic function). It has a value, no contract, and its body is its meaning.
- **`lemma`**: a claim with its proof. It has `requires` and `ensures`, its body is checked once, and a use proves the first and learns the second.

`ghost(...)` stays, as the one door from executable code into proof. `law` stays, as a claim that nothing can cite. `assumed()` on a `lemma` is the one spelling of an axiom.

The four words are one family: each is one lowercase noun with no suffix, like `struct`, `enum` and `trait`. `logic` defines, `lemma` proves and can be cited, `law` claims and cannot be cited, and `ghost` is the door. A later declaration form follows the same shape. A later statement (`assert_by`) follows `assert`.

The reason is not the name. Today the two uses are told apart by shape (`src/verifier/vc.yo:6749`: unit return and at least one `ensures`), and then both are checked by the rules written for executable functions: a path that panics owes nothing, a loop need not end, and a call may reach any function. Those rules are sound for code that runs and unsound for code that is erased. Seven programs prove `r == 42` and print `7` (§2.1). Each of the two uses needs its own rules, and a form that has its own rules should have its own name.

| Claim | Confidence |
| --- | --- |
| Separate spec from proof | 90% |
| The rules of §4 (they hold whatever the names are) | 85% |
| The name `logic` for the spec function (VERDICTS-92) | 65% |
| The spec function is not spelled `spec` | 85% |
| `lemma` keeps its name | 90% |
| A `logic` function is total: no `requires`, no `ensures` | 75% |
| A specification cannot call a contracted executable function, except in a `law` (§4.2) | 70% |
| Two seed generations are enough (§7) | 85% |
| The rules land first, under today's spelling (§8, PR 1a and 1b) | 85% |

## 2. Why

### 2.1 One form, checked by rules that fit neither use

Every row is two files on v0.2.80. The `p` twin has no `main`, and `yo verify --strict` passes it with exit code 0. The `r` twin adds a `main` that prints the result; `yo compile` reports every function except `main` as `ok`, and the "runs" column is the binary's output.

| Probe | Program | Proved | Runs | The missing rule |
| --- | --- | --- | --- | --- |
| `p02`, `r02` | a lemma whose body is `panic(...)`, used as `ghost(bogus(x))` | `r == 42` for every `x` | prints `7` | a proof must end normally on every path |
| `p03`, `r03` | a lemma whose body is `while(true, { invariant(true); })` | `r == 42` | `7` | a loop in a proof must terminate |
| `p04`, `r04` | a recursive value `ghost_fn` whose measure drops only under its `requires`, and whose self call breaks that `requires` | `r == 42` | `7` | a spec function's termination may not lean on a precondition nobody checks |
| `p13b`, `r13` | a value `ghost_fn` with a `panic` arm, bound by `ghost(t := only42(x))` | `r == 42` | `7` | a spec function has a value on every path |
| `p05b`, `r05` | `ghost(xs.push(i32(7)))`, then `xs.len()` | `r == 1` | `0` | erased code may not change state the program reads |
| `p06`, `r06` | `ghost(v := spin(x))`, where `spin` never returns and so proves any `ensures` | `r == 42` | `7` | erased code may not call a function that is correct only if it returns |
| `p17`, `r17` | an `ensures` clause that calls the same `spin`; the clause is proved, so its assert is erased | the caller's `r == 42` | `7` | the same, for a clause |

How each one happens:

- `r02`, `r13`: a path that reaches `panic` is dead and owes no `ensures` (`vc.yo:4741`). For code that runs, the program stops there. A lemma and a spec function never run, so nothing stops.
- `r03`, `r06`, `r17`: partial correctness is the default (D12). A function that never returns satisfies every post-condition. That is true of a run, and false of a fact assumed where the callee was never run.
- `r04`: a recursive `ghost_fn` becomes an uninterpreted function with the axiom `forall args. f(args) == body` (`vc.yo:6419`). The measure is proved under the function's `requires`, the `requires` is not checked at the self call, and the axiom is unconditional. `bad(n) == bad(0) + 1` for every `n` is false at `n = 0`.
- `r05`: `ghost(e)` walks any expression (`vc.yo:4700`) and codegen erases it.

All seven are S1 by `issues/README.md`. PR 0 filed them, each with its probe as `issues/repros/2026-11-27-<name>.yo` (the verified twin) and `-run.yo` (the printing twin):

| Probe | Issue |
| --- | --- |
| `p02`, `r02` | `issues/2026-11-27-a-panicking-lemma-proves-anything.md` |
| `p03`, `r03` | `issues/2026-11-27-a-looping-lemma-proves-anything.md` |
| `p04`, `r04` | `issues/2026-11-27-a-recursive-ghost-fn-axiom-is-inconsistent.md` |
| `p13b`, `r13` | `issues/2026-11-27-a-spec-ghost-fn-with-a-panic-arm-proves-anything.md` |
| `p05b`, `r05` | `issues/2026-11-27-a-ghost-statement-mutates-state-the-program-reads.md` |
| `p06`, `r06` | `issues/2026-11-27-a-ghost-binding-calls-a-diverging-function.md` |
| `p17`, `r17` | `issues/2026-11-27-an-ensures-clause-calls-a-diverging-function.md` |

They are not seven bugs to patch one at a time: each is an executable-code rule applied to erased code.

### 2.2 The shape test gives near misses the other meaning

| Probe | What the author wrote | What it is by shape | Result |
| --- | --- | --- | --- |
| `p20` | a lemma that returns its witness: `requires(x % 2 == 0)`, `ensures(k + k == x)`, `-> (k : u32)` | a spec function | the `requires` is not checked at the use, the `ensures` is not learned; no diagnostic |
| `p07` | a value `ghost_fn` with an `ensures` | a spec function | the `ensures` is proved in its own task and never used by any caller |
| `p08` | a `unit` `ghost_fn` with a `requires`, an `assert` and no `ensures` | a spec function | inlined at the use: its `assert` is proved again in the caller, and its `requires` is not checked |
| `p09b`, `p22` | a lemma called inside a value `ghost_fn` body or an `ensures` block | accepted | a specification carries a proof step; this is the only way a `law` can use a lemma today |
| `p19` | a value `ghost_fn` whose body has a loop | a spec function | `loopy(x) == loopy(x)` is refuted: it is not a function |
| `p14` | `half(7)` where `half` has `requires(x % 2 == 0)` | accepted | documented: the `requires` of a value `ghost_fn` is a comment |

The last row is the documented "total reading". `requires` means "proved at every call" on every other form in the language. On a value `ghost_fn` it means nothing at a call and "assumed" inside, which is what `r04` exploits.

### 2.3 What other systems do

| System | Spec function | Proof | Executable | What it enforces |
| --- | --- | --- | --- | --- |
| Verus | `spec fn`: total, no `requires` or `ensures` (`recommends` is advisory), `open`/`closed`, `decreases … when` | `proof fn`: must terminate, may call spec and proof only; used in `proof { }` blocks and `assert … by` | `fn` | mode checking: spec cannot call proof or exec; proof cannot call exec |
| Dafny | `ghost function` (and `function`, which is also compiled): `requires` checked at every call, termination mandatory | `lemma`: termination mandatory, may return ghost values | `method`: opaque to callers, never callable in a specification | `decreases *` is allowed on methods and loops only |
| F\* | `Tot` and `GTot` | the `Lemma` effect: a unit-returning function with a pre- and post-condition | `ST`, `Dv`, … | a `Dv` (possibly diverging) computation cannot be used in a specification or a proof |
| Lean | `def` (`partial def` is opaque to the logic) | `theorem` | the same `def` | a theorem's body is never unfolded; a partial function gives the logic nothing |
| ATS | static terms | `prfun`, with a termination metric | `fun` | proofs are total |

Two points:

- F\*'s `Lemma` is exactly Yo's shape, a unit function with an `ensures`. F\* still gives it its own effect, because the effect is what keeps divergence out of it. Lean, where a proof is a term like any other, still has two keywords, because the two are unfolded and erased differently. No system in the table tells the two apart by shape alone.
- Every one of them makes the proof side total. That is the rule Yo is missing.

### 2.4 Yo's principles

- *Explicit over implicit.* A reader of `x :: ghost_fn(...)` must find the return type and look for an `ensures` to know which rules apply. `x :: lemma(...)` says it.
- *The exact design over a patch.* The patch is seven verifier fixes keyed on the shape test. The exact design is two forms with their own rules; the seven fall out of it.
- *Written by models, checked by the compiler, read by people.* A model that writes the `p20` shape gets a green run that means something else. With two forms the compiler can say "a `logic` function has no `ensures`: state the property as a `lemma`".
- *Builtin names are reserved.* The cost is one word net: `logic` and `lemma` in, `ghost_fn` out. Neither word is bound anywhere in `src/`, `std/` or `tests/` (VERDICTS-92 §1), so the reservation needs no sweep. Both words are reserved from v0.2.81 by the reserve-builtin-names PR (E0407, `is_reserved_ahead_name` in `src/evaluator/memory-safety.yo`), before PR 2 makes them builtins.

## 3. The surface

### 3.1 `logic`

```yo
// v occurs in xs[0..n). Total: at n > xs.len() it reads unspecified elements.
member :: logic(
  (fn(xs : &ArrayList(i32), n : usize, v : i32, decreases(n)) -> bool)(
    cond(
      (n == usize(0)) => false,
      true => (member(xs, n - usize(1), v) || (xs(n - usize(1)) == v))
    )
  )
);

non_zero :: logic((fn(x : i32) -> bool)(x != i32(0)));
safe_div :: (fn(num : i32, denom : refine(i32, non_zero)) -> (r : i32))(num / denom);
```

### 3.2 `lemma`

```yo
// Two lists that agree on [0, n) have the same members there.
member_frame :: lemma(
  (
    fn(
      a : &ArrayList(i32),
      b : &ArrayList(i32),
      n : usize,
      v : i32,
      requires(n <= a.len(), n <= b.len(), forall(i : usize, (i < n) ==> (a(i) == b(i)))),
      ensures(member(a, n, v) == member(b, n, v)),
      decreases(n)
    ) -> unit
  )(
    cond(
      (n == usize(0)) => (),
      true => member_frame(a, b, n - usize(1), v)
    )
  )
);
```

A use in executable code is a ghost statement. Inside a lemma body, which is already proof, the call is bare (as the recursive call above):

```yo ignore
ghost(member_frame(xs, out, xs.len(), v));
```

A lemma may return what it found (PR 3). The value is ghost, and the caller learns the `ensures` about it:

```yo
member_witness :: lemma(
  (
    fn(
      xs : &ArrayList(i32),
      n : usize,
      v : i32,
      requires(n <= xs.len(), member(xs, n, v)),
      ensures(k < n, xs(k) == v),
      decreases(n)
    ) -> (k : usize)
  )(
    cond(
      (xs(n - usize(1)) == v) => (n - usize(1)),
      true => member_witness(xs, n - usize(1), v)
    )
  )
);
```

```yo ignore
ghost(k := member_witness(xs, xs.len(), v));
```

An axiom is a lemma that is trusted instead of proved. It reports `assumed`, and `--strict` rejects it:

```yo
mul_commutes :: lemma((fn(a : u64, b : u64, ensures((a * b) == (b * a)), assumed()) -> unit)(()));
```

### 3.3 `law`, with an optional proof (PR 1a)

A law keeps its form. It gains an optional second argument, a proof block over the law's parameters, because a specification can no longer call a lemma (§4.2) and a law that needs induction must cite one somewhere. It lands in the PR that takes the old way away:

```yo
// `contains` is executable, with ensures(r == member(xs, xs.len(), v)).
contains_agrees :: law(fn(
  a : &ArrayList(i32),
  b : &ArrayList(i32),
  v : i32,
  requires(seq_of(a) == seq_of(b)),
  ensures(contains(a, v) == contains(b, v))
) -> unit, {
  member_frame(a, b, a.len(), v);
});
```

### 3.4 How the other pieces fit

| Piece | Place in the design |
| --- | --- |
| `ghost(name := e)` | a ghost binding in an executable body; `e` is a specification, or a lemma call that returns a value |
| `ghost(step)` | a proof step in an executable body: a lemma call, or `assert_by(...)` when E2 lands. Nothing else |
| `assert_by(P, { … })` (E2, not built) | a proof step. Its block is a proof context; only `P` leaves it. Bare in a lemma body, `ghost(assert_by(...))` in executable code, as `THEOREM_PROVING_DIRECTION.md` §4 item 4 already writes it |
| `law(fn-type)` | a claim proved from contracts, in a file the implementation does not own. It has no uses, which is why its clauses may name contracted functions (§4.2) |
| `assumed()` | on an executable function: a trusted contract (unchanged). On a `lemma`: an axiom. On a `logic` function or a `law`: an error |
| a spec-transparent function | an executable function with no contract clause is its own contract: a specification may call it and the call means its body, when the body is one a `logic` function could have (§4.3) |
| `refine(T, p)` | `p` is a one-parameter `logic` function returning `bool` |
| broadcast lemmas, `broadcast use` (T4b) | attach to `lemma`: a trigger on its `ensures` and an opt-in scope. Not designed here. A `logic` function is never broadcast: it is already unfolded where it is used |

## 4. The rules

### 4.1 Three contexts

`EvalContext.is_ghost_context` (`src/evaluator/context.yo:436`) is one flag for two things. It becomes a three-valued mode:

| Context | Where |
| --- | --- |
| **exec** | the body of an ordinary function |
| **spec** | a `requires`, `ensures`, `invariant` or `decreases` predicate; a `logic` function body; a `refine` predicate; a law's clauses; the right-hand side of a ghost binding; the `P` of `assert_by` |
| **proof** | a `lemma` body; the argument of a `ghost(...)` statement; an `assert_by` block; a law's proof block |

### 4.2 What may call what

| Callee | from exec | from spec | from proof |
| --- | --- | --- | --- |
| `logic` | no | yes | yes |
| `lemma` | only as `ghost(...)` | **no** | yes |
| executable, no contract, functional body (spec-transparent) | yes | yes: the call means its body | yes |
| executable, with a contract | yes | **no**, except in a law's clauses | **no** |
| executable, anything else | yes | no | no |
| the list model's reads (`len`, `is_empty`, `xs(i)`, `get`) | yes | yes | yes |

- **A contracted executable function is not callable from a specification or a proof.** Its contract was proved for runs that return, and nothing runs it here (`r06`, `r17`). This is Dafny's rule for a `method` and Verus's for an exec function. The author removes the contract, so the body is the spec, or writes a `logic` function.
- **A law's clauses are the exception, and the reason is that a law has no uses.** `ensures((abs_value(x) + abs_value(x)) >= i64(0))` in a law reads "for every result `abs_value`'s contract allows". That is a statement about contracts, and nobody can assume it afterwards. A lemma's clauses get no such exception: a lemma is cited from running code.
- **A lemma is not callable from a specification.** `p22`'s `ensures({ lem(x); pos(x) })` becomes an error, and the law's proof block (§3.3) replaces it.
- Cost: a scan of `tests/spec`, `std` and `src` (`census2.py`; it sees callees defined in the same file) found one clause outside a law that calls a contracted function, in `tests/spec/fixtures/valid/ensures-call-in-and.yo`. It moves into a law. PR 1a re-counts with the compiler. Six `ghost(...)` statements exist outside compiler strings, and all six are a binding or a lemma call.

### 4.3 The rules of each form

| | `logic` | `lemma` | executable `fn` (unchanged) |
| --- | --- | --- | --- |
| Return | any type but `unit` | `unit`; or a labelled ghost value, after PR 3 | any |
| `requires` | not allowed | proved at every use, assumed in the body, never checked at run time | proved at every call, assumed in the body, checked at entry |
| `ensures` | not allowed | at least one; proved by the body, assumed at every use | proved by the body, assumed at every call |
| `decreases` | required when it recurses, alone or in a clique; proved from the body's own guards, with no assumption | required when it recurses; every `while` in the body needs one | optional (D12) |
| Body | one expression: literals, operators, `cond`, `match`, `:=` bindings in a block, quantifiers, the ghost collections, calls per §4.2. No loop, assignment, `panic`, `assert`, `ghost(...)`, early `return` | statements and expressions per §4.2. No `panic`, no early `return`, no `ghost(...)` wrapper | anything |
| Meaning at a use | its body. Not recursive: unfolded in place. Recursive: an uninterpreted function with the definitional axiom, triggered on the application, **unconditional** | its contract. The body is never opened by a caller | its contract; or its body, when it has no contract and the body would be a legal `logic` body |
| Obligations in its own task | `decreases-step` only. A division or an index in the body is the SMT operator, total, as in a quantifier body today | `ensures#N`, `decreases-step`, `loop-variant-*`, the `requires` of each lemma it calls, and index, divisor and shift obligations | as today |
| `assumed()` | error | an axiom: the body must be `()`, the outcome is `assumed` | a trusted contract |
| Erased | always, in every mode | always, in every mode | no |
| Report id | `logic@<file>:<row>`, and only when it recurses | `lemma@<file>:<row>` | `fn@<file>:<row>` |

Why each choice:

- **No `requires` on a `logic` function.** The unconditional axiom is consistent exactly when termination is proved with no assumption. Then the equation has one total solution by recursion on the measure. A `requires` that guards termination but is not checked at calls is `r04`. Dafny's other answer, checking it at every call inside every specification, was tried in R2 slice 2 and dropped (`THEOREM_PROVING_NEXT.md` §7). Yo's specification operators are already total (`seq_nth`, an index inside a quantifier), so a total function is the reading that matches. A domain is written as a guard in the body, as every recursive fixture already does with `(n == usize(0)) => …`.
- **No `ensures` on a `logic` function.** Today it is proved and never used (`p07`). Dafny assumes it at every use, which is an ambient fact; a `lemma` states it and a caller cites it.
- **A non-recursive `logic` function has no task.** It claims nothing. Today each one adds an `ok — no obligations` line and one to the `vacuous` count, which is the count a reader watches for real vacuity.
- **A lemma is total.** `panic` in a proof context is an error, a loop needs `decreases`, and recursion already does. Proving "this case cannot happen" is `assert(false)` under the contradicting path.
- **A lemma has no run-time fallback.** In `verify+` an unproven lemma reports "the runtime assert stays" today (`p24`), and nothing stays: the claim is erased. A result that rests on an unproven lemma is capped at `unproven`. This rides the capping mechanism of `DEFAULT_ON_VERIFICATION.md` S2 and must hold before S6b.
- **`ghost(...)` inside a proof or a specification is an error.** It is redundant there, and one spelling is easier to write and to read.
- **A lemma is bound with `::`.** A `logic` function may also appear as an expression (`refine(T, logic(...))` in `std/spec`).

### 4.4 What does not change

- Partial correctness stays the default for executable code (D12). The new totality rules apply to erased code only.
- The modular rule, the frame rule, `old`, `invariant`, `produced`, `distinct`, `seq_of`, trait variance and generics.
- An `assert(P)` in an executable body: checked at run time in `runtime` mode, proved in a verify mode.
- `runtime` mode still proves nothing. A `logic` function or a `lemma` there is checked by the evaluator (forms, contexts, §4.2) and erased.

## 5. Diagnostics

Every row is an evaluator error, so `yo check` reports it in every mode. Codes are taken from the registry when the PR is written. "Repair" means the diagnostic carries the one edit `yo fix` applies.

| # | When | Message | Repair |
| --- | --- | --- | --- |
| 1 | `requires` on a `logic` function | a `logic` function is total and has no precondition; guard its body with `cond(...)`, or state the condition where it is used | remove the clause |
| 2 | `ensures` on a `logic` function | a `logic` function has no post-condition, its body is its meaning; state the property as a `lemma` | none (two intents) |
| 3 | a `logic` function returning `unit` | a `logic` function has a value; a claim is a `lemma` | none |
| 4 | a loop, assignment, `panic`, `assert` or early `return` in a `logic` function body | a `logic` function body is one expression with a value on every path | none |
| 5 | a `lemma` with no `ensures` | a lemma must claim something | none |
| 6 | `panic` or an early `return` in a proof context | a proof ends normally on every path; for an impossible case write `assert(false)` | none |
| 7 | a lemma called in an executable statement | a lemma is a proof step: `ghost(name(args));` | wrap in `ghost(...)` |
| 8 | a lemma called in a specification | a specification cannot call a lemma; cite it in a proof before the fact is needed | none |
| 9 | a contracted executable function called from spec or proof | `f` has a contract, so its body is not its meaning; use a `logic` function, or remove the contract; a `law` can state claims about `f` | none |
| 10 | `ghost(e)` where `e` is not a binding or a proof step | `ghost(...)` takes a ghost binding or a proof step | none |
| 11 | `ghost(...)` in a spec or proof context | already ghost | unwrap |
| 12 | a `logic` function called from exec (exists today) | reworded for `logic` | none |
| 13 | `assumed()` on a `logic` function; a non-`()` body on an `assumed()` lemma | nothing to assume / an axiom has no proof | none |
| 14 | `refine(T, p)` with `p` not a `logic` function (exists today) | reworded | none |
| 15 | `ghost_fn` outside `std/` (Generation A only, §7) | not a builtin; `logic` or `lemma` | rename by shape |

Verifier reports that change: a `while` without `decreases` in a lemma is a subset error naming the loop; "not spec-transparent" gains the reasons "its body can panic" and "its body has a loop"; a recursive `logic` function without `decreases` keeps today's subset error, reworded.

## 6. Migration

The census (`probe-ghost/census.py`): 48 `ghost_fn(` sites in `.yo` files under `std/` and `tests/`. 8 are in `std/spec`, 39 in `tests/spec`, and 1 is a program inside a string literal in `tests/internal/lsp-protocol.test.yo`. Two of the 48 are arity tests (`ghost_fn()`); the other 46 by shape:

| Shape today | Sites | Becomes | How |
| --- | --- | --- | --- |
| value, no clause (1 with `decreases`) | 33 (8 in `std/spec`) | `logic` | `yo fix`, head rename |
| `unit` with `ensures` | 4 | `lemma` | `yo fix`, head rename |
| value with `requires` (6 with `decreases`) | 7 | `logic`, the `requires` removed | `yo fix`: diagnostic 1's repair, then the rename |
| value with `ensures` | 2, both fixtures of one diagnostic | `logic`, clauses removed | by hand |
| `unit` without `ensures` | 0 | an error | none needed |

- `yo fix` repairs by diagnostic, one edit each, so the order is: PR 1b makes the two shapes exact (rows 3 and 4 above are edited there), and PR 2's rename then has exactly one answer per site.
- `docs/en-US` and `docs/zh-CN` hold 4 definitions each. `tests/internal` holds 16 mentions in four files: test names, comments and the one embedded program. Both are edited by hand: `yo fix` does not read Markdown or strings.
- `plans/` and `issues/` are records and are not rewritten. `AGENTS.md` "Reading historical documents" gains the row: `ghost_fn(...)` reads as `logic(...)` for a value, `lemma(...)` for a `unit` function with an `ensures`.
- The example repositories: run `yo fix` in each during Generation A. Expected: no site.

## 7. Seed gating

What the seed reads: `std/spec/numeric.yo` and `std/spec/refine.yo` (8 `ghost_fn` sites, all plain predicates), through `yo verify ./std/spec` in the FV job and through `yo check ./std --std-path ./std`. The seed also verifies `tests/spec/verify-straight-line.test.yo` and the compiler's own sources, and neither defines a `ghost_fn`. The `yo test` steps and the docs checks run on stage 1. So only those eight lines are gated.

| Generation | Tree | Ships in |
| --- | --- | --- |
| **A** | The compiler has `logic` and `lemma`. `ghost_fn` is accepted under `std/` only, with exactly the meaning of `logic`, so `std/spec` reads the same under the seed and under the tree. Anywhere else it is diagnostic 15. Tests, docs, the pack, the instructions and the editor grammars are migrated | release R |
| **B** | `SEED_VERSION` = R. `std/spec`'s eight lines become `logic`. `BF_GHOST_FN`, the `std/` exception and diagnostic 15 are deleted; `ghost_fn` is then an unbound name like any other | R + 1 |
| **C** | Not needed. The rules of PR 1a and 1b only reject programs, and `std/` passes them under both compilers. A std lemma library (T1) uses `lemma` and can land with B. `assert_by` and a broadcast spelling are later builtins with their own A and B | — |

The `std/`-only exception follows the precedent of a Generation A rule that applies outside `src/`. It is seed gating, not a compatibility alias: it has no user-visible spelling to keep, and B deletes it.

## 8. Staged PRs

PR 0 is not code: file the seven false proofs of §2.1 as S1 issues, each with its probe as the reproducer, and paste this plan.

| PR | Content | Closes | Size | Seed |
| --- | --- | --- | --- | --- |
| **1a** | The three contexts (§4.1) and the call rules (§4.2) in the evaluator, with `ghost_fn` classified by today's shape in one function. `ghost(e)` takes a binding or a proof step. `law(fn-type, { proof })`, which replaces the lemma call inside a clause. Diagnostics 7–11. `ensures-call-in-and.yo` moves into a law | `r05`, `r06`, `r17`; `p22` | M, about 450 lines and 10 fixtures | none (a new arity, used in no std file) |
| **1b** | The form rules (§4.3) under today's spelling: a value `ghost_fn` has no clause and a functional body; a `unit` one has an `ensures` and a total body. Termination of a recursive spec function without assumptions; no index or divisor obligation in its body; no task when it does not recurse. Diagnostics 1–6 and 13. The 9 fixture sites and the docs' `member` are edited | `r02`, `r03`, `r04`, `r13` | M, about 450 lines and 10 fixtures | none |
| **2** | Generation A: `BF_LOGIC`, `BF_LEMMA`, the classifier reads the head instead of the shape, diagnostic 15 with its repair, `logic@` and `lemma@` report ids, LSP hover, both editor grammars, docs in both languages, `pack/context.md`, `yo-syntax.instructions.md`, the `AGENTS.md` row, the 40 test sites and the 16 mentions in `tests/internal` | — | M, mostly mechanical | A |
| **3** | A lemma may return a labelled ghost value (`p20` becomes a valid fixture). A result resting on an unproven lemma is capped at `unproven` in `verify+` | `p20`, `p24` | S, about 200 lines and 5 fixtures | none (no std use) |
| **4** | Generation B: `std/spec`'s eight lines; delete the bridge | — | XS | B, waits for `SEED_VERSION` = R |

Acceptance gates, each PR:

- `yo check ./src` and `./std` with `--std-path ./std`, and `yo build --std-path ./std`.
- Every probe the PR closes is a `tests/spec/fixtures/negative/` file that the tree binary rejects with the named diagnostic, and that v0.2.80 accepts. Each has a valid twin written the legal way.
- `yo verify` over `tests/spec/fixtures/valid` reports the same proved set as before, minus the vacuous spec tasks (1b) and with the new ids (2).
- One file per call: `tests/spec/contracts-phase0.test.yo`, `tests/spec/refine-types.test.yo`, and `tests/internal/` `verifier-ghost`, `verifier-law`, `verifier-refine`, `verifier-negative`, `verifier-mutual`, `lsp-protocol`. `verifier-list-len` (67 to 108 minutes) is deferred to develop's battery.
- The seed still passes `yo verify ./std/spec` and `yo check ./std --std-path ./std` (all PRs; this is the whole gate of PR 4).
- `scripts/cli-diff-test.sh`, `scripts/check-embedded-yo.sh`, fmt with the tree binary, `scripts/check-issue-refs.sh`.
- PR 1a's body states the count of programs in `tests/` that diagnostic 9 newly rejects. The scan in §4.2 found one.

Order: 1a goes first and 1b stacks on it (it uses the contexts). Both close S1 issues and need neither the names nor a release boundary. 2 stacks on 1b. 3 stacks on 2. T1 (the std lemma library) and E2 (`assert_by`) come after 4 and are written in the new forms from their first line.

## 9. Rejected alternatives

| Alternative | Why not |
| --- | --- |
| Keep `ghost_fn` and fix the seven probes by shape | The rules would be right and the reader would still decode the shape. Near misses (`p07`, `p08`, `p20`) stay silent, because a shape test cannot say "you meant the other one". PR 1a and 1b are this alternative as a first step, not as the end |
| `spec_fn` and `lemma` (VERDICTS-91) | Not one family: a `_fn` compound that names a mode beside a noun that names a thing. A reader cannot tell from the shape that the two are siblings (VERDICTS-92) |
| `spec` and `lemma` | "A spec" already means a contract clause, a law, the `spec/` directory and a format spec (`${x:spec}`), and it is the name of the context of §4.1. The form would be the one item of the specification vocabulary that specifies nothing. `spec` is also bound 36 times in the tree and is the third most common name among the reserved words, after `old` and `runtime` (VERDICTS-92 §1). Verus uses the word only as a modifier of `fn` |
| `def` or `defn` and `lemma` (Lean) | `def` is the runnable function of Python, Ruby and Scala, and `defn` of Clojure: the opposite of the property that matters. "Definition" already means any `::` binding |
| `predicate`, `formula` | `predicate` is `bool`-only in Dafny, ACSL, Why3 and VeriFast, and a spec function returns any type. `formula` has no precedent and reads `bool`-only to a logician |
| `logic` and `proof_fn`, or `spec_fn` and `proof_fn` (Verus) | `proof_fn` names the mode, `lemma` names the thing. The docs, the T1 plan and the fixtures already say "lemma", Dafny (the corpus models write best, `THEOREM_PROVING_DIRECTION.md` §3), ACSL, Why3 and VeriFast say `lemma`, and `law` / `lemma` read as a pair |
| Keep `ghost_fn` for the spec function, add `lemma` | "Ghost" means erased, and a lemma is erased too (Dafny's lemma is a ghost method). `ghost(lemma(...))` beside `ghost_fn` would keep one word for two things. A rename also makes `yo fix` visit every site once |
| Keep `requires` on a `logic` function, checked at every call (Dafny) | Exact, and heavy: every specification that mentions the function owes the obligation, under quantifiers too. Tried and dropped in R2 slice 2. Open question 2 keeps the door |
| Keep `requires` on a `logic` function as an advisory `recommends` (Verus) | A second word for an unchecked hint. An unchecked clause is the thing being removed |
| Guard the definitional axiom by the `requires` | Sound (the function is then unspecified outside its domain), and it keeps `requires` with a third meaning: neither checked nor ignored |
| Let a specification call a contracted executable function when that function is proved total | Needs a totality verdict per function, across files and modes, to keep one fixture. The ban is two production systems' rule |
| Merge `law` into `lemma` | A law may name contracted functions because it has no uses; a lemma may be cited and so may not. One form cannot have both properties |
| An explicit marker for a spec-transparent function | Another reserved word. "No contract clause means the body is the contract" is a rule a reader can apply from the signature. Open question 3 |
| Do it all in one PR | The rules close S1 issues and need no seed; the names need two generations. Tying them delays the fixes by a release |

## 10. Open questions

1. **The names.** Closed by VERDICTS-92: `logic` (65%) and `lemma` (90%). If `logic` is unwelcome the second choice is `spec`, at the costs of §9; PR 2 then also renames the tree's 36 `spec` binders, and every diagnostic says "a `spec` function". No name changes a rule, a PR boundary or the seed gating.
2. **A checked domain for a `logic` function.** Trigger to revisit: a bug traced to a specification applied outside its intended domain.
3. **A marker for spec-transparent functions**, so the definition fails instead of a distant use. Trigger: the first cross-package proof broken by a body edit.
4. **Hiding a body** (`opaque` and `reveal`, Verus's `closed`) and **a `logic` function without a body** (an uninterpreted function). Trigger: a measured query the unfolding leaves `unknown`, or std wanting to hide a representation.
5. **A vacuous law.** `p23`: a law about a function that never returns is `ok` under `--strict`. It is true as a statement about contracts and misleading as a green line. The feasibility probe of `DEFAULT_ON_VERIFICATION.md` S2 is the fix; the law exception of §4.2 should not outlive S2 unprobed.
6. **`verify+` and erased code.** `p24`: under `Pragma.VerifyOrAssert` a caller that cites a lemma is a subset error today ("definition-time evaluation did not complete") and the run exits 0. This belongs to S0's both-modes sweep; PR 3's capping rule assumes S0 has made the lemma layer work in `verify+`.
7. **Mutable ghost state.** `ghost(x = e)` on a ghost binding is not accepted today and not proposed. Trigger: a proof that needs an accumulator outside a lemma body.
8. **Does diagnostic 9 apply to an `assert` predicate in a verify-mode body?** *Judgment:* yes, it is a spec context there; PR 1a confirms what the strip pass does with such an assert before deciding.

## 11. Probes

`~/Workspace/Yo-wt/v0273/probe-ghost/`; `pNN_*.yo` with `pNN.out` are `yo verify` runs, `run/rNN_*.yo` with `rNN.out` are `yo compile` runs whose binaries were executed (outputs in §2.1).

| Probe | Shows |
| --- | --- |
| `p01` | the baseline lemma pair proves (9 obligations) |
| `p02`/`r02`, `p03`/`r03` | a panicking and a looping lemma prove anything |
| `p04`/`r04` | an inconsistent definitional axiom |
| `p05` | `ghost(y = …)` is a subset error; `p05b`/`r05`: `ghost(xs.push(…))` is not |
| `p06`/`r06`, `p17`/`r17` | erased code calls a function that never returns |
| `p07`, `p07b`, `p08`, `p20` | near-miss shapes (§2.2) |
| `p09`, `p09b`, `p22` | a lemma called inside a specification |
| `p10`, `p11` | a recursive lemma without `decreases` is already a subset error |
| `p12` | an `assumed()` lemma is reported `assumed` |
| `p13`, `p13b`/`r13`, `p19` | a spec function that panics; one that loops |
| `p14` | a value `ghost_fn`'s `requires` is not checked at a call |
| `p16`, `p18` | a transparent function with a panic arm or a loop is refuted, not exploited |
| `p21`/`r21` | `runtime` mode erases `ghost(...)` and checks nothing |
| `p23` | a vacuous law |
| `p24`, `p24b`, `p24c` | `verify+`: an unproven lemma, and a broken lemma layer |
| `census.py`, `census2.py` | the shape census of §6 and the clause scan of §4.2 |
