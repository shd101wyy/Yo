# A `cond` of `dyn(&place)` values passed to a reference parameter is read as a temporary

**Severity:** S3. Sound but over-strict: a program that holds only borrows of two live locals is rejected, and
the diagnostic calls a borrow of `c` or `c2` a borrow of a temporary.

Filed 2026-11-25 by the `s1-dyn-place-origin` lane, while auditing the siblings of
`issues/fixed/2026-11-25-a-dyn-of-a-place-passed-to-a-reference-parameter-gives-the-call-result-no-origin.md`.
Seen on develop `e019dfa51`, before and after that fix.

## Reproducer

`issues/repros/2026-11-25-a-cond-of-dyn-references-passed-to-a-reference-parameter-is-read-as-a-temporary.yo`:

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
Name :: trait(name : (fn(self : &Self) -> &String));
Cat :: struct(s : String);
impl(Cat, Name(name : (fn(self : &Self) -> &String)(&self.s)));
_get_opt :: (fn(d : &Dyn(Name)) -> Option(&Dyn(Name)))(Option(&Dyn(Name)).Some(d));
main :: (fn() -> unit)({
  c := Cat(s : String.from("abc"));
  c2 := Cat(s : String.from("de"));
  b := (c2.s.len() > usize(1));
  o := _get_opt(cond(b => dyn(&c), true => dyn(&c2)));
  match(
    o,
    .Some(d) => println(`OUT: ${d.name().len().to_string()}`),
    .None => ()
  );
});
export(main);
```

```text
error[E0911]: Cannot bind `o` to `_get_opt(cond(b => dyn(&(c)), true => dyn(&(c2))))`: its value holds a reference into `cond(b => dyn(&(c)), true => dyn(&(c2)))`, a temporary that ends with this statement, while `o` lives on (decision 43, plans/backlog/BORROW_CHECKER_COMPLETENESS.md §3 R-TEMP).
help: bind `cond(b => dyn(&(c)), true => dyn(&(c2)))` to a local first and lend the local
```

`_get_opt(dyn(&c))` alone binds, and `o` then borrows `c`.

## Root cause

R-CALL's R-TEMP clause (`_origin_of_into`, `src/evaluator/utils.yo`) asks `is_temporary_operand` of each argument
at a reference parameter. A bare `dyn(&c)` is no temporary: `projection_call_mode_of` reads its recorded
`unsize_reference_mode` as a projection of `c`. A `cond` whose arms are such projections has no mode of its own,
and its recorded type is the pointee `Dyn(Name)` (a reference slot reads its argument at the pointee's type),
not a `Reference`, so `is_temporary_operand` answers true. The arms are reference values into `c` and `c2`, and
R-ARM over them would give `[c(imm), c2(imm)]`.

## Expected

The program is accepted (it prints `OUT: 3`), and `o` borrows both `c` and `c2`: a move or a write of either
while `o` lives is E0911.
