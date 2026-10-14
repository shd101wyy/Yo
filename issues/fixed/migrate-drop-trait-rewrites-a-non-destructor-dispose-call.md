# `yo fix --migrate drop-trait` rewrites a non-destructor `x.dispose()` to `drop(x)`

**Severity:** S2 — the migration deletes a call to an inherent (or another trait's) method named `dispose` by rewriting it to `drop(x)`, with no diagnostic; a one-argument call is renamed to `.drop` while its definition is not, so the migrated file stops checking (E0610), and a field named `dispose` is renamed too (E0406).

**Status:** Fixed (v0.2.63). Found by the v0.2.62 adversarial review (the S2 deletion and the S3 definition/call split); new with the migration in decision 45 Generation A (#1343).

## Symptom

```yo
Pool :: struct(n : i32);
impl(Pool, dispose : (fn(self : &Self) -> unit)(println(`Pool.dispose: released ${self.n} slots`)));
main :: (fn() -> unit)({
  p := Pool(n : i32(3));
  p.dispose();
});
export(main);
```

`yo fix inh3.yo --migrate drop-trait` reported `1 explicit call(s) to drop(x)`
and wrote `drop(p);`: the program then printed nothing. With
`impl(Pool, dispose : (fn(self : &Self, k : i32) -> i32)(...))` and
`p.dispose(i32(2))`, the call became `p.drop(i32(2))`, the definition stayed,
and `yo check` failed with `E0610 No method "drop" on Pool`; the run listed the
call as "an explicit destructor call (E0915)". A field read `c.dispose` became
`c.drop` (E0406).

## Root cause

`_dtm_walk` (`src/main.yo`) was purely syntactic: every `.dispose` member was
taken for the `Dispose` trait's method. Only the witness form
`(T <: Dispose).dispose` names the trait.

## Fix

The migration now evaluates every file before it rewrites anything. While it
does, E0915's check (`_reject_explicit_destructor_call`, and the member-read
check) records each `.dispose` member that resolves to the destructor
(`record_destructor_site`, `src/expr_info.yo`) instead of rejecting it. The
walk rewrites a `.dispose` member — `x.dispose()` to `drop(x)`, or a rename to
`.drop` listed for a hand edit — only at a recorded position (or under the
witness); every other `.dispose` member is listed as "does not resolve to the
destructor (an inherent method, another trait's method or a field, or code
evaluation never reached): left as written". The impl-entry label is renamed
only inside a `Dispose(...)` entry, as before, so an inherent method's
definition and its calls stay in step. The summary line counts the members
left as written and the files that did not evaluate.

## Test

`tests/cli-cases/fix-migrate-drop-trait`: `fixture/inherent.yo` has an
inherent `dispose` method, a field named `dispose` and a `Dispose` type; the
case runs the migration and then `check inherent.yo`. Before the fix the
inherent call became `drop(p)` and the field `c.drop`, so the check failed
(E0406) and the golden tree differs.
