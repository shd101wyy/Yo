#!/usr/bin/env python3
"""Re-apply the MEASURED-WORKING evaluator half of the iter_filter_closure fix.

    python3 scratchpad/apply_iterfilter_evaluator_half.py
    ./yo-cli fmt yo-self/evaluator/values/impl.yo yo-self/evaluator/trait_checking.yo
    ./yo-cli check ./yo-self | tail -1          # expect 295/305

Measured with exactly these two edits (see issues/yo-self-hollow-root-cause-map.md,
"attempt 3"): all three arms of tests/iter_filter_closure go hollow=1 -> hollow=0,
i.e. the blanket `impl(… IterFilter(I, F), Iterator(…))` finally MATCHES and
`.next()` resolves to a real method.

It is NOT landable on its own: with the impl matching, emission then reaches
`// Failed to transpile (self._f)(&(item))` — the closure-param call inside the
specialized blanket-impl body — plus era-identity C type mismatches. Land it
together with the codegen field-type stamp (the specialized receiver's `_f` field
type carries no resolution, so `impl_closure_call_map`'s key stays a bare SomeT id;
the lookup side is already correct). Gate: scratchpad/hollow8.sh, then the full
sweep — step 1 changes how EVERY generic impl records its where-constraints.

Idempotence: each edit asserts its anchor, so a second run fails loudly rather
than double-applying.
"""
import sys

IMPL = "yo-self/evaluator/values/impl.yo"
TRAIT = "yo-self/evaluator/trait_checking.yo"


def patch(path, pairs):
    s = open(path).read()
    for old, new in pairs:
        if old not in s:
            sys.exit(f"ANCHOR MISSING in {path}:\n{old[:120]}")
        s = s.replace(old, new, 1)
    open(path, "w").write(s)
    print(f"patched {path}")


# --- Step 1: the ROOT. Do not let the atom fast path swallow a PARAMETERIZED
# trait expression: `Iterator(Item := A)` was recorded as the bare `Iterator`,
# so the where-constraint carried NO assoc-type constraint and the impl's `A`
# had no binding source. The slow path below already evaluates the full expr.
STEP1 = [(
    """  (atom_result : Option(TypeValue)) = Option(TypeValue).None;
  if(ast_expr_is_atom(head_expr), {""",
    """  (atom_result : Option(TypeValue)) = Option(TypeValue).None;
  // The fast path is only sound for a BARE trait name. For a PARAMETERIZED trait
  // expression (`Iterator(Item := A)`, `Eq(T)`) it walks to the leftmost atom and
  // returns the UNPARAMETERIZED TraitT bound under that name, dropping the
  // arguments — so the recorded where-constraint carries no associated-type
  // constraint and a forall only that constraint mentions can never bind. TS keeps
  // the constraint EXPRESSION and re-evaluates it (src/evaluator/values/impl.ts:
  // 2355-2377); the slow path below is yo-self's equivalent.
  if(ast_expr_is_atom(trait_expr) && ast_expr_is_atom(head_expr), {""",
)]

# --- Step 2: the env-propagating hook + the THIRD binding source.
STEP2_HOOK = [
    (
        """TypeImplementsTraitFn :: (fn(t : TypeValue, trait_type : TypeValue, env : Environment) -> bool);""",
        """TypeImplementsTraitFn :: (fn(t : TypeValue, trait_type : TypeValue, env : Environment) -> bool);
/// Env-PROPAGATING twin of `TypeImplementsTraitFn`: `Some(env)` when the trait is
/// implemented, carrying the bindings that SATISFYING it produced. TS's
/// `typeImplementsTrait` returns `{ implemented, env }` and its generic-impl matcher
/// adopts that env (src/evaluator/values/impl.ts:2425-2435) — the bool hook throws it
/// away, and that env is the only thing that can bind a forall appearing SOLELY in a
/// where-clause. `Option(Environment)` rather than trait_checking's
/// `TraitCheckResult` because impl.yo cannot import that module (cycle).
TypeImplementsTraitEnvFn :: (
  fn(t : TypeValue, trait_type : TypeValue, env : Environment) -> Option(Environment)
);""",
    ),
    (
        """(g_type_implements_trait_fn : Option(TypeImplementsTraitFn)) =
  Option(TypeImplementsTraitFn).None;""",
        """(g_type_implements_trait_fn : Option(TypeImplementsTraitFn)) =
  Option(TypeImplementsTraitFn).None;
(g_type_implements_trait_env_fn : Option(TypeImplementsTraitEnvFn)) =
  Option(TypeImplementsTraitEnvFn).None;
set_type_implements_trait_env_fn :: (fn(f : TypeImplementsTraitEnvFn) -> unit)({
  g_type_implements_trait_env_fn = Option(TypeImplementsTraitEnvFn).Some(f);
});""",
    ),
    (
        "export(set_type_implements_trait_fn, set_register_trait_value_fn,",
        "export(set_type_implements_trait_fn, set_type_implements_trait_env_fn, set_register_trait_value_fn,",
    ),
]

# NOTE: insert the name-comparison helper at the `try_match_generic_impl ::`
# anchor WITHOUT including that anchor in the inserted text — including it
# duplicated the definition header and the parser then failed with
# `undefined is not an object (evaluating 'tokens[index].type')`, pointing at the
# wrong line. See the memory note "fmt before every build".
HELPER = """/// True iff `t` is a SomeT whose NAME is `nm`. The forall SomeT recorded on a
/// generic-impl entry and the one inside that impl's where-constraint trait can be
/// different lineage COPIES (same name, different id), so the name is the reliable
/// link between `where(I <: Iterator(Item := A))` and the binder `A`.
_some_type_named :: (fn(t : TypeValue, nm : String) -> bool)({
  tn := match(t,.SomeT({ name : __n }) => __n.clone(), _ => String.new());
  ((tn.len() > usize(0)) && (tn == nm))
});
"""

THIRD_SOURCE = [(
    """          .None => {
            all_bound = false;
          }
        );
      }
    );
    vi = (vi + usize(1));""",
    """          .None => {
            // THIRD source (TS impl.ts:2418-2435): a forall that appears ONLY in a
            // where-clause — `impl(generic(I, A, F), where(I <: Iterator(Item := A)),
            // IterFilter(I, F), …)` — is bound by SATISFYING that constraint, not by
            // unifying the receiver. Reached only after both structural sources fail,
            // and only for a constraint whose trait carries THIS binder as an
            // associated-type constraint, so no other impl's matching can change.
            (wb_i : usize) = usize(0);
            (wb_found : bool) = false;
            n_wb := entry.where_constraint_some_types.len();
            while((wb_i < n_wb) && !(wb_found), {
              wb_trait := match(entry.where_constraint_traits.get(wb_i),.Some(t) => t,.None => t_unit());
              wb_lhs := match(entry.where_constraint_some_types.get(wb_i),.Some(s) => s,.None => t_unit());
              wb_lhs_nm := match(wb_lhs,.SomeT({ name : __ln }) => __ln.clone(), _ => String.new());
              wb_atc := match(wb_trait,.TraitT({ assoc_constraint_types : __a }) => __a, _ => ArrayList(TypeValue).new());
              (wb_mentions : bool) = false;
              (wb_ai : usize) = usize(0);
              while((wb_ai < wb_atc.len()) && !(wb_mentions), {
                match(
                  wb_atc.get(wb_ai),
                  .Some(wb_at) => if(_some_type_named(wb_at, fa_name2.clone()), {
                    wb_mentions = true;
                  }),
                  .None => ()
                );
                wb_ai = (wb_ai + usize(1));
              });
              if(wb_mentions, {
                wb_bound := _resolve_one_forall_binding(synth_result.expected_env, wb_lhs, wb_lhs_nm.clone());
                match(
                  wb_bound,
                  .Some(wb_target) => match(
                    g_type_implements_trait_env_fn,
                    .Some(wb_f) => match(
                      wb_f(wb_target, wb_trait, synth_result.expected_env),
                      .Some(wb_env2) => match(
                        _resolve_one_forall_binding(wb_env2, fa_some2, fa_name2),
                        .Some(wb_t) => {
                          _b3 := bindings.push(wb_t);
                          g_last_match_binding_vals.push(EvalValue.UnitVal);
                          wb_found = true;
                        },
                        .None => ()
                      ),
                      .None => ()
                    ),
                    .None => ()
                  ),
                  .None => ()
                );
              });
              wb_i = (wb_i + usize(1));
            });
            if(!(wb_found), {
              all_bound = false;
            });
          }
        );
      }
    );
    vi = (vi + usize(1));""",
)]

ADAPTER = [(
    """_trait_checking_init := (fn() -> bool)({
  set_type_implements_trait_fn(type_implements_trait_bool);""",
    """/// Env-PROPAGATING adapter for impl.yo's generic-impl matcher — TS's
/// `typeImplementsTrait` returning `{ implemented, env }` (impl.ts:2425). The env
/// carries bindings that satisfying the trait produced (e.g. `A := i32` from
/// `I <: Iterator(Item := A)` against `CountIter`, via
/// `_check_associated_type_constraints`).
_implements_env_adapter :: (
  fn(t : TypeValue, trait_type : TypeValue, env : Environment) -> Option(Environment)
)({
  r := type_implements_trait(t, trait_type, env);
  cond(
    r.implemented => Option(Environment).Some(r.env),
    true => Option(Environment).None
  )
});
_trait_checking_init := (fn() -> bool)({
  set_type_implements_trait_fn(type_implements_trait_bool);
  set_type_implements_trait_env_fn(_implements_env_adapter);""",
), (
    "  set_type_implements_trait_fn,\n",
    "  set_type_implements_trait_fn,\n  set_type_implements_trait_env_fn,\n",
)]

patch(IMPL, STEP1 + STEP2_HOOK)

s = open(IMPL).read()
anchor = "try_match_generic_impl :: ("
i = s.find(anchor)
if i < 0:
    sys.exit("try_match_generic_impl anchor missing")
open(IMPL, "w").write(s[:i] + HELPER + s[i:])
print("inserted _some_type_named helper")

patch(IMPL, THIRD_SOURCE)
patch(TRAIT, ADAPTER)
print("\nNow run: ./yo-cli fmt", IMPL, TRAIT, "&& ./yo-cli check ./yo-self | tail -1")
