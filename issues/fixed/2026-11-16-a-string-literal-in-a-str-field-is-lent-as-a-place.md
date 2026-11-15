# A string literal in a `str` field is lent as a place, a `-> str` body dereferences its `&str` result, a copied `str` parameter cannot be returned, and a literal at a by-value binder binds `T := str`

**Severity:** S2. On the `str` flip's tree binary (decision 49 S2, `vbd/d49-str`; never on develop), valid programs
failed in four ways. A string literal stored in a `str` struct field emitted invalid C, and one stored in an enum payload
compiled to a zero-length view, so `match(t, .Tag("a") => …)` never matched. A `-> str` function returning its
`&str` parameter emitted invalid C. A `-> str` body returning a local copy of a `str` parameter was E0912. A literal passed to a by-value
binder (`hold("x")` with `x : T`) bound `T := str` and was E0619. Seen in `tests/match_strings.test.yo`,
`tests/template_string_specs.test.yo` and the `fix-migrate-unsized-str` cli fixture.

Filed 2026-11-16 by the d49-str lane, fixed on the same branch before it was opened.

## Reproducer

```yo
H :: struct(name : str);
Tagged :: enum(Tag(name : str), Empty);
id :: (fn(s : &str) -> str)(s);
copy :: (fn(a : str) -> str)({ r := a; r });
main :: (fn() -> unit)({
  h := H(name : "c");
  t := Tagged.Tag("a");
  _ := (h, t, id("q"), copy("q"));
});
export(main);
```

The emitted C, before the fix:

```c
(__yo_t_...){ .__yo_v_name = (&("c")) }                         /* struct field: address of a C string */
{ .data = { .__yo_v_Tag = { .__yo_v_name = "a" } } }             /* payload: brace elision, .len = 0 */
static inline __yo_str yo_id_...(__yo_str __yo_v_s) { return (*__yo_v_s); }   /* invalid indirection */
```

and `copy` was `error[E0912]: Cannot return the local borrow \`r\`: it borrows \`a\` with \`&\``.

## Root cause

1. **The literal as a lent place.** A reference field or payload given an atom records a T9 lend
   (`lend_place_reference_type`, `src/evaluator/utils.yo`). That function names the lent place's root after the
   atom's token. A string literal is an atom, so `"c"` at a `&(str, static)` field was "a lend of the place `"c"`".
   The converted runtime type became `&comptime_str`, which codegen rendered as a bare C string (`"c"`), and the
   struct path then took its address. Under the flip a literal is no place: it is the `&(str, static)` value itself.
2. **The tail read retyped its binding.** The body's tail `s` reads the `&str` parameter as the reference itself (the
   value-`str` arm), typed `&str`. `attach_temp_variable_to_expr` (`src/evaluator/utils.yo`) then stored that read type
   as the variable's value type. A reference binding keeps its reference shape over a new value type, so the parameter's
   slot became `&&str`. Codegen saw a pointer to a fat pair in a binding that holds the pair, and emitted `(*s)`.
   Measured with a debug build of the tree: `slot=&&str is_ref=true` at the read.
3. **The copy as a local borrow.** `r := a` with `a` a reference binding binds `r` as a reference over `a`'s
   referent (R-TAIL, `_bind_projection_result`). E0912 then rejected `r` as a body result, because a `-> str`
   result is a by-value slot. `a` is a `&str` parameter: its referent is the caller's, so a borrow through it points
   into no local of the function, and `r` is the reference `a` itself is (which the body may return as it is).
4. **The literal at a by-value binder.** A generic call binds a binder from a literal through
   `_funcval_infer_forall_ty` (`src/evaluator/calls/function.yo`), which lowered every `comptime_str` to the unsized
   `str`. That is right where the slot lends a place (`x : &T`, `T := str`), and wrong for `x : T`: there the literal
   is the `&(str, static)` value, as `s := "x"` types `s`.

## Fix

1. `lend_place_reference_type` makes no lend of a string literal (`is_comptime_string_type` on the place). The
   literal keeps its lowered `&(str, static)` type, and codegen renders the `__yo_str` value.
2. `attach_temp_variable_to_expr` leaves a reference binding's type alone when the read is the fat reference itself
   (`is_reference_read`, an unsized pointee). Codegen also stops deriving the deref from the binding alone in two
   places. The identifier's fall-through paths pass the read's type to `_var_read_code`. The return statement's
   "bare name of a reference binding" deref skips a read typed as a fat reference (`src/codegen/exprs/return.yo`).
3. `local_borrow_result_borrow_of` returns no borrow when every place it names is the referent of a shared `&str`
   parameter (`_lb_places_are_str_parameter_referents`).
4. `_funcval_infer_forall_ty` takes whether the declared slot lends (`t_slot_is_borrow`): `str` there,
   `&(str, static)` for a by-value binder.

Test: `tests/str.test.yo`, "a string literal fills a str field and payload, and a -> str function returns a &str".
It fails on the branch before the fix (invalid C; a zero-length payload; E0912) and passes after. The same test
covers facet 4 (`_str_hold("x")`), as does the `fix-migrate-unsized-str` cli case's `hold("x")`.
