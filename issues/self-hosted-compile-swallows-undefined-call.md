# Self-hosted `compile` builds a runnable no-op binary from an undefined call

**Status: OPEN** (found 2026-08-10 while building the `build-fail`
differential case). The known def-time body-eval swallow
(`yo-self check masks porting gaps` in the memory/plan lore) is worse than
documented: it affects **`compile`**, not just `check`.

## Symptom

```rust
main :: (fn(io : Io) -> unit)({
  this_function_does_not_exist();
});
export(main);
```

```
$ node out/cjs/yo-cli.cjs compile main.yo      # TS reference
Error: Variable "this_function_does_not_exist" not found.   (rc=1)

$ /tmp/yo-s27 compile main.yo -o probe          # self-hosted
(no output)                                     (rc=0)
$ ./probe; echo $?
0
```

The self-hosted compiler exits 0, emits a 34 KB binary, and the binary runs
and does nothing. No diagnostic anywhere. A typo'd call in `main` becomes a
silent no-op program.

## Root cause (as far as established)

The self-hosted evaluator's def-time function-body evaluation swallows
errors (the trial-eval swallow — see
`issues/…` history and the memory notes `yo-self-defeval-swallow-masks-typeerrors`
/ `yo-self-test-trial-eval-swallow`). `main` is only body-evaluated at
definition time; the undefined-variable error is caught and discarded, the
FuncVal is registered anyway, and codegen emits the body minus the broken
call.

## Why it matters / what blocks on it

- `tests/cli-cases/build-fail` had to use a MISSING-IMPORT fixture instead of
  a semantic error, because a semantic error does not fail the self side.
- Any P2.5 world where the self-hosted binary is the only compiler makes this
  the user-facing behavior: typos compile clean.

Fixing it means revisiting the def-eval swallow with `is_executing` set for
the ENTRY module's exported roots — the historically hard part is that
def-eval must stay lenient for generic bodies that only type-check after
specialization. Needs its own campaign; do not quick-patch.

## 2026-08-10 — two more gates masked by the same swallow (P2.4 probe)

Porting `src/tests/unsafe-gate.test.ts` surfaced the same mechanism from a
different angle. In a file OUTSIDE the implicit-unsafe dirs, with no
`pragma(Pragma.AllowUnsafe)`:

| program (in `main`'s body)          | TS   | self-hosted    |
| ----------------------------------- | ---- | -------------- |
| `p := &(x);`                        | rc=1 | **rc=0** (gap) |
| `v := unsafe(i32(0));`              | rc=1 | **rc=0** (gap) |
| `foo :: (fn(p : *(i32)) -> i32)...` | rc=1 | rc=1           |

Both gates EXIST in yo-self (`evaluate_unsafe`'s privilege check in
`evaluator/builtins/unsafe.yo`; the `&(...)` structural gate) — they fire
inside function BODIES, so the def-time body-eval swallow eats the throw and
`compile` proceeds. The `*(i32)` case fires because the SIGNATURE is
evaluated eagerly (`function.yo:1469`), outside the swallow.

Consequence for P2.4: the unsafe-gate negative cli-cases (`&(x)` and bare
`unsafe(...)`) cannot pass until this issue is fixed — they would score
SELF-FAIL (TS rc=1, self rc=0). Do NOT add them to `tests/cli-cases/` before
then; the positive case (`unsafe-pragma-ok`) and the signature-level gate
case (`ptr-type-safe-code`) pass today and are added.

## 2026-08-12 — SIZED. The machinery already exists; here is a safe first slice

This was filed as "needs its own campaign; do not quick-patch", which was
right but left the campaign unbounded. It is now measured.

### The mechanism, exactly

`_trial_eval_fn_body` (`yo-self/evaluator/calls/function_type.yo:243`) wraps the
def-time body evaluation in a **capture-free swallowing handler** that unwinds
`()` on ANY error. TS's counterpart (`function-type.ts:499`) is fatal — the
comment at the yo-self site says it is that call "made non-fatal".

### The strict mode is already built

`set_propagate_def_time_errors(bool)` /
`propagate_def_time_errors()` (`yo-self/types/flowability.yo:104-135`) already
make def-time body-eval errors propagate instead of being swallowed. It is
currently switched on only around a `comptime_expect_error` argument eval.

So no new machinery is needed. The reason it is off by default is stated in
that file:

> the def-eval wall: it masks yo-self's own porting-gap false-positives so
> `check` stays green

i.e. the blocker was never "how", it was that nobody had measured how much of
the swallow is real errors versus yo-self's own false positives.

### The measurement (free, via YO_DEBUG_SWALLOW)

```bash
YO_DEBUG_SWALLOW=1 <yo> check ./std   2>&1 | grep -c '^\[swallow\]'
YO_DEBUG_SWALLOW=1 YO_MAIN_STACK_MB=4096 <yo> check ./yo-self 2>&1 | grep -c '^\[swallow\]'
```

| corpus      | files     | swallowed errors | of which "Variable X not found" | **non-generic (i.e. real)** |
| ----------- | --------- | ---------------- | ------------------------------- | --------------------------- |
| `./std`     | —         | 236              | 48                              | **0**                       |
| `./yo-self` | 247/247 ✓ | 54               | 17                              | **0**                       |

**Every single undefined-variable swallow in both corpora is a single
uppercase letter** — `B`, `F`, `V`, `E`, `U`, `N`, `J` — i.e. an as-yet-unbound
GENERIC TYPE PARAMETER. Not one is a real typo. That is exactly the leniency
the original note said must be preserved ("def-eval must stay lenient for
generic bodies that only type-check after specialization"), and it is cleanly
separable from the bug this issue is about.

The remaining ~220 are type-level: "Cannot unify incompatible types",
"Expected enum type … got unit", "Type mismatch for type member". Those are the
genuinely hard specialization cases and stay lenient.

### The first slice

> **Make an undefined variable fatal at def time when it is not an unbound
> generic parameter.**

- Catches this issue's symptom (`this_function_does_not_exist()` → silent
  no-op binary), because a typo'd call is never a single-letter type param.
- Unblocks the two `unsafe-gate` negative cases parked in P2.4 (they are
  undefined-name/gate rejections, not type-unification ones).
- Unblocks P4's slice 0 for the same reason — see `plans/P4_LSP.md`.
- **Measured zero false positives** across std AND yo-self, the two corpora
  whose green `check` the swallow exists to protect.

Implementation shape: at the swallow site, classify the error before unwinding.
If it is an undefined-variable error whose name is not a generic parameter in
scope, set a "hard error pending" flag and let the def-time caller re-raise it
through the real `exn` — precisely the pattern `flow_violation_pending()`
already uses a few lines above (`function_type.yo:1015`, `:1196`).

Not yet measured: the `tests/` corpus. Expect noise there from files that
deliberately contain errors, though those already run under
`comptime_expect_error`'s propagate mode. Measure before flipping anything on.

### Why this is not "just fix it"

The slice above is safe; the FULL strict mode is not. Turning propagation on
for all error classes surfaces those ~220 type-level false positives, each of
which is a separate yo-self porting gap. That is the real campaign, and it
should be run gap-by-gap with the counts above as its progress bar — not as a
single flip.
