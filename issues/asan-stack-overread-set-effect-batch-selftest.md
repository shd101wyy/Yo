# ASan stack-buffer-overflow in set_effect's bundle copy — develop CI red since #363 (blocks the v0.2.21 release gate); ANOTHER SYMPTOM of C54's specialization split

**Status: ROOT-CAUSED 2026-08-30 (CI sweep repro). This is the C54 mechanism
clobbering a future's EFFECT type across specializations — see
issues/future-wrapper-return-shared-across-specializations.md for the arc and
its recorded failed approaches. A codegen-side mitigation was attempted and is
NOT viable (below); the fix is the C54 body half.**

`test (ubuntu-latest)`, `test (ubuntu-24.04-arm)`, `test (macos-latest)`,
`test (macos-26-intel)`, "Self-hosted `test` subcommand", and the
"Full-corpus hollow sweep" all failed the SAME single test of
`tests/async_await.test.yo`:

```
✗ a top-level await returns as soon as its future completes, despite unrelated pending I/O
  ==ERROR: AddressSanitizer: stack-buffer-overflow ... READ of size 40
      #1 _file____priv_temp_14412_set_effect
      #2 _file____priv_temp_14417_resume
  [32, 64) '__yo_eff_bundle_yo_id_15516' <== Memory access ... overflows this variable
```

## Root cause (isolated by a CI index sweep over the ASan-compiled batch)

Reproduced with a temporary ubuntu workflow (`debug/asan-batch` branch, since
deleted): the test file's second batch, cross-emitted to Linux C and compiled
with `-fsanitize=address`, crashes at exactly **test index 85** — the failing
test itself. The emitted C at the fault:

```c
// _file____priv_temp_14417_resume, line ~56298 (the await site):
__yo_t14 __yo_eff_bundle_yo_id_15516 = sm->__yo_param_0;   // t14 = Io, 32 bytes
sm->var_206481->__yo_set_effect_fn(..., "__bundle", (void*)&__yo_eff_bundle_yo_id_15516);

// _file____priv_temp_14412_set_effect (the child future):
sm->__yo_param_0 = *((__yo_t41*)value);                    // t41 = IoExn, 40 bytes
```

`IoExn` is `{ io : Io, exn }` — it CONTAINS the 32-byte `Io` inline plus the
8-byte `exn` (40 total). The C60/#354-era `emit_effect_injection_for_sm`
materialized the bundle temp **in the ARG's recorded type** (`Io`, 32 bytes —
the pre-#366 shape), while the awaited future's `set_effect` copies its OWN
declared effect record (`IoExn`, 40 bytes) — an 8-byte stack over-read. The
test passes unsanitized because the child never reads the injected bundle.

WHY an `Io`-bundled await meets a future whose emitted SM carries an `IoExn`
bundle at all: see "The real mechanism" below — a cross-specialization
effect-binding split, not a property of any single await expression.

## The mitigation attempt (NOT viable — recorded so it is not retried)

`emit_effect_injection_for_sm` / `emit_effect_injection_for_await` were taught
to size the `__bundle` temp by the FUTURE's declared effect type (zeroed temp +
name-shared field copies when the arg's C type differs). Built, re-emitted the
batch, swept on CI: **the crash site's emission was byte-identical** — because
at the await site the future's effect type RESOLVES TO `Io` (equal to the
arg's — the emitter's own view is self-consistent and takes the direct-init
path), while the CHILD's `set_effect` was EMITTED ELSEWHERE under `IoExn`.
Neither side can see the other's type, so no emission-site check can catch
this. Reverted.

## The real mechanism (why the two views differ)

The batch compiles many `two_hop`-shaped call sites; the same nested
`io.async` closure gets SPECIALIZED more than once, and the second
specialization's effect-bundle binding (C60's receiver-derived `E`) leaks into
the first's emitted state machine through the shared/global specialization
registry — the exact "second specialization clobbers the first via the global
last-writer registry" mechanism of C54, on the effect type instead of the
result type. Standalone compiles of the same file type the future `Io` and are
clean; only the multi-specialization batch context splits the views.

**Fix**: the C54 body half (stamp the call's types concretely inside the
specialization body / stop keying the fallback by the shared forall id) — see
issues/future-wrapper-return-shared-across-specializations.md (C54) and its repro
issues/repros/future-wrapper-return-two-r-specializations.yo. Until then,
every PR's native test legs stay red on this one test.

## Repro assets

The `debug/asan-batch` branch (temporary — delete when done) carries the
workflow + the offending pre-emitted `tests/debug-batch-linux.c`: crash at
batch test index 85 (`a top-level await returns as soon as its future
completes...`), `_14417_resume` line ~56298 → `_14412_set_effect` line ~8662
(t14 = `Io` 32-byte temp, t41 = `IoExn` 40-byte copy).

## Follow-ups

- A SILENT local ASan skip cost a day of repro attempts: the runner prints
  "AddressSanitizer is not functional..." and continues unsanitized on this
  macOS host (Apple clang 17's ASan runtime hangs under this environment).
  A `--sanitize-required` mode (or a loud summary line) would have caught it.
- The temporary debug workflow + committed batch C on `debug/asan-batch`
  should be deleted once the mitigation is merged.
