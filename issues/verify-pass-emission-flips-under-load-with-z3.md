# With Z3 installed, emitted C flips between two modes under machine load (verify-pass timing)

> Found 2026-09-10 while gating the fixed-region allocator PR locally on
> Windows. PRE-EXISTING — reproducible shape is independent of that PR's
> tree; no CI leg covers the triggering combination.

## Symptom

`yo compile src/main.yo --optimize 2 --emit-c --skip-c-compiler` (no
`--no-verify`), run twice with the SAME binary and source, produced two
different C files while the machine was heavily loaded (a parallel clang/ASan
build + test suites). The differences are the same `__yo_tN` renumbering
churn as the std-path spelling issue: one type registration shifts, ~19k
lines renumber.

Bimodal, not chaotic: of 6 runs, 5 produced byte-identical output and 1
produced a second stable variant. On an idle machine, 3/3 runs were
byte-identical. With `--no-verify`, 3/3 runs byte-identical regardless of
load.

## Root cause (narrowed)

The contract-verification pass (`_run_contract_verification`, Z3 via
`src/verifier/z3.yo`) runs before codegen and rewrites verified function
bodies. With a solver present, something in that pass is sensitive to wall
time — a per-query timeout or a spawn/collect ordering — so under load a
query can land on the other side of a deadline, changing what gets spliced,
which changes downstream type registration order. The compiler's own
evaluation outside the verify pass is deterministic.

CI is unaffected today: the bootstrap/fixpoint jobs install no Z3, so the
pass skips entirely (`issues` in `test.yml`'s "Formal verification" job is
the only leg with a solver, and it does not run the fixpoint).

## Reproduction sketch

Windows box with the pinned Z3 discoverable (`discover_z3()` finds it via
`YO_Z3_PATH` or the solvers cache), heavy background load (e.g. a parallel
`clang -O2` of a 160 MB C file), then:

```bash
for i in 1 2 3 4; do
  yo compile src/main.yo --optimize 2 --emit-c --skip-c-compiler -o /tmp/f$i
done
md5sum /tmp/f*.c   # one of the four occasionally differs
```

## Fix direction

Make the verify pass's effect independent of solver timing: give every Z3
query a fixed, generous timeout and treat a timeout as "unverified" (skip the
splice) rather than letting a raced result through; or run the whole pass
behind a single deterministic gate (all-or-nothing). Until then, anyone
gating the fixpoint locally on a machine WITH Z3 should pass `--no-verify`
to both stages (CI's no-Z3 legs get that behaviour for free).
