# yo-self: tests/ def-eval propagation campaign

After std/ reached 151/151 under propagation (commit 2cccb7dd), the same
sweep over tests/ surfaced 8 new heads (163/182 with the 11 known fails).
yo-self/ itself is at 28/228 under propagation — the next big frontier.

## Fixed (this round)

1. **forward_ref_impl_block + forward_ref_self_method** — yo-self had no
   pre-pass forward declaration for impl fields, so `caller` calling
   `callee` defined later in the same impl def-evaluated to unit. Ported
   TS `tryCreateForwardShell` (impl.ts:472) + the pre-pass loop
   (impl.ts:626): `_try_create_forward_shell` registers a
   `__forward_shell`-marked MethodEntry (trial-eval of the fn-type head,
   error-swallowed); the main pass UPDATES the entry in place (MethodEntry
   is an object — reference semantics — the yo-self mirror of TS mutating
   the shell FunctionValue). Second half: `_try_find_receiver_method`
   dropped `needs_pointer_conversion`, so a forward-dispatched method with
   `self : *(Self)` failed `*(Q)` vs `Q` unification — the flag is now
   threaded through ReceiverMethodResult and the call site wraps the
   receiver in a synthetic `&(...)` (TS function.ts:332-358).

2. **try_macro** — `process_unquotes_in_expr`'s case-1 tested
   `_is_unquote(func_box.*)` (is the CALLEE an unquote CALL — never true)
   instead of the NODE itself; TS checks `exprIsAtomOf(func, unquote)`
   (quote.ts:46-50). Every macro expansion silently left unquotes
   UNSPLICED and only "worked" when the unexpanded node evaluated benignly
   — `unquote(temp) := unquote(e)` (LHS splice) did not.

3. **variadic_comptime** — two fixes: (a) bare `create_unknown_val` now
   promotes unknown-of-type-`Type` to `TypeVal(SomeT)` like TS
   `createUnknownValue` (value.ts:573-588 — TS THROWS without a name, so
   a plain UnknownValue of type Type cannot exist in TS); (b) the
   generic-impl registration loop never bound evaluated fields into the
   env, so the alias field `first : car` (ComptimeList, std/prelude.yo)
   evaluated `car` as an unbound atom and registered `first` with type
   unit.

## Remaining heads (feature-level ports)

- **dyn.test.yo** — `Cannot unify "*(Self)" and "dyn((print : ...))"`:
  dyn self-param coercion under def-eval; frame-keyed SomeT resolution
  can't cover dyn self-params (see memory note on dyn coercion).
- **gadts.test.yo** — `Match expression is not exhaustive: BoolVal`:
  GADT-aware exhaustiveness narrowing (matching `Expr(i32)` must exclude
  variants whose type argument can't unify) is not ported.
- **higher_kinded_types.test.yo** — `Expected type for trait field, got
fn(...)`: HKT trait params (`F` with kind `fn(Type) -> Type`) need the
  kindFunctionType branch of TS createUnknownValue (value.ts:588+) +
  SomeT kind tracking; yo-self binds `F` as a plain unknown so `F(A)`
  doesn't evaluate as a type application.
- **tests/sys/tty.test.yo** — flaky 133 under parallel sweep only;
  passes sequentially (macro-dispatch heap corruption family).

## Update — strict identifier resolution + variadic binding (2026-06-08)

The variadic_comptime fix surfaced a deeper root cause: yo-self's
identifier evaluator (identifer_and_operator.yo) UNCONDITIONALLY
soft-fell to `UnknownVal(unit)` for unbound names, where TS throws
`Variable "X" not found.`. This masked real errors (tests/ref_return's
`comptime_expect_error` on `Option(ref(i32))` saw no error because
`ref` evaluated to unknown-unit). Made the throw strict, keeping the
soft fallback ONLY for operator names (prelude pre-load can't yet bind
`==` etc.). That in turn surfaced two latent binding gaps the soft-fall
had hidden:

- **variadic params** (`...(quote(elems))`): `TypeValue.Func` carries
  only a `has_variadic` bit, dropping the param's name+type, so the
  def-time body couldn't see `elems`. Added a side table
  (`g_func_variadic_params`, types/function.yo) keyed by the fn-type
  expr id, re-keyed to the FuncVal id (same two-step as default args),
  and bind it into the def-eval body env. Also fixed
  `create_unknown_val` of a Type-universe slot: the element-returning
  comptime-list builtins + CTFE short-circuits now use the NAMED
  variant (promotes to `TypeVal(SomeT)`) — TS names every such slot and
  THROWS on a nameless Type slot, so a bare UnknownVal of type Type
  can't exist in TS.
- **`where(...)` after the receiver** (`impl(forall(T), Channel(T),
where(T <: Send), ...)`): the per-type and generic-impl field loops
  treated `where(...)` as a trait-constructor field; the bare `where`
  atom evaluated to unknown-unit under the soft-fall. Both loops now
  skip `BK_WHERE` args.

Result: std 151/151, tests/ 170/182 under propagation (dyn + gadts the
only genuine remaining heads; http/hkt were flakes/now pass). Zero
regression in the committed gate.

## Update — dyn + gadts fixed (2026-06-08), tests/ propagation effectively complete

- **dyn.test.yo** — `value.print()` on `value : Dyn(TestDyn)` with self
  `*(Self)` synthesized `*(Self)` vs the bare `dyn(...)` arg → tag
  mismatch. Root: `_filter_receiver_methods` calls
  `are_types_compatible(receiver, pointee)` = `(Dyn, Self)`, but
  compatibility only had the `is_some_type(actual) && is_dyn_type(expected)`
  direction; the (actual=Dyn, expected=SomeT) direction was missing, so the
  filter never flagged `needs_pointer_conversion` and the receiver wasn't
  `&`-wrapped. Added the mirror direction (TS areTypesCompatible
  expected=SomeType/given=Dyn, compatibility.ts:662-684).
- **gadts.test.yo** — `eval_int_only` matching `Value(i32)` with only
  IntVal+PairVal reported BoolVal missing. The match exhaustiveness scan
  didn't skip GADT-unreachable variants. Ported `isGadtBranchReachable`
  (match.ts:117) as `_is_gadt_branch_reachable` and applied it in the
  exhaustiveness loop. The GADT type-constructor-args side table
  (`register_gadt_type_constructor_args`) was never populated — added the
  extraction at enum-build time (enum.ts:369-391: read the constructor
  fn's comptime Type-universe params from the env), keyed by the enum id.

Final tests/ propagation: **170/182**, remaining 12 = the 11 known-blocked
(flowability port ×4, circular-by-design ×4, algebraic_effects, mutex,
extern_unsafe_wrap) + occasional macro-dispatch heap-corruption flakes.
No genuine evaluator gaps remain in tests/ under propagation.
