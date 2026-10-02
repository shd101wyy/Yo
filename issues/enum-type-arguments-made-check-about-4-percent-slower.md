# `EnumT.type_arguments` (#1112) made `yo check ./src` about 4% slower

**Severity:** S3. A performance regression: every `yo check` and every
compile pays it. Codegen is slower too, by #1112's own emit measurement.

**Found:** 2026-10-02, measuring #1112 after it merged (develop `758c81bc4`).

## Measured

Mac mini (Apple M4), one session, alternating runs. `yo check ./src --std-path ./std`
on develop's tree at `235cf09ac` (#1112 plus the docs-only #1115). The baseline
is a compiler built from `3e4d3d0bb`, the commit before #1112. The std trees
are identical (`git diff --stat 3e4d3d0bb 235cf09ac -- std` is empty).

| run | before #1112 | with #1112 |
| --- | --- | --- |
| 1 | 145.10 s | 150.57 s |
| 2 | 144.00 s | 150.94 s |
| mean | 144.55 s | 150.76 s (+4.3%) |

#1112's PR body: `compile src/main.yo --emit-c` 1282 s / 2.94 GB before and
1318 s / 2.95 GB after (+2.8%).

Not yet measured: the per-phase split (`compile --profile`: evaluation,
codegen collect, codegen emit), and a single file that reproduces the ratio.

## Where to look (reasoned, not measured)

Every place #1112 added that reads an enum's type arguments or phantom flags
runs on hot paths:
- `type_key`'s phantom mask (`src/types/type_key.yo:501`,
  `enum_phantom_type_args_masked`): per key computation of every generic enum;
- the deferral predicate (`src/evaluator/trait_checking.yo:1956`,
  `enum_phantom_type_arg_somes`): per parameter type of every function;
- `src/evaluator/types/function.yo:5164` (`enum_phantom_type_arg_somes`);
- the CTFE memo's same-id comparison (`src/evaluator/calls/comptime_fn.yo:209`);
- `substitute`'s enum arm: each argument that is a bare type variable or
  phantom is walked after the variant fields;
- `enum_phantom_positions(id)`: a `HashMap(String, …)` lookup keyed by the
  enum id string, called from several of the above per use.

## A measured precedent from an independent implementation

`fix/enum-type-arguments` implemented the same change, superseded by #1112.
Its first version was 4.2x slower on `check ./src` (136 s to 573 s) and 4%
slower in codegen emit. Two causes, each found by toggling one consumer at a
time against `check ./src/evaluator/exprs/match.yo` (43 s on develop, 195 s
on that branch):
- **Walking an argument again after the fields.** `substitute`, the deferral
  predicate and `iso.yo`'s child walk visited an enum's fields, then its type
  arguments. `Option(X)`'s argument IS its `value` field, so for nested enums
  the work doubled per level. The fix: reuse the substituted field for an
  argument that is literally a field type (by type-variable id, or nominal
  id plus the same arguments), and walk any other argument only when it
  contains a type variable. #1112 already restricts substitution to bare
  type variables and phantom positions, so this may matter less here.
- **A recursive enum's self shell.** `Option(Self)` inside `TypeValue` carries
  the self shell (`<id>__self_shell`) as its argument and the final in its
  field. A literal-sameness test that compares ids missed it, and ~450k
  occurs checks per self-emit walked `TypeValue`'s whole variant list.
  Treating the shell and its final as one id fixed it.

After both, that branch measured parity with develop: `check ./src` 136.4 s
against 136.1 s; codegen emit 68.1 s against 68.5 s, the mean of three
interleaved pairs.

## How to fix

1. Find a file whose `check` shows the ratio (the 4% may be spread thin), and
   time `compile src/main.yo --profile` before and after, to see which phase
   pays.
2. Toggle each consumer listed above, one at a time, with a runtime-false
   condition. A literal `false` makes a loop condition comptime-known and is
   rejected.
3. Gate the fix on byte identity of develop's own `src/main.yo` emit (same
   `--std-path` for both binaries; type keys embed the std path) and on
   timing parity with the pre-#1112 compiler.
