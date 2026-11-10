# `q := y` (and an untyped tuple or array component) on a reference binding is E0926

**Severity:** S3 — `q := y` with `y : &i32` and `(y, i32(1))` are rejected with E0926 although VERDICTS-23 R1 says "`y := value`: a `&U`" and that kind 0 fires only where the expected type is a concrete non-reference; `(q : &i32) = y`, `id(y)` and `.Some(y)` check.

- Filed: 2026-11-10 (capture lane; `VERDICTS-44` probes `a1`, `b2`). Owner: lane plane-c (PR 3 of VERDICTS-44), same guard as the capture entry, same `deref_rule_applies` gate. Not fixed by the capture lane.

```yo ignore
f :: (fn(y : &i32) -> i32)({
  q := y;
  q.*
});
```
