# yo-self `test` subcommand: codegen divergences vs the TS compiler (OPEN)

Found by the first-ever per-file differential of the **`test` subcommand** across
both compilers (`TS test <file> --parallel 1` vs `<self-hosted-bin> test <file>`),
comparing `N passed / M total` + exit code.

## Scorecard

| directory          | files | PASS    | non-PASS                                                        |
| ------------------ | ----- | ------- | --------------------------------------------------------------- |
| `./tests`          | 186   | **186** | none — 2,644 individual tests, DIFF 0 / SELF-FAIL 0 / TS-FAIL 0 |
| `./tests/internal` | 61    | **57**  | 1 SELF-FAIL (`effect_analysis`), 3 SKIPPED (`eval_*` trio)      |

242 of 247 runnable files agree between the two compilers. `./tests` is fully clean:
the self-hosted `test` subcommand is behaviourally equivalent to TypeScript's across
the whole integration suite.

The 3 SKIPPED files are **uncovered, not passing** — `eval_basics`, `eval_tail_1` and
`eval_tail_2` exceed the runner's process limit and were never executed. They do now
`check` clean, after the fix in
`issues/fixed/yo-self-evalresult-value-cell-confusion.md` took `check ./yo-self` to 305/305.

`effect_analysis` below is therefore the ONLY real divergence in either directory.

## SELF-FAIL 1: `tests/internal/effect_analysis.test.yo`

```
ts=19/19 (rc0)     self=?/? (rc1)
```

TS passes all 19. The self-hosted binary **emits C that clang rejects** —
20 errors, `121 warnings and 20 errors generated`, then
`yo-self: error: compile: C compiler failed (exit 256) on
./tests/internal/.yo_selftest_batch_1.bin.c`. Full log preserved at
`/tmp/re/BUG_effect_analysis.log`.

### The error signature

```
15912  error: expected expression
15945  error: use of undeclared identifier '_file____User_temp_496914'; did you mean '_file____User_temp_496912'?
16014  error: expected expression
16080  error: 'case' statement not in switch statement
16182  error: expected expression
16215  error: use of undeclared identifier '_file____User_temp_496973'
16219  error: assigning to '__yo_t9' (aka 'struct __yo_t10_struct') from incompatible type 'int'
16223  error: initializing 'bool' with an expression of incompatible type '__yo_t9'
16288  error: use of undeclared identifier 'func_type_opt'
16336  error: member reference base type 'size_t' ... is not a structure or union
```

`expected expression` + `'case' statement not in switch statement` + a temp that is
USED but never DECLARED is the signature of **a `match` that had to be lowered as a
STATEMENT being emitted in an EXPRESSION position**: the `switch` is emitted, its
`case`s end up outside any switch, and the result temp is referenced without ever
having been declared or assigned.

The desync is visible in the numbering — used vs declared:
`496914` vs `496912`, `496962` vs `496944`, `496973` vs `496953`.

And one declared temp has the wrong TYPE for its use:

```c
size_t _file____User_temp_496944 = yo_id_3128_..._ret_usize(fp);   // declared: size_t
switch ((_file____User_temp_496962).tag) { ... }                    // used as an Option enum
__yo_decr_rc((void*)((_file____User_temp_496962).data.Some.value));
```

### The two triggering constructs

Both are in `yo-self/evaluator/effects/effect_analysis.yo`, and `func_type_opt`
(`:135`) appears verbatim in the C as an undeclared identifier.

1. **`match` in a binding initializer where one arm does not produce a value**
   (`:125-131`) — the `.FnCall` arm is `return(false)`:

   ```rust
   func_name := match(
     func_expr.clone(),
     .Atom(_, tok) => tok.value,
     .FnCall(_, _, _, _, _) => { return(false); }
   );
   ```

2. **bool-valued `match` whose arm is a call** (`:142-146`, and again `:152-156`) —
   the shape already recorded as miscompiling self-hosted in
   `yo-self-memory-campaign-r3-r5` ("statement-arm shape required"):

   ```rust
   ok := match(
     func_type_opt,
     .Some(ty) => is_function_type(ty),
     .None => false
   );
   ```

   The `assigning to '__yo_t9' from incompatible type 'int'` and
   `initializing 'bool' with ... '__yo_t9'` pair is exactly this: the result temp
   got the enum's struct type where a `bool` was wanted.

### ROOT CAUSE (MEASURED, supersedes the two hypotheses below)

Both hypotheses recorded further down are **WRONG**, and the artifact refuted them.
The temps clang calls "undeclared" ARE declared — `_file____User_temp_496914` is
declared on the very next line. Every error is a CASCADE from one line:

```c
if (// Failed to transpile !(allow_missing_type)) {
```

An FTT comment emitted **inline in an `if` condition**. `//` swallows the closing `)`
and the `{`, so the parse is wrecked: hence "expected expression", the orphaned
`case`, and the phantom undeclared identifiers. All 6 markers in the file are the
same expression. This is the FTT-cascade class
(`issues/yo-self-failed-transpile-cascade-fix.md`), not a temp desync.

**The exact failure point**, from an instrumented stage-1 build that gave each FTT
origin a distinct marker: **`FTT_OFC_1612`** —
`yo-self/codegen/exprs/other_fn_call.yo:1612`:

```rust
(runtime_args : ArrayList(AstExpr)) = match(
  ei.runtime_arg_exprs_in_order,
  .Some(ra) => ra,
  .None => return(Option(String).None)     // <-- taken
);
```

So `runtime_arg_exprs_in_order` is `.None` on the `!` call's `ExprInfo`, the dispatcher
returns `.None`, and `generate_func_call` (`generation.yo:583`) emits the FTT text.
That field is exactly the one the `begin` shared-id clobber drops and that
`carry_runtime_args` (`begin.yo:2280`) exists to conditionally restore.

### The trigger is a THREE-WAY CONJUNCTION

Isolated with a standalone reproducer (top-level fns, so nothing else interferes).
Drop any one factor and the same expression compiles:

| case   | construct                      | closure-spec? | result  |
| ------ | ------------------------------ | ------------- | ------- |
| c1     | `!(b)` on param                | no            | OK      |
| c2     | `!(ok)` on local               | no            | OK      |
| **c3** | `!(b)` on **param**            | **yes**       | **FTT** |
| c4     | plain `b` read                 | yes           | OK      |
| c5     | `(b == false)` infix on param  | yes           | OK      |
| c6     | `!(ok)` on **local**           | yes           | OK      |
| c7     | `((0 - n) > 0)` infix on param | yes           | OK      |

i.e. **a unary trait-dispatched operator, applied directly to a PARAMETER, inside a
CLOSURE-SPECIALIZED function.** Primitive INFIX operators escape because
`_is_primitive_infix_operator` (`generation.yo:571-577`) short-circuits them to the
inline path _before_ the failing dispatcher; unary operators have no such path.

**Do NOT "fix" this by adding a unary inline fast path.** TypeScript — the ground
truth — resolves the `not` trait method and calls it:

```c
bool _yo..._temp_40796 = fn_yo1c2129e9_id_2433_not_bool_idbool_rtparam0_bool_idbool((bool)(b));
```

which is the same shape yo-self already emits for a LOCAL receiver
(`yo_id_117_bool_id_bool_rtparam0_bool_ret_bool((bool)(ok))`). The dispatcher is
supposed to work here; the fix is to populate `runtime_arg_exprs_in_order` for this
node, not to route around it.

Regression coverage: `tests/closure_param_unary_operator.test.yo` — 6 tests covering
the full matrix above. Verified **TS 6/6 pass, self-hosted rc=1 with 10 FTT markers
and 21 clang errors**, i.e. it fails before the fix as a regression test must.

### SUPERSEDED HYPOTHESIS: the known-OPEN shared-id clobber

`issues/yo-self-begin-shared-id-clobber.md` already documents the mechanism, and its
own affected-expression table lists **`effect_analysis` | "bare effectful call as arm
body"** (line 131) as a still-latent instance. This is that instance firing.

`evaluate_begin_expression` (`begin.yo:1348-1357`) treats a non-`begin` expression as
a one-element begin block by pushing **the same node** into a 1-element list, so
`ast_expr_id(last_expr) == ast_expr_id(expr)`. A fresh
`out_info := new_expr_info(...)` is then stored on that shared id (`begin.yo:2135`,
`:2197`), overwriting whatever the inner expression's own evaluator path recorded —
everything except a hand-picked carry whitelist.

Both failing constructs here are **bare (unbraced) arm bodies**, exactly the category
that hits it:

- `.Atom(_, tok) => tok.value`
- `.Some(ty) => is_function_type(ty)` — a bare runtime CALL as an arm body

And critically, `variable_name` — the temp name TS attaches to every runtime call
result (`attachTempVariableToExpr`, `function.ts:2263`; see
`issues/fixed/yo-self-io-async-missing-temp-comptime-io-callee.md`) — is **deliberately NOT
carried**, because "aliasing the inner temp name pollutes downstream type names"
(the warning at `begin.yo:2165`, restated in that issue's proposed-fix section). So
the inner expression's temp identity is destroyed by design, and codegen ends up
declaring under one counter value and referencing another — which is exactly the
`496944` vs `496962` skew, and also why one temp is declared `size_t` while its use
wants an `Option` enum (the inner expression's TYPE went with the clobbered info).

TS has no such problem: `evaluateBeginExpression` (`begin.ts:1027-1046`) synthesises a
real begin node with `args: [cloneExpr(expr)]`, so the begin node and the inner node
are distinct objects and `expr.$` / `arg.$` never collide.

The documented durable fix is to **invert the merge**: start from `last_info` and
apply begin-level overrides, explicitly clearing only the fields the begin level must
own — making preservation the default and loss the explicit choice, which is what
TS's node cloning achieves structurally. That issue notes it is behaviour-visible and
needs a full TIER 2 pass. A narrower alternative is to add a conditional carry for
the temp identity, but note several existing carries had to be **conditionally gated**
(`carry_runtime_args`) because an unconditional carry regressed
`match_arm_folded_fncall` and `runtime_enum_construct`.

### A guard for this exact error ALREADY EXISTS — so the fix is a gap, not new machinery

This matters for scoping the work: the issue file's proposed TIER-2 "invert the merge"
refactor may not even be the right lever.

`codegen/utils/index.yo:213` declares `declared_c_var_names : HashSet(String)` whose
stated purpose is to "skip a drop whose target TEMP was never materialized
(declaration elided while its deferred-drop survived) — **emitting
`__yo_decr_rc(undeclared_temp)` is an undeclared-identifier error**". A second,
block-scope-aware signal `declared_scopes` exists alongside it because the flat set is
monotonic and would wrongly keep a name alive from an already-closed sibling block.

The most developed consumer is `codegen/exprs/atom.yo:359-386`, and its comment names
our exact failure class: "the stage-2 self-emit `fp`/`res`/`gt` clang-error class" —
and the C that fails here contains `..._ret_usize(fp)`.

**The gap**: that gate keys off the drop target's NAME —

```rust
skip := match(
  get_deferred_drop_target_atom_name(drop_expr),
  .Some(var_name) => { /* scope_stack_contains(...) + env-liveness */ },
  .None => false            // <-- atom.yo:385
);
if(!(skip), { /* emit the drop */ });
```

and `get_deferred_drop_target_atom_name` (`utils/index.yo:1275`) only recognises two
shapes — `varName.___drop()` and `___drop(varName)` — returning `.None` for anything
else. On `.None` the gate defaults to **emit**, so any deferred drop whose target is
not a plain `Atom` bypasses the scope check entirely.

Also note `attach_temp_variable_to_expr` (`evaluator/utils.yo:206`) mints a FRESH temp
via `generate_new_temp_variable_name` whenever `info.variable_name` is `.None`. That is
the mechanism that produces two names for one expression — and it means the durable fix
proposed in `yo-self-begin-shared-id-clobber.md`, which explicitly CLEARS
`variable_name` on the shared-id path, **would not fix this case**. Worth resolving
before anyone invests in that refactor.

### Mechanism hypothesis (NOT yet verified against the artifact)

Narrower than "the info was clobbered": the temp used by the DROP and the temp
declared by the VALUE emission come from two different `ExprInfo`s.

- `begin.yo:2199` and `:2207` schedule the dup/drop work against
  **`last_info.variable_name`** — the INNER expression's temp:
  ```rust
  _schedule_scope_end_drops(fr, begin_args, last_info.variable_name, last_expr, env, ctx, exn)
  ```
- `begin.yo:2247` then creates a **fresh** `out_info := new_expr_info(env, return_type)`
  with its own `variable_name`, and stores it on the shared id. Codegen declares the
  temp from THAT.

So the drop refers to `..._496962` (from `last_info`) while the declaration is emitted
as `..._496944` (from `out_info`) — matching the observed skew, and matching the
`size_t` vs `Option`-enum type mismatch, since the two infos also disagree on `ty`.

The `expected expression` + `'case' statement not in switch statement` errors suggest
a second, compounding failure: the match was emitted in statement form (a `switch`)
where the context wanted an expression, so temps declared inside the switch body are
out of scope at the point the drops are emitted.

Two candidate fixes, both needing the artifact first:

1. carry the temp identity on the shared-id path (`out_info.variable_name =
last_info.variable_name`) — but `begin.yo:2278` explicitly warns this "would
   pollute downstream type names", so it needs the same conditional gating as
   `carry_runtime_args`;
2. schedule the drops against the final `out_info.variable_name` instead — complicated
   by ordering, since the drops are scheduled at `:2207`, before `out_info` exists at
   `:2247`.

Note the two paths at `begin.yo:1674-1678` and `:1848-1852` (return / unwind) DO carry
`variable_name` across (`out.variable_name = ret_info.variable_name`), so carrying it
is not unprecedented — those paths establish the pattern.

**Verify before fixing** by regenerating the batch C and locating both the declaration
and the use of the two temp ids:

```bash
rm -f tests/internal/.yo_selftest_batch_*
YO_MAIN_STACK_MB=4096 /tmp/re/s1r16 test ./tests/internal/effect_analysis.test.yo \
  &> /tmp/re/effan.log
grep -n "496944\|496962" tests/internal/.yo_selftest_batch_1.bin.c | head -20
```

### Why the stage-2/stage-3 FIXPOINT still holds

`effect_analysis.yo` **is** part of the compiler build, and `compile yo-self/main.yo`
emits 101 MB of C that clang accepts, with the fixpoint byte-identical. So this is
**specialization-dependent**: the test file imports `effect_analysis.yo` and calls
into it directly, requesting a specialization that `main.yo` never requests. The
fixpoint gate cannot see it — which is precisely why this differential is worth
having in CI.

## Why this was never caught

Both existing gates miss it:

- `check ./yo-self` type-checks but never emits C.
- the corpus diff-test (`scripts/diff-test.sh tests/codegen-bootstrap`, 155 files)
  covers small hand-written files, not the compiler's own sources.
- the 20-file battery in `gates_fast.sh` runs `./tests` files, which are now proven
  clean (186/186).

Nobody had run the self-hosted binary's `test` subcommand over `tests/internal`
before. That is the gap this differential closes.

## Reproducing

```bash
# per-file differential, strictly sequential (see the harness note below)
DIR=./tests/internal TAG=ystests TO=1500 BIN=/tmp/re/s1r16 \
  SKIP="eval_basics eval_tail_1 eval_tail_2" bash <scratch>/difftest_dir.sh

# single file, keeping the batch C for inspection
rm -f tests/internal/.yo_selftest_batch_*
YO_MAIN_STACK_MB=4096 /tmp/re/s1r16 test ./tests/internal/effect_analysis.test.yo
# the rejected C is left at ./tests/internal/.yo_selftest_batch_1.bin.c
```

**Run strictly one file and one compiler at a time.** `macro_expansion` alone needs
6.52 GB; two concurrent children on a 16 GB machine swap, and the swapping trips the
runner's 600 s evaluator deadline, MANUFACTURING failures that do not reproduce in
isolation. An earlier `--parallel 2` sweep produced several such phantom failures.

## Next steps

1. Finish the sweep and group all SELF-FAILs by root cause — the two constructs above
   are generic enough that other files likely share them.
2. Build a minimal reproducer per construct (a `.yo` file with `main`, not a
   `.test.yo` — `yo-cli compile` cannot be used on `*.test.yo`).
3. Fix in `yo-self/codegen/`, verify the repro, then re-run this differential.
4. Add the repros to `tests/` and wire the `tests/internal` differential into CI
   alongside the existing `bootstrap-self-test` job.
