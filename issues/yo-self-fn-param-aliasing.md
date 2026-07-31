# yo-self: parameter aliasing for anon fns against a differently-labeled fn type (fn.test.yo test 9)

## Status

OPEN — the `checkDeferredGenericReturnType` port for the ANON path is written but
parked (removed from `values/anonymous_function.yo`) because enabling it exposes
this deeper gap and flips `tests/fn.test.yo` HOLLOW → RED. The direct-definition
twin (`(fn(generic(T), value : T) -> T)(body)`) IS landed in
`calls/function_type.yo` and works.

## The chain (measured on /tmp/sh22–sh24, 2026-07-31)

1. `tests/fn.test.yo` test 9 ("Test generic functions") is the file's last
   hollow root: `comptime_expect_error((comptime(identity2) : fn2) = (value ->
begin(return(i32(0)))))` — the anon fn against the generic fn-type variable
   evaluates successfully in yo-self (TS rejects via
   checkDeferredGenericReturnType, anonymous-function.ts:773).
2. Porting the check to the anon defer path makes those cee arms error
   correctly — but then test 9's def-eval proceeds further than ever before,
   and codegen emits the later arms:

   ```rust
   comptime(id) : (fn(comptime(T) : Type, x : T) -> T);
   id = ((T, a) -> a);
   x := id(bool, true);
   ```

   The specialization emits `static inline bool fn_yo_id_..._ret_...(bool x)
{ return a; }` — C param named from the DECLARED type's label (`x`), body
   referencing the closure's OWN label (`a`) → clang "use of undeclared
   identifier 'a'" ×3 → file RED.

3. TS handles this with **parameter aliasing** (function-type.ts:283-289
   `needsParameterAliasing`, :308-375): when the expected fn type's param
   labels differ from the anon fn's own labels, the body env binds the anon
   fn's OWN name with `parameterAlias = expectedParamName`, and the
   FunctionType keeps the ORIGINAL (anon) labels ("the function body uses the
   original parameter names"). yo-self's `Variable.parameter_alias` field
   exists (env.yo:121) but is DEAD — nothing sets or consumes it.

## Fix plan (next round)

- Find the yo-self specialization site that chooses C param names for a
  FuncVal called through a differently-labeled declared fn type — it currently
  takes the DECLARED type's labels; TS emits the FuncVal's OWN labels.
  (Note `values/anonymous_function.yo` L3 already registers
  `corrected_func_type` with source labels — the broken emission comes from a
  different path, likely the `comptime(id) : fnType` variable's type driving
  the spec.)
- Port `needsParameterAliasing` binding (both names resolve; alias for
  call-site named args).
- Then re-land the anon-path deferred generic return check: the removed block
  (see git history of this issue's round, or re-derive from
  `calls/function_type.yo`'s `dg_*` block) with:
  - throwaway FuncVal id (`random_id`) — reusing the real func_id lets trial
    registrations shadow the real definition's;
  - trial-abstract skip: only a FULLY CONCRETE trial type can convict
    (a `Box(V)` trial vs `Box(T : Clone)` expected false-fired inside
    prelude's Box Clone impl and abandoned the whole module load — every
    import downstream then failed "Variable Option not found").

## Verification

- `tests/fn.test.yo` TRUE GREEN at TS parity (TS: 24 passed).
- Direct-def arms already verified: `(fn(generic(T), value : T) -> T)({
return(i32(0)) })` and the `Tuple(T)` twin both error under sh21+.
