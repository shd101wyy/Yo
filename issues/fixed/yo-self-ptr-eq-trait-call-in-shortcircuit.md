# yo-self: trait-method `==` on pointers inside `||` miscompiles (rc=133)

Found 2026-07-27 during the pointer-operator migration
(plans/archive/POINTER_OPERATORS_TO_TRAITS_AND_METHODS.md).

## Symptom

With `std/string/string.yo`'s `==` fast path written as a TRAIT call —
`(self_ptr == other_ptr) || (memcmp(...) == 0)` resolving through the new
generic `Eq(*(T))` prelude impl — the SELF-compiled binary of
`tests/codegen-bootstrap/short_circuit_rc_temp_drop.yo` dies with rc=133
(SIGTRAP, the RC-corruption signature). The TS-compiled binary is correct
(corpus DIFF). Bisect (all with a PRE-migration s1, so the compiler binary
is constant — /tmp/int_s1):

- migration std, trait-call fast path → DIFF (rc=133)
- migration std, fast path REMOVED → PASS
- migration std, fast path via DIRECT
  `__yo_ptr_eq` builtin call → PASS
- HEAD std + ONLY the Eq(\*(T)) impl added → PASS (impl registration
  alone is harmless; the trigger is the trait-dispatched call SITE inside
  String=='s `||`)

## Mechanism (hypothesis, unverified)

`String ==` is specialized into virtually every self-compiled program. A
trait-method call on POINTER operands as the LHS of `||` interacts with
the short-circuit owned-temp drop pass (the same pass family as the
2026-07-27 while-loop `||`-RHS owned-temp fix) — plausibly the trait-call
result temp or its receiver dup is dropped on the wrong short-circuit
path. The corpus file exercises exactly `||`/`&&` with RC temps.

## Workaround (shipped with the migration)

`std/string/string.yo` calls `__yo_ptr_eq` directly via a local
`extern("Yo")` declaration — no trait dispatch in the hot path (also
faster). The generic `Eq(*(T))` impl remains available for user code and
the rest of std; nothing else calls pointer `==` inside a short-circuit
in std today.

## Repro recipe for the real fix

Restore the trait call in string.yo's fast path, run
`YO_SELF_BIN=<s1> scripts/diff-test.sh tests/codegen-bootstrap/short_circuit_rc_temp_drop.yo --release`,
inspect the self-emitted C for the `||` temp-drop sequence around the
specialized `Eq(*(T))` `==`.

## UPDATE 2026-07-28 — believed FIXED by `a23013161`

The dispatch root is fixed: trait `==`/`>` on pointer receivers now resolves
to the `Eq(*(T))`/`Ord(*(T))` impls (receiver-compat filter + post-filter
generic-impl retry in env.yo; see
issues/fixed/yo-self-ptr-comparison-trait-dispatch-unify-throw.md). A standalone
repro of this issue's shape — pointer `==` as `||` LHS with RC String temps
in both arms — now compiles and runs correctly self-compiled
(`/tmp/porq.yo`, TS and s1 both `ok`). The exact original recipe (restore
string.yo's trait-call fast path + diff-test short_circuit_rc_temp_drop)
has NOT been re-run; the `__yo_ptr_eq` local-extern workaround in
std/string/string.yo STAYS regardless — it skips dispatch in the hottest
path in the compiler (also why it was measured faster).
