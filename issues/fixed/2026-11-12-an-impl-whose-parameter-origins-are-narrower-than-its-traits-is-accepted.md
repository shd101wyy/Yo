# An impl whose parameter origins are narrower than its trait's is accepted

**Severity:** S1. A trait keeps `self` and `v` apart (`put(self : &mut Self, v : &Rc(X))`, two fresh origins). An
impl over `Slot(p)` may require `v : &(Rc(X), p)` and store `v` into `self`. It is accepted, and a call with a
block-local argument reads freed memory. This is O7's parameter half. v0.2.76 accepts it too, so it is
pre-existing.

Split out on 2026-11-12 from
`issues/fixed/2026-11-11-an-impl-whose-result-origin-is-wider-than-its-traits-is-accepted-and-dyn-callers-trust-the-trait.md`, whose result half is fixed
(VERDICTS-57 §2, lane v57a). The parameter half was out of that fix's scope (VERDICTS-57 §6, probe (c); the
coordinator kept it out of v57a). Found by the borrow/ownership audit (yo-6c).

## Reproducers

- `issues/repros/2026-11-11-an-impl-whose-result-origin-is-wider-than-its-traits-is-accepted-and-dyn-callers-trust-the-trait-parameters.yo`: negative, expects E0923 at the impl. It is a heap-use-after-free on a direct
  call `s.put(&b)`.
- `issues/repros/2026-11-11-an-impl-whose-result-origin-is-wider-than-its-traits-is-accepted-and-dyn-callers-trust-the-trait-parameters-pos.yo`: the positive control. It keeps the trait's parameter origins and only
  reads `v`.

The `Dyn(Store)` and `where(T <: Store)` forms pass `yo check`. Their emitted C does not compile yet: these are
two emission defects in the audit's §3, B2 and B3. So the escape through the trait is latent behind them.

## Root cause

`_impl_result_origin_wider` (`src/evaluator/values/impl.yo`) compares only the result. Nothing compares an impl
member's parameter origins with its trait member's. Origins are erased from type identity, so the conformance
check (`are_types_compatible`) cannot see them either.

## Expected

E0923 at the impl. Parameters are invariant, per O3-3's function-type rule. After renaming, an impl's parameter
origins must equal its trait's: an impl may not require a relation between two parameters' origins that the trait
leaves independent.

## Fix (2026-11-13, lane `sig`, branch `fix/sig-1`)

`src/types/utils.yo` gains `fn_param_origin_links` (the pairs of a function type's parameters whose spelled origins
share a name, with each parameter's own slot) and `fn_param_origins_narrower(actual, expected)`: after the trait's
`Self` is substituted, an impl member that links two parameters the trait keeps apart is E0923. The check runs in
`_impl_member_origin_checks` (`src/evaluator/values/impl.yo`) beside the result check (`fn_result_origin_wider`,
renamed from `_impl_result_origin_wider` and exported), on both conformance routes: the direct impl
(`_c3_eval_colon_pair`) and the generic impl over a type constructor (`_c2_eval_inner_field`), which had no
member-signature comparison at all. The same comparison serves O7's fn-value slot
(`function_value_origin_mismatch`, `src/evaluator/trait_checking.yo`).

G-B rows (`tests/origins/unsound/`): `impl-param-origins-narrower.yo`, `impl-param-origins-narrower-generic-caller.yo`
(E0923, a direct and a generic-impl spelling) with the positive control `impl-param-origins-narrower-pos.yo`, and
`o7-composite-generic-impl-wider.yo` (the result half through the generic-impl route). The repros above now give E0923
and accept.
