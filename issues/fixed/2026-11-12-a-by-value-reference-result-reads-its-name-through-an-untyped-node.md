# A generic `-> T` specialized at `T := &U` reads its result name through a node with no `ExprInfo`, and G-E's totality count is 2

**Severity:** S3: found by the G-E totality audit (`scripts/check-origin-sinks.sh --totality`, the `origins-corpus` CI job); no program shown to be unsound, the audit's contract (every origin-carrying sink has its origin computed) is not met for this form.

R3 (#1904, VERDICTS-23/54) rewrites the result positions of a by-value reference result: a bare name `a` becomes the marked `addr_of(a.*)` (`rewrite_value_reference_tails`, `VALUE_*_READ_PATH` in `src/expr.yo`). The audit run over `tests/origins/reference_read_rule.test.yo` reports, with `YO_AUDIT_ORIGIN_TOTALITY=1`:

```
[origin-totality] untyped origin_of tests/origins/reference_read_rule.test.yo:717:80 (a.(*))
[origin-totality] untyped origin_of tests/origins/reference_read_rule.test.yo:717:83 (b.(*))
```

at `_sm_pick :: (fn(generic(T : Type), a : T, b : T, first : bool) -> T)(if(first, a, b))` instantiated at `T := &i32`. The synthesized `a.*` inside the marker is reached by `origin_of`'s recursion but is never recorded in the expression table (the rewrite builds the nodes after the clone, and the by-value read has no projection root rule to record them), so the audit's `untyped` class fires and the gate count is 2, not 0. On the tree before R3 the count was 0 (o6-method-lend gates, 2026-11-12).

## Fix direction

Either the rewrite records an `ExprInfo` for the nodes it synthesizes (the owner of R3), or `origin_of` reads the `VALUE_*_READ_PATH` marker the way it reads a lend marker and never descends into the synthesized operand. Not an exemption in the audit: the point of G-E is that a node `origin_of` reaches has a record.

## Fix

The second direction: `_origin_of_into` (`src/evaluator/utils.yo`) reads a `VALUE_*_READ_PATH` node as R-READ of its name
and never descends into the synthesized `name.*`. The marked `addr_of(name.*)` is the reference VALUE `name` holds, so
its origin is `name`'s; `addr_of` is not the `&` lend marker R-LEND reads, so before this the node fell through to
R-CALL's constructor fallback and recursed into the operand, which `evaluate_address_call` evaluates under another id.
G-E's totality count for `tests/origins/reference_read_rule.test.yo` is 0 again (fixdev lane, develop battery
43142204182's `origins-corpus` failure). The same job's `./src: rc=1` was a missing `yo install`: the job now runs
`install-deps` before the audit, and `scripts/check-origin-sinks.sh --totality` fails on a target that does not check
(an unchecked file is an unaudited one; the corpus, whose rows are rejected programs, is the one exception).
