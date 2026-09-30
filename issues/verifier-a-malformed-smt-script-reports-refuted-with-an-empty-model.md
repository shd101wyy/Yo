# A malformed SMT script is reported as `refuted` with an empty model

**Severity:** S2 — a query Z3 rejects (a parse error, an unknown constant) comes back as `sat` after the errors, and the harness reports the obligation REFUTED with `model: []` instead of `solver-error`, so an encoder bug reads as a false counter-example.

**Found:** 2026-09-30 while landing the ArrayList list model (R1 slice 2 of
`plans/backlog/ATS_STYLE_INDEXED_TYPES.md`): a datatype entry with the wrong
field-group shape rendered `(declare-datatypes ((List_bv32 0)) (((List_bv32_mk List_bv32_mk_contents (Array ...)) ...)))`;
z3 5.1.0 printed two `(error ...)` lines, then `sat` for the (now
unconstrained) `(check-sat)`, and `yo verify` reported a tautology
`(= (len xs) (len xs))` as **refuted**.

## Repro

Any obligation whose script z3 rejects. Captured script (through a
`YO_Z3_PATH` wrapper that copies its `.smt2` argument):

```
(declare-datatypes ((List_bv32 0)) (((List_bv32_mk List_bv32_mk_contents (Array (_ BitVec 64) (_ BitVec 32))) ((List_bv32_mk_len _ BitVec 64) ()))))
(declare-fun xs () List_bv32)
(assert (not (= (List_bv32_mk_len xs) (List_bv32_mk_len xs))))
(check-sat)
```

```
(error "line 7 column 51: invalid datatype declaration, '(' or ')' expected got List_bv32_mk_contents")
(error "line 9 column 162: unknown constant List_bv32_mk_len (List_bv32) ")
sat
```

Reported: `refuted`, `model : []`.

## Mechanism (read, not yet measured in the harness)

`src/verifier/z3.yo` parses the verdict from the first `sat`/`unsat`/`unknown`
token and tolerates z3's non-zero exit when a verdict was parsed ("z3's
nonzero exit on unavailable post-check-sat evidence is tolerated", the V2
notes). An `(error ...)` line BEFORE the verdict is not distinguished from
the post-check-sat `unsat core is not available` error, so a script that
never asserted anything reads as a satisfiable negation.

## Fix

Treat any `(error` line that precedes the `sat`/`unsat`/`unknown` token as a
`solver-error` verdict (keep tolerating errors after it), and include the
error text in the report. A `verifier.test.yo` case: a canned z3 transcript
with an error before `sat` maps to `solver-error`, not `refuted`.
