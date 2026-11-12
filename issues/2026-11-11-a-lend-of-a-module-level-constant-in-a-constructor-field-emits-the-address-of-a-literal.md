# A lend of a module-level constant in a constructor field emits the address of a literal

**Severity:** S2. `&G` for a module-level constant `G :: i32(42)`, written as a constructor field —
`Option(&i32).Some(&G)`, `H(r : &G)` — passes `yo check`, and the C compiler rejects the program: the field is
emitted as `(&(42))`, "cannot take the address of an rvalue". A struct constant gives
`(&(/* skip generating struct value */))`. The same lend as a local borrow, `r := &G`, is rejected at check time
("a compile-time value with no runtime storage to alias"), so the two positions disagree. Pre-existing: v0.2.76
fails the same way.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 B5, ledger X-B1). Confirmed on develop `64f33c710`.
It is also why the `static` positive control drafted for
`issues/fixed/2026-11-11-a-reference-typed-over-the-static-origin-accepts-any-reference-and-freezes-nothing.md`
(`Option(&(i32, static)).Some(&G)`) does not compile.

## Reproducers

`issues/repros/2026-11-11-a-lend-of-a-module-level-constant-in-a-constructor-field-emits-the-address-of-a-literal.yo`
(expects accept, `OUT: 42`):

```yo
{ println } :: import("std/fmt");
G :: i32(42);
main :: (fn() -> unit)({
  o := Option(&i32).Some(&G);
  match(o, .Some(r) => println(`OUT: ${r.*.to_string()}`), .None => println("none"));
  ()
});
export(main);
```

```text
$ yo check repro.yo        # accepted
$ yo compile repro.yo -o t
repro.c:2380:190: error: cannot take the address of an rvalue of type 'int'
  … = (__yo_t_…){ .tag = …_SOME, .data = { .__yo_v_Some = { .__yo_v_value = (&(42)) } } };
yo: error: compile: C compiler failed (exit 1)
```

- `…-struct.yo` (expects accept): `G :: Pt(n : i32(42), m : i32(1))` lent into `Option(&(Pt, static)).Some(&G)`;
  C error "expected expression" at `(&(/* skip generating struct value */))`.
- `…-holder.yo` (expects accept): `H(r : &G)` with `H :: struct(r : &i32)`; `.__yo_v_r = (&(42))`.
- `…-arg.yo` (control): `show(&G)` for `show :: (fn(r : &i32) -> unit)` compiles and prints `OUT: 42`; the
  parameter is lowered by value (`show((int32_t)(42))`), so no address is taken.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `Option(&i32).Some(&G)`, `G :: i32(42)` | check OK, C compile fails | accept |
| `H(r : &G)`, a struct field | check OK, C compile fails | accept |
| `Option(&(Pt, static)).Some(&G)`, `G` a struct constant | check OK, C compile fails | accept |
| `show(&G)` to a `&i32` parameter | compiles, `OUT: 42` | accept |
| `r := &G` (ledger: a/g3) | error (no code): `Cannot borrow "G" (&G): it is a compile-time value with no runtime storage to alias.` | accept (P12) |
| `G :: String.from(…)` (ledger: a/g4) | rejected: a module-level `::` binding is a compile-time value | rejected |

## Root cause

A `::` module-level binding of a scalar or struct is a compile-time value: it has no C object, and codegen splices
its value wherever it is read. `_evaluate_inout_local_binding` (`src/evaluator/exprs/initialization_assignment.yo`)
knows this for a local borrow and throws when `root_var.is_compile_time_only()`. The lend marker in a constructor
argument or a tuple component goes through no such check; the evaluator types the field `&i32` and codegen emits the
lend as `&(<spliced value>)`, which is not an lvalue. A call argument escapes only because a `&` parameter of a small
`Copy` type is lowered by value.

## Expected

`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` R-GLOBAL gives "a lend of an unmarked module-level binding" the
empty origin (decision 47; `static`), and P12 accepts `R := &G` for an unmarked `G`. So the lend is legal in every
position, and a compile-time constant that is lent needs storage: emit it once as a `static const` C object and
lend its address, in a constructor field, a tuple component, a call argument and a local borrow (`r := &G`, which
is then accepted too). Until that lands, the check in `_evaluate_inout_local_binding` must run at every lend of a
compile-time-only binding, so the program is rejected at check time with one diagnostic, never in the C compiler.

## Test

With the fix: the three programs and the call-argument control in `tests/origins/` (a `global_constant_lend` test
file or corpus rows next to P12's `global-static-ref`), each compiled and run to its `OUT:` line; plus `r := &G`
accepted and read.
