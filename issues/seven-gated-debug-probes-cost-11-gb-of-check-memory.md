# Seven gated `YO_DEBUG_WARM` probes (#800) cost +11.6 GB / +180 s on `check src/main.yo` — the F8 compile-cost mechanism, measured again

**Status: FIXED 2026-09-20 (probes removed; the mechanism fixed in the same PR — the F8 issue).** The probes are removed in this branch (that
recovers the 11.6 GB); the mechanism — one template string with TEN
interpolations, evaluated at ~4× cost per nesting level — is recorded in
`issues/debug-probe-line-costs-gigabytes-at-compile-time.md`, which now has a
15-line standalone repro.

## Measurement

`yo check src/main.yo --std-path ./std`, release binary v0.2.38, quiet Mac
Mini M4 16 GB, one run per tree, `/usr/bin/time -l` peak footprint:

| tree                              | what it contains                              | footprint    | wall   |
| --------------------------------- | --------------------------------------------- | ------------ | ------ |
| `v0.2.37` tag                     |                                               | 19.35 GB     | 162 s  |
| `v0.2.38` tag (`40e6c5b9c`)       |                                               | 19.92 GB     | 170 s  |
| `24fcd192f` (#802, one past tag)  | derive swallow → check error                  | 19.90 GB     | 170 s  |
| `7eada73f8` (#800, tip)           | + seven gated debug probes                    | **31.55 GB** | **350 s** |

So the whole 19.9 → 31.5 GB step is #800's `src/` change: seven
`if(<env>.get(\`YO_DEBUG_WARM\`).is_some(), { … })` blocks (in
`_bind_some_type`, `_synthesize_types_impl` ×2, `_bind_forall_from_type_args`,
`register_some_resolved_concrete`, `_do_chain_resolve` ×2 + `_chain_resolve`)
plus the `_was_self_bound_frame` helper only one of them called. Each block
binds `type_to_string(<TypeValue local>)` to a `String`, tests it with
`.index_of(String.from("…")) != .None`, and `eprintln`s a template with 2–9
interpolations. The knob is unset in every run: the cost is paid EVALUATING
the probes at check time, not running them. ~1.7 GB and ~26 s per probe.

This is the second measurement of the mechanism the F8 issue describes (one
5-line probe in `_bind_some_type` cost +11.7 GB of seed compile on
2026-08-24). Note the plan's baseline (§0.1, 19.33 GB on `49d75c665`) was
taken BEFORE #800 landed; the 31.5 GB the Perceus census measured the same
afternoon was after it.

## What the minimal repros ruled out (v0.2.38, `check`, entry program importing the compiler's `type_to_string`)

| variant                                                            | footprint |
| ------------------------------------------------------------------ | --------- |
| control: gated `eprintln` of a literal                             | 1.198 GB  |
| + `type_to_string(param)` bound and interpolated                   | 1.197 GB  |
| + `.index_of(…) != .None` test                                     | 1.177 GB  |
| the full #800 block shape (two strings, two tests, 2 interpolations) | 1.199 GB |
| the full block called from 60 call sites                           | 1.200 GB  |
| the full block in a fn with `exn : Exception`, 1 and 60 call sites | 1.199 / 1.200 GB |
| the full block in an IMPORTED module                               | 1.200 GB  |
| a type error inside the gated block                                | reported — the body IS checked |

So: not per call site, not the effect parameter, not the module position,
not the interpolation count, not the `Option` comparison, and the body is
evaluated. The cost needs the ENCLOSING function's context — `_synthesize_types_impl`
is ~1,500 lines with hundreds of locals in scope and dozens of nested
`cond`/`match`; the smaller-closure isolation (`check src/evaluator/types/synthesizer.yo`
with and without its three probes) is the next measurement, recorded below
when it lands.

## Fix in this branch

The seven blocks and the helper are removed (the `doc_stability` investigation
they served is closed by #800 itself). This is cleanup of debugging residue,
not the fix for the mechanism; the mechanism is F8 / Phase 7 of
`plans/EVALUATOR_MEMORY_REDUCTION.md`.

## Isolation (2026-09-20, `check src/evaluator/types/synthesizer.yo`, v0.2.38 binary)

| variant of the #800 tree                                   | footprint | wall   |
| ---------------------------------------------------------- | --------- | ------ |
| all seven probes (as merged)                               | 19.84 GB  | 149 s  |
| probe BODIES removed, the new imports kept                 | 7.35 GB   | 41 s   |
| #802 tree (no probes)                                      | 7.35 GB   | 42 s   |
| only `expr_info.yo`'s probe restored                       | 7.35 GB   | 41 s   |
| only `impl.yo`'s probe restored                            | 7.36 GB   | 41 s   |
| only `synthesizer.yo`'s three probes restored              | 7.39 GB   | 42 s   |
| only `env_lookup.yo`'s three probes restored               | 19.81 GB  | 146 s  |
| `env_lookup.yo`: `[chres-fast]` only                       | 7.50 GB   | 42 s   |
| `env_lookup.yo`: `[chres-oor]` + `[chres-refuse]`          | 19.64 GB  | 149 s  |
| `[chres-oor]` only                                         | 19.61 GB  | 150 s  |
| `[chres-refuse]` only                                      | 7.41 GB   | 42 s   |
| `[chres-oor]` without the `_was_self_bound_frame` call     | 19.62 GB  | 148 s  |
| `[chres-oor]` with its template cut to ONE interpolation   | 7.33 GB   | 41 s   |
| `[chres-oor]` template: first 5 / last 5 interpolations    | 7.36 / 7.37 GB | 41 / 42 s |
| `[chres-oor]` template: first 8 / first 9 / all 10         | 8.12 / 10.35 / 19.6 GB | 47 / 64 / 148 s |

One template string with ten `${…}` was the whole cost; six of the seven
probes were free. Its cost grows ~4× per added interpolation past ~7, and
the same growth reproduces in a 15-line program (the F8 issue).
