# Safe mode 5b — verifier-driven elision of runtime guards

**Status: BACKLOG — design written 2026-09-28, implementation not started.**
This plan answers the three questions `plans/SAFE_MODE.md` §8 (5b) left open
and is the plan §14 R8 asked for. SAFE_MODE Phase 6 (strict mode) depends on
it. Every fact about today's verifier cites a file and symbol, and says
whether it was measured or read. Anything I reasoned but did not run is
marked *(reasoned)*. The facts were read on `origin/develop @ f27762570` and
probed with the installed seed `yo 0.2.45`.

## 0. The recommendations

1. **No Z3 in codegen.** A guard is removed only on a proof produced by the
   verifier pass inside the same `yo compile` process. With no resolved
   solver, nothing is proved and every guard is emitted. The verify cache
   speeds up the solver but is never a source of proofs on its own.
2. **The channel is in-process, not a file.** `yo compile` already runs the
   verifier before codegen. It records each proved guard site in a side table
   keyed by AST node id, cross-checked against the site's source position.
   Codegen's guard emitters look the site up there. Nothing is written for
   `yo compile` to read back, so no source hash or staleness rule is needed,
   and chunked emission needs no id that crosses translation units. The
   stable position key `(module, row, col, class)` appears in reports and
   tests, never as the trust channel.
3. **The set is sound by construction, then checked by canaries.** A guard is
   removed only if all of the following hold:
   - its obligation's verdict is `Proved` or `PreProved`;
   - its function's report is `ok`, with every obligation proved;
   - no path assumption the proof relied on is unenforced at runtime
     (an unchecked `requires` or refinement, or an `assumed()` callee's
     `ensures`);
   - the target's integer widths match the verifier's model;
   - the body is concrete, not an abstractly verified generic.

   `assumed`, `outside-subset`, `subset-error`, `unproven` (which covers
   timeout and `unknown`), `solver-error` and `refuted` remove nothing. A
   C-diff oracle over the verified corpus fails if a guard disappears at a
   site that no proof names.
4. **Vocabulary.** Index, div/rem-by-zero and shift obligations already exist
   and keep their meaning. `MIN / -1` and `+ - *` / negation overflow get new
   *elision-only* obligations. A failed elision-only obligation keeps the
   guard and never fails `yo verify`. Strict mode (Phase 6) is the switch
   that turns them into errors.
5. **Opt-in is the verify pragma.** Elision is automatic in
   `Pragma.Verify` / `Pragma.VerifyOrAssert` files whenever a proof exists.
   `--no-guard-elision` exists only for A/B runs and as the canaries' oracle.

## 1. Scope and non-goals

In scope:

- Removing the codegen guards Phases 1–3 added (`__yo_idx_chk`,
  `__yo_div_guard[_u]`, `__yo_{add,sub,mul}_chk_*`, `__yo_neg_chk_*`,
  `__yo_sh_chk`) at sites the verifier proves cannot trap.
- The verifier changes that make this sound: per-site obligation identity,
  target-aware widths, assumption provenance, and the new elision-only
  obligations.

Non-goals:

- **Performance as the justification.** 5a measured the guards within CI
  noise (SAFE_MODE §8). 5b exists for two reasons: the per-site
  proved/unproved census that strict mode needs, and hot loops in verified
  code. Phase 1 records the elided-guard count and one microbenchmark. It
  lands even if the benchmark shows no win.
- **std container bounds checks** (`ArrayList`, `Deque`, `String` indexing).
  Those traps are `__yo_panic` calls inside std bodies, not codegen guards.
  Removing them per call site would need unchecked specializations of std
  methods, which is a different design.
- **Float→int casts.** `__yo_sat_*` saturates (D2). It never traps, so there
  is nothing to prove.
- **`str.bytes(i)` on a runtime `str`.** A runtime `str` is outside the
  verifiable subset: `str_bytes` folds only comptime literals
  (`_call_term`, `src/verifier/vc.yo`). Its guard stays until strings enter
  the subset.
- **Runtime-mode files.** A file with no verify pragma gets no verification
  and no elision. Its emitted C must stay byte-identical.
- **A persisted proof artifact** (rejected in §4.3).

## 2. What the verifier does today (facts)

### 2.1 Obligations

All obligations are created by `_emit` (`src/verifier/vc.yo`), which names
them `${ctx.fn_name}/${label}`. `VcObligation` carries only
`{name, query, pre}`: no AST node, no source position, no class.

| Label | Emitted in | Guard it corresponds to |
| --- | --- | --- |
| `divisor-nonzero` | `_call_term`, binop arm, for `BvSdiv/BvUdiv/BvSrem/BvUrem` | the zero half of `__yo_div_guard[_u]` |
| `shift-in-width` | `_call_term`, binop arm, `bvult(count, width(lhs))` | `__yo_sh_chk` |
| `index-in-bounds` | `_call_term` (read `a(i)`), `_begin_term` (write `a(i) = v`); only when the receiver is a **name bound to a fixed `Array(T, N)`** (`ctx.array_sorts`); suppressed inside quantifier bodies | `__yo_idx_chk` on fixed arrays |
| `assert`, `requires#k`, `refine#k`, `ensures#k`, `decreases-*`, `loop-*` | various | none (these are contracts, not guards) |

**No obligation exists** for `MIN / -1`, `+ - *` overflow, or `-MIN`. The
binop arm maps `+ - *` to `bvadd bvsub bvmul`, which wrap, and `/` to
`bvsdiv`, which defines `MIN / -1 = MIN` (`_binop_of_with_sign`). Measured:
`add_near_max :: (fn(a : i32, requires(a > i32(2147483000))) -> (r : i32))(a + i32(1000))`
verifies `ok` with zero obligations (`"vacuous": true`), although every call
traps. This confirms SAFE_MODE §14 R4: trap-freedom is not an obligation yet.

### 2.2 Outcomes

Each obligation's verdict is one of `VerifyVerdict` = `Proved(core)` /
`Refuted(model)` / `Unproven(reason)` / `SolverError(msg)`
(`src/verifier/driver.yo`). `Unproven` covers Z3 `unknown` and rlimit
exhaustion after the one 20× retry in `run_vc_query`. The FV plan maps a
wall-clock backstop firing to the same verdict. `_emit`'s literal folding
adds `pre = PreProved | PreRefuted` without a solver call.

A function report's `outcome` is one of `ok`, `assumed`, `outside-subset`,
`unproven`, `refuted`, `solver-error`, `subset-error`
(`verify_outcome_names`). `ok`, `assumed` and `outside-subset` pass by default
(`_verify_outcome_passes_by_default`). `assumed` and `outside-subset` reports
carry **zero obligations**: an `assumed()` body is never walked, and a subset
error discards the function's obligation list (`verify_and_strip_tasks`).

### 2.3 Report shape (`yo verify --format json`, measured)

The top level is `{solver, z3_pin, mode, harness_ok, self_test, summary, functions}`.
Each function is `{fn_id, mode, outcome, vacuous, obligations, subset_construct, subset_source}`,
and each obligation is `{name, verdict, cached, folded, goal, model}`
(`_verify_fn_report_json`, `src/main.yo`).

**There is no per-site id.** `fn_id` is `fn@<module>:<row>`, with a 0-based
row and no column (`src/evaluator/calls/function_type.yo`). Measured: a
function with two divisions reports two obligations that are both named
`fn@tmp/p5b_div.yo:6/divisor-nonzero`. Also measured: with the 0.2.45 seed,
stdout carries the loader's `check: …` progress lines ahead of the JSON
object, so a consumer has to strip them.

### 2.4 Where the verifier runs

- `yo verify` arms every collected file as a target and defaults the mode to
  `verify`.
- `yo compile` arms **only the entry file**, in both path spellings, unless
  it gets `--no-verify` (the test runner's batches). The pass runs *before
  codegen* (`_run_contract_verification(io, exn, true)` in the compile path
  of `src/main.yo`). The existing precedent for elision is the verify+
  strip pass. It already rewrites function bodies in place, in the same
  process, before codegen (`strip_proved_ensures_asserts`, keyed by `ensures#N`
  index).
- An imported module is never a target, so its contracts stay runtime asserts
  whatever its pragma (`resolve_verify_mode` is consulted only under
  `_is_verify_target`). This is why `std/collections/array_list.yo`, which
  carries `pragma(Pragma.Verify)`, does not make every user compile need Z3.
- Measured: a missing solver fails `yo compile` for **both** `verify` and
  `verify+` files (rc 1). The `strict_missing_solver` branch ignores the
  mode, which contradicts the FV plan's "a missing solver never fails a
  `verify+` build". `yo check` passes with the install hint.
- Measured: a dangling `YO_Z3_PATH` counts as a solver. `discover_z3`
  (`src/verifier/z3.yo`) returns the override without an existence check,
  and `run_vc_query` consults the cache before it runs the binary. So
  `YO_Z3_PATH=/nonexistent/z3 yo compile` reported
  `1 obligation(s) proved` from a warm cache. Both defects are filed in
  `issues/fixed/compile-missing-solver-handling-ignores-verify-plus-and-trusts-a-dangling-z3-path.md`.
  With no override set, a missing solver is `Installable`, and the pass
  returns before any cache lookup.

### 2.5 Integer widths

`_int_width` and `_cast_width` (`src/verifier/vc.yo`) hard-code
`usize`/`isize` to 64 bits. The codegen guards read the target: 32 bits on
wasm32 (`_shift_checked_expr`, `_arith_checked_expr`). A `shift-in-width`
proof of `s < 64` on a `usize` is therefore wrong for wasm32, where the guard
tests `s < 32`. The FV plan's "widths come from the active
`CompilationTarget`" is not what the code does.

### 2.6 The verify cache

`verify_cache_key` hashes the Z3 pin, rlimit, seed, timeout and
`encode_content(q)`. It is content-addressed on the full query, so any
semantic change to the source changes the key. But `_cache_store` computes
its key with `default_verify_run_config()`, not the run's `cfg`. A
`yo verify --rlimit N` verdict is stored under the default-budget key, so a
later default-budget run can reuse a verdict it could not reproduce itself
(read, not measured).

### 2.7 The open-world hole (measured)

In `verify` mode a `requires` is not asserted at runtime, and a contract-less
caller that is outside the subset never proves it. The result is a function
reported `ok` on an assumption nothing establishes. Today only the
division's own guard catches the violation. Recorded, with the repro, in
`issues/fixed/verify-mode-requires-is-unchecked-when-the-caller-is-outside-the-subset.md`.
Refinement parameters have the same shape: `refine(i32, p)` erases to `i32`
at runtime (`tests/spec/fixtures/valid/refine_nonzero_runtime.yo`).

### 2.8 The node a guard emitter sees (measured location, reasoned identity)

The emitters `_checked_index_expr` / `_checked_fixed_array_subscript`
(`src/codegen/utils/index.yo`) and `_div_checked_expr`,
`_arith_checked_expr`, `_neg_checked_expr`, `_shift_checked_expr`
(`src/codegen/exprs/inline_fns.yo`) take the location from
`ast_expr_token(expr)`. Measured: `safe_div`'s guard prints
`"p5b_run.yo", 5, 5`, the user's `/` token, even though `/` reaches
`__yo_op_div` through the prelude's inlined `Div` wrapper, and `pick`'s
guard prints `9, 3`, the user's `xs(i)`. So `expr` is the user's operator
node, and the verifier walks that same node (*reasoned*: the task body is the
evaluated body, and the location proves it is not the prelude's node).
Phase 1's first gate pins this identity with a test.

### Probe record

All probes are under the worktree's `tmp/` (gitignored):
`tmp/p5b_div.yo` (`yo verify --format json`: the duplicate names, the
vacuous overflow, index and shift proofs), `tmp/p5b_run.yo`
(`yo compile --emit-c --skip-c-compiler`: guard locations) and
`tmp/p5b_hole.yo` (`yo compile --optimize 2` and run: the §2.7 hole, rc 134
from the division guard) and `tmp/p5b_vplus.yo` (`yo compile` three ways:
with an empty `YO_CACHE_DIR`, with the normal cache, and with
`YO_Z3_PATH=/nonexistent/z3`; §2.4). Each run took under 1.3 s and under
140 MB.

## 3. Q1 — no Z3 dependency in codegen

**Recommendation: elision is a by-product of the verifier pass `yo compile`
already runs, and it requires `SolverResolution.Resolved` to mean an
existing binary.** Codegen never spawns anything and never reads the cache.
It reads one in-memory table (§4) that is empty unless this process proved
something.

Target behavior once Phase 0 has fixed the two §2.4 defects:

| Situation | Guards |
| --- | --- |
| runtime-mode file (no verify pragma) | all emitted; C byte-identical to today |
| `Pragma.VerifyOrAssert`, no solver | all emitted, with every contract assert kept (today: no binary, §2.4) |
| `Pragma.Verify`, no solver | no binary (today's `strict_missing_solver` failure, kept) |
| dangling `YO_Z3_PATH` | `InvalidPath` error (today: cache-only "proofs", §2.4) |
| verify / verify+, solver present | a proved site's guard is removed (§5 filter) |
| `--no-guard-elision` | all emitted, whatever was proved |
| `--no-verify` (test batches) | all emitted |

**The cache speeds the solver up; it is never an oracle.** Verdicts are
deterministic: rlimit budget, `random-seed 0`, a pinned Z3. So a warm cache
and a cold cache with a solver produce the same C. Letting a cache hit count
*without* a solver would make the binary depend on the machine's cache
state: same source, same compiler, different C. That breaks the property
the byte-identity gates rely on. This requires the §2.6 key fix, or a
`--rlimit` run poisons the default-budget key.

## 4. Q2 — the channel

### 4.1 Recommendation: an in-process proved-site table

The verifier records, per proved guard obligation, a `GuardSite`. The
driver turns the filtered set (§5) into a table that lives next to the
`VerifyTask` registry in `src/evaluator/builtins/contracts.yo`. The registry
lives there so no evaluator or codegen file imports `src/verifier/`, and the
table keeps that layering:

```rust
GuardClass :: enum(Index, DivZero, DivOverflow, AddOverflow, SubOverflow, MulOverflow, NegOverflow, ShiftWidth);
GuardSite :: struct(
  node_id : usize,
  module_path : String,
  row : usize,
  column : usize,
  class : GuardClass
);
// node id -> the classes proved at that node (a signed `/` needs DivZero AND DivOverflow).
(g_proved_guard_sites : HashMap(usize, ArrayList(GuardSite))) = HashMap(usize, ArrayList(GuardSite)).new();
```

Each emitter asks one predicate before splicing its helper, and if the answer
is yes it emits exactly what the guard wraps: `_binop(args, op)` for
div/rem/shift, the plain op for arithmetic, `_unop_narrowed` for negation, the
raw index for subscripts:

```rust
guard_site_is_proved :: (fn(expr : AstExpr, class : GuardClass) -> bool)(...);
```

The predicate is true only when three things match: the node id, the
`GuardClass`, and the node's token `(canonical module path, row, column)`
compared against the recorded position. The position check guards against
node-id aliasing, for example the "single-expression begin shares its tail's
id" pitfall in AGENTS.md. A mismatch keeps the guard.

The table is drained per compile, the way `take_verify_tasks` drains the
registry. Otherwise `yo build --watch` / `yo compile --watch` rounds would
see a stale table.

### 4.2 The site ids and what invalidates them

- **The trust key is the node id, and it never leaves the process.** It is
  exact: two guards at one source position, such as two specializations or
  two macro-expansion nodes carrying the macro call's token, have different
  ids. It needs no stability, because the proof and the emission come from
  one parse of one byte string. Cloning with fresh ids
  (`clone_expr_fresh_ids`: contract splices, specializations) produces nodes
  that are not in the table. That fails safe: a missed elision, never a
  wrong one.
- **The display key is `(canonical module path, row, column, class)`.** It is
  the triple the guard already prints, so the C file, the report and a test
  can all name the same site. It is stable across processes while the file's
  bytes before the site are unchanged. Any edit or `yo fmt` that moves the
  token invalidates it. Canonicalize with `_canonical_module_path`: the
  "two spellings of a module path" pitfall in AGENTS.md, and
  `issues/fixed/verify-report-fn-id-carries-file-scheme-absolute-path.md`.
- **Obligation names become unique.** The name is
  `${fn_name}/${label}@${row+1}:${col+1}`, and each JSON obligation gains
  `"site": {"module", "row", "column", "class"}` (null for contract
  obligations). This alone fixes §2.3's duplicate names.

### 4.3 Why not a `yo verify` → `yo compile` artifact (rejected)

- **Freshness would need the whole query.** A proof depends on the function
  text, the path conditions, every callee contract it assumed, the prelude,
  the target widths, the Z3 pin and the budget. The only complete freshness
  key is the encoded query itself, and computing it means doing the walk. At
  that point only the solver is left to save, and the cache already saves it.
- **No cross-process id is exact.** Node ids are allocation order. Source
  positions alias under macros and specializations, and a position-keyed
  artifact would remove guards at every aliased site.
- **A writable file would become a trust root for removing safety checks**,
  outside anything a code review sees.
- **It changes nothing for Q1.** The artifact would still need a proof, and
  that proof needs a solver somewhere. The in-process design needs it in the
  same place.

### 4.4 Chunked emission, the `.o` cache, watch mode

`--emit-chunks N` splits the C that one in-process codegen emitted
(`plans/reference/CHUNKED_C_EMISSION.md`). The decision is made while the
text is emitted, so a chunk simply contains either the guard or the raw
operation. The `.o` cache key hashes the shared header, the chunk text and
the argv, so an elision change invalidates exactly the units whose text
changed. The guard helpers stay `static inline` in the shared header, used
or not. No id has to cross a unit.

### 4.5 Freshness and staleness rules

- In-process there is nothing to go stale.
- In the cache, a stale entry cannot match, because it is content-addressed
  on the query. Two keying fixes land in Phase 0: store under the run's
  `cfg` (§2.6), and add a `VERIFIER_CACHE_EPOCH` constant to the key. Bump
  it whenever verdict *interpretation* changes (`verdict_of_response`,
  `_verdict_of_json`), because a fix there leaves the query text unchanged
  and would otherwise reuse old verdicts.

## 5. Q3 — soundness of the elided set

### 5.1 Filter rules (all must hold)

1. **Verdict.** Only `Proved(_)` or `PreProved`. `Unproven` (unknown,
   timeout, budget), `SolverError` and `Refuted` never qualify.
2. **The function is all-or-nothing.** Its report outcome must be `ok`. The
   obligations of one function depend on each other: a loop body's proofs
   assume the invariant, which is sound only if `loop-invariant-entry` and
   `-iterate` proved, and proofs after a call assume the callee's `ensures`.
   In `verify` mode a binary exists only if the outcome is `ok` anyway. In
   `verify+` this rule is what stops an unproven invariant from licensing
   the guards in its loop body. `assumed` and `outside-subset` reports have
   no obligations (§2.2), so they are excluded twice over.
3. **Assumption provenance.** Every push onto `VcCtx.path` becomes a
   `(term, enforced)` pair. There are 15 push sites in `vc.yo`, all in
   `_while_term`, `_call_term`, `_unwind_path_guards`, `_cond_ite`,
   `_callee_call_term` and `verify_function_body`. `_emit` records whether
   any unenforced assumption was in Φ, and such an obligation never elides.
   It still counts as proved for `yo verify`.

   | Assumption source | Push site | Enforced? |
   | --- | --- | --- |
   | branch / `&&` / `||` / loop-exit conditions | `_cond_ite`, `_call_term`, `_while_term`, `_unwind_path_guards` | yes: control-flow facts |
   | loop invariant after havoc | `_while_term` | yes, given rule 2 |
   | own `requires` | `verify_function_body` | verify+: yes (the entry assert is spliced); verify: **no** until the §2.7 issue is fixed |
   | own `refine(T, p)` parameters | `verify_function_body` | **no**: the predicate erases at runtime (§2.7) |
   | callee `ensures` | `_callee_call_term` | yes if the callee's ensures are runtime-asserted (runtime / verify+ unproven) or proved in this compile; **no** for an `assumed()` callee in a `verify` target (its splice is suppressed and its body never walked) and for a contracted generic callee (`issues/fixed/verifier-contracted-generic-fn-is-silently-unverified.md`) |

   This rule is what "`assumed()` must never elide a guard" means in
   practice. An assumed function has no obligations of its own, and a
   *caller's* proof that leans on its `ensures` is excluded too.
   The rule is structural and fails safe. If the ledger (§5.3) shows it
   blocking too much, the refinement is to name path assumptions
   (`VcQuery.assume_named`; today's path terms are unnamed) and test the
   unsat core instead of all of Φ. A core is itself unsatisfiable, so
   excluding the unenforced names from the core is still sound.
4. **Target widths.** No elision on a target whose pointer width is not 64
   until `_int_width` / `_cast_width` read the target (Phase 0 fixes this).
5. **Concrete bodies only.** An abstract proof of a generic body
   (V6 task 2 uninterpreted sorts, walked since 2026-10-01) removes nothing:
   `VerifyTask.body_abstract` makes every obligation of such a task
   non-elidable. Guard bounds are
   width-specific, and the specializations are distinct emissions.

### 5.2 Why the bit-vector model over-approximates (reasoned)

The verifier models `+ - *` as wrapping and `MIN / -1` as `MIN`, while the
runtime traps. On every path that continues past an operation, the runtime
value equals the modeled one. On a path where the operation overflows, the
runtime stops. So the modeled states are a superset of the reachable states,
and a proof over the superset holds over the reachable ones. This is why an
elision-only obligation proved under a Φ that contains earlier wrapping
operations is sound, and why §2.1's missing obligations cost completeness,
never soundness. An out-of-bounds `select` returns an unconstrained element,
which is the same argument for index reads.

### 5.3 Canary discipline

- **The C-diff oracle** is the test that fails if a guard disappears without
  a proof. For each fixture in `tests/spec/fixtures/valid/` plus the 5b
  fixtures, it emits C twice, with and without `--no-guard-elision`. Every
  hunk of the diff must turn a guard helper call carrying `"file", r, c`
  into its raw operation, and `(file, r, c, class)` must appear as a
  `proved` obligation `site` in `yo verify --format json` for the same file.
  A hunk with no matching proof fails the test, and so does a hunk that
  changes anything else. Home: `scripts/check-guard-elision.py`, run by the
  `guard-elision` CI job (stage 1 plus the pinned Z3; the FV job runs the
  seed, which has no `--no-guard-elision`).
- **Twin fixtures** (cli-cases) check that elision fires and that it stops
  where it should:

  | Case | Expect |
  | --- | --- |
  | verify+ `safe_div` with `requires(b != 0)`, and an unproven twin | the proved twin's body has 0 `__yo_div_guard`; the unproven twin has 1 |
  | verify `pick(xs, i)` with `requires(i < 4)` | 0 `__yo_idx_chk` in `pick` |
  | verify+ loop with an unproven invariant | every guard in the loop body present |
  | a caller that relies on an `assumed()` callee's `ensures` | guard present |
  | a `refine` parameter as the only premise | guard present |
  | `--target wasm32-wasip1` of a proving fixture | C identical to `--no-guard-elision` |
  | verify+ under an empty `YO_CACHE_DIR` (no solver, cold cache) | C byte-identical to `--no-guard-elision` |
  | `YO_Z3_PATH=/nonexistent/z3` with a warm cache | `InvalidPath` error, no C |
  | the §2.7 repro | still rc 134 |

- **Byte-identity** for runtime-mode code: the sha256 of the self-emit
  (`yo compile src/main.yo --emit-c --skip-c-compiler`) is unchanged by
  every phase. `src/` has no verify-pragma entry, and the compiler's own
  code must not move.
- **The elision must actually fire** (the "verify an optimization fires"
  lesson): the compile report line gains `N guard(s) elided`, and each twin
  case asserts N.

## 6. Obligation vocabulary

Two kinds of obligation. A **correctness** obligation keeps today's
semantics: refuted is a compile error, and unproven fails `verify` or
degrades `verify+`. An **elision-only** obligation decides a guard and
nothing else. When it is not proved, the guard stays and is itself the
defined behavior (tier 3), so it cannot fail `yo verify`, it does not count
toward `outcome`, and it does not count toward `vacuous`, which keeps the
`SELF_VERIFICATION` ratchet from inflating. A refuted elision-only
obligation is a real finding (this operation traps for these inputs). It is
counted in the summary and shown under `--explain`.

| Guard | Helper | Obligation (goal) | Kind | Phase |
| --- | --- | --- | --- | --- |
| fixed-array index read / write | `__yo_idx_chk` | `index-in-bounds`: `bvult i N` (exists) | correctness | 1 |
| int `/` `%` divisor | `__yo_div_guard[_u]` | `divisor-nonzero`: `b ≠ 0` (exists) | correctness | 1 (unsigned only) |
| signed `/` `%` `MIN / -1` | `__yo_div_guard` | `div-no-overflow`: `¬(a = MIN ∧ b = -1)` | elision-only | 2 (signed `/` elides only if both obligations prove) |
| shift count | `__yo_sh_chk` | `shift-in-width`: `bvult s bits(lhs)` (exists) | correctness | 1 |
| `+` `-` `*` (signed and unsigned) | `__yo_{add,sub,mul}_chk_*` | `no-overflow`: the exact result fits, encoded by widening (`sign_extend`/`zero_extend` by 1 bit for `+ -`, to 2w for `*`) and comparing to the truncated result | elision-only | 2 |
| unary `-` | `__yo_neg_chk_*` | `neg-no-overflow`: `a ≠ MIN` | elision-only | 2 |

The overflow goals use widening rather than SMT-LIB 2.7's `bvsaddo`-family
predicates. Widening is obviously right, and it does not depend on which
predicates the pinned Z3 accepts *(reasoned)*.

Phase 1 must pin two site details with an emission-trace test. First, the
index-**write** obligation in `_begin_term` must key the LHS index node
(`xs(i)`), not the assignment, because that node is where the store guard
is emitted. Second, the three existing obligations' nodes must match the
emitters' `expr` (§2.8).

## 7. Landing order and gates

Each phase is its own PR. Every phase runs the standard battery
(SAFE_MODE §10) plus its own gate.

**Phase 0: verifier prerequisites (removes no guard).** *Status 2026-09-29:
landed in two PRs: #983 (the two solver defects and the §2.7 fix) and the
Phase 0 PR (sites, unique names, target widths, the cache key + epoch).
Measured: no duplicate obligation name over `tests/spec/fixtures/valid` (124
obligations, 35 sited) or the three spec test files, and every verify outcome
is unchanged.*

- `VcObligation.site : Option(GuardSite)`, unique obligation names, and
  `site` in JSON (§4.2).
- Target-aware `usize`/`isize` widths.
- `_cache_store` keyed by the run's `cfg`, and `VERIFIER_CACHE_EPOCH`.
- The two solver-resolution defects from §2.4: the missing-solver rule
  becomes mode-aware, and a dangling `YO_Z3_PATH` becomes `InvalidPath`.
- The §2.7 fix. Recommended: `verify` mode keeps `requires` entry asserts.
  5b does not depend on which fix is chosen: until one lands, rule 3
  classifies verify-mode `requires` as unenforced.

Gate: `tests/internal/verifier*.test.yo` green, one file at a time;
`yo verify ./tests/spec --format json` has no duplicate obligation names; a
wasm32 probe emits 32-bit `usize` goals; a regression test that a
`--rlimit` run does not change a default run's verdict; the three issues'
cli-cases.

**Phase 1: the channel. Index, unsigned div/rem and shift elision in the
entry file.** *Status 2026-09-29: implemented on `verify/5b-phase1`.
Measured with the pinned Z3: the oracle passes over the 10 elision
fixtures and the 42 valid ones. The elision fixtures elide 1, 1, 1 and 2
guards (unsigned `/`, index read, shift, and a loop's index read + write),
and 0 in every twin that must keep its guard: signed `/`, a ghost-fn
`requires`, a `refine` premise, a callee's `ensures`, a generic body, an
outside-subset function. The valid fixtures elide nothing, because most
have no `main`, so codegen never emits their bodies; they check soundness,
not firing. Rule 2's `unproven` case has no fixture: `verify+` still makes a
refutation a compile error, so only a solver timeout reaches it, and the
`outcome == "ok"` check in `record_elidable_guard_sites` is its gate.
Deviation from the table below: every callee `ensures` counts as unenforced,
even one proved in this compile (conservative; lifting it is Phase 3's).*

- Assumption provenance, the filter, `g_proved_guard_sites`,
  `guard_site_is_proved` in the five emitters, `--no-guard-elision`, and the
  `N guard(s) elided` report line.

Gate: the emission-trace identity test (§6); the C-diff oracle over
`tests/spec/fixtures/valid/`; every §5.3 twin case; the self-emit sha256
unchanged; the microbenchmark numbers recorded in the PR.

**Phase 2: elision-only obligations** (`div-no-overflow`, `no-overflow`,
`neg-no-overflow`) and the correctness / elision-only split in reports.
*Status 2026-09-29: implemented on `verify/5b-phase2`, stacked on Phase 1.
Measured, with the pinned Z3, over the pre-#989 base:*
- *The 25% rule fired. With the elision-only obligations on, the
  straight-line battery goes from 13 to 21 queries (+62%) and the 42 valid
  fixtures from 100 to 227 (+127%). `std/spec` and `std/collections` issue
  0 queries either way: all their functions are `assumed` or outside the
  subset. So they are generated only when a run asks: `yo compile`
  whenever it records guard sites, and `yo verify` under a new
  `--elision` flag, which the oracle uses. They are not generated under
  `--explain` or strict mode, as this section first proposed: the oracle
  needs them in a machine-readable report, and strict mode must not
  change what it proves. Without the flag the report is byte-identical to
  Phase 1's over `tests/spec` and `std/collections`.*
- *Oracle: 57/57. It now parses helper calls with balanced parentheses,
  so nested guards (`(a * b) + c`) are each found, and a signed division
  needs both proofs. The fixtures elide: signed `/` 1, nested `*`+`+` 2,
  negation 1. An unbounded `u8` `+` keeps its guard (its elision-only
  refutation leaves the compile and the outcome alone).*
- *Two older bugs surfaced. The literal folder aborted `yo verify` on a
  zero subtrahend or negand; fixed here
  (`issues/fixed/verifier-literal-fold-traps-on-wrapping-arithmetic.md`).
  A 64-bit `usize` `+ - *` has no overflow guard at all; filed, not fixed
  (`issues/fixed/usize-arithmetic-is-unguarded-on-64-bit-targets.md`). Elision
  now fires only in the branches that emit a guard, so an unguarded
  operation is never counted.*

Gate: the C-diff oracle extended to the arithmetic helpers; `yo verify` exit
status unchanged over `./tests/spec` and `std/collections/*.yo`, so no
verified file flips; the FV CI job's wall time and query count recorded
before and after. If the job grows more than 25%, generate elision-only
obligations only inside `yo compile`, and have `yo verify` generate them
only under `--explain` or strict mode.

**Phase 3: imported verified modules.** *Status 2026-10-01: not started, and
measured as having nothing to elide yet. After #1048/#1057 (ArrayList as a
ghost (contents, len) pair), `yo verify ./std/collections` gives 9 `assumed`,
3 outside-subset and 1 vacuous `ok`, with 0 sited obligations. The list-length
proofs live in the test fixtures; std's own bodies are still `assumed()`. Two
things must land first: std bodies that are walked, not assumed, and an
elision hook for ArrayList's own bounds check. `xs(i)` on an ArrayList traps
inside std, not through `__yo_idx_chk`, so today's emitters never see it.*

- In `yo compile`, every module in the import closure that carries
  `Pragma.Verify` / `Pragma.VerifyOrAssert` becomes an *elision target*. Its
  contract semantics stay runtime (asserts spliced, never a compile
  failure), and its AoRTE obligations are walked and proved only when a
  solver resolves.

This keeps §2.4's property that importing `std/collections` never needs Z3.

Gate: a cold-cache and a warm-cache compile of a program importing
`std/collections/array_list.yo`, wall time recorded, with the warm-cache
overhead under 5% of the compile; the C-diff oracle over that program;
without a solver, C byte-identical to `--no-guard-elision`.

## 8. How Phase 6 (strict mode) sits on top

Strict mode (`SAFE_MODE.md` §9) is this plan's output with a different
consumer. Where a guard would be emitted at an unproved site, strict mode
reports a compile error naming the site and the remedy. Concretely:

- The census is the list of guard sites in a strict file. A site the
  verifier never modeled has no `GuardSite` (a runtime `str.bytes`, an index
  through a non-name receiver like `self.buf(i)`, an outside-subset body).
  Codegen already visits every guard site in `guard_site_is_proved`, so in
  strict mode a miss there is the error. That catches unmodeled sites as
  well as unproven ones.
- Elision-only obligations become errors under strict mode, which is why
  they are a separate kind.
- `assumed()` and the provenance rule carry over unchanged. In strict mode,
  a site proved only on an unenforced assumption is an error that says
  which assumption.

Strict mode stays out of the default forever (§0, §9 of SAFE_MODE).

## 9. Risks

- **Emitter/verifier node identity** (§2.8) is inferred from a measured
  location, not from reading the inline-builtin substitution path. If the
  emitter sees a different node, Phase 1 elides nothing. That fails safe,
  and the trace test catches it.
- **Query volume.** Phase 2 adds one query per arithmetic operation in
  verified bodies, and `run_vc_query` spawns one Z3 process per obligation.
  Phase 2's gate measures the cost, and its fallback keeps `yo verify` cheap.
- **Platform-dependent rlimit accounting.** A query near the budget could
  prove on arm64 and not on x86_64, giving C that differs by platform.
  Behavior is identical, because a proved site cannot trap. Only
  cross-platform C byte-identity would notice, and no gate compares across
  platforms. Accepted.
- **The provenance rule may be too conservative** for the flagship
  refinement example (`worked_example_array_index.yo`: the index proof
  rests on a `refine` parameter, so its guard stays). The fix is making
  refinements enforceable at entry, the same decision as the §2.7 issue,
  not relaxing the rule.
- **Contract-splice clones miss.** A guard inside a spliced `requires`
  predicate (verify+) is a fresh-id clone, so it is never elided.
  Correct, and cheap.
- **Documentation drift found while writing this plan** (for the owners):
  - `plans/backlog/FORMAL_VERIFICATION.md` §"Integer semantics" and D6
    still say wrapping is defined semantics; the user doc was fixed under R4.
  - The same plan says the pass runs "when any file in the import closure"
    is verify-mode; the code arms only the entry file.
  - It also claims target-derived widths; the code hard-codes 64 (§2.5).
  - SAFE_MODE §8 says `yo check` "skips-without-hint"; it prints the install
    hint.
