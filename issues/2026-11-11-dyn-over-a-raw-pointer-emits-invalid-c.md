# `dyn(p)` over a raw pointer emits invalid C

**Severity:** S2 — a valid program that erases a raw pointer into an owning `Dyn` (`(t : Dyn(Tag)) =
dyn(addr_of(c))` with `Tag` implemented for `*T`) passes `yo check`, and the C compiler then rejects it, so no
binary is built.

Found 2026-11-11 by the d49s1fg lane while writing the `fix-migrate-unsized` fixture (decision 49 S1f lists
`dyn(p)` over a raw pointer, VERDICTS-43 §4). It is not new: the seed v0.2.76 fails the same way (16 C errors),
and so does develop `f784ff74f`. Not fixed by S1f.

## Reproducer

`issues/repros/2026-11-11-dyn-over-a-raw-pointer-emits-invalid-c.yo`:

```yo ignore
Tag :: trait(tag : (fn(self : &Self) -> i32));
impl(generic(T : Type), *T, Tag(tag : ((self : &Self) -> i32(7))));
main :: (fn() -> unit)({
  c := Cat(n : i32(1));
  (t : Dyn(Tag)) = dyn(addr_of(c));
  x := t.tag();
});
```

```text
m.out.c:1213:3: error: unknown type name '__yo_dyn_box_unknown_'
 1213 | } __yo_dyn_box_unknown_*(struct_decl_main_Cat_r0c7_i32);
```

## Where to look

The legacy auto-box (`evaluate_dyn_value`'s auto-box arm, `src/evaluator/values/dyn.yo`) boxes the pointer as the
payload, and the dyn box functions (`generate_dyn_box_functions`, `src/codegen/functions/dyn.yo`) build the box's
C name from the payload type's name without the pointer arm, so `*(Cat)` lands in an identifier
(`__yo_dyn_box_unknown_*(…)`). Decision 49 retires this form: in v0.2.78 `dyn(p)` over a raw pointer unsizes it to a
`*Dyn(...)` (VERDICTS-43 §1), and `--migrate unsized` lists every such site. Either fix the box name until then or
reject the form with the VERDICTS-43 §1 message; the reproducer becomes a run row or a `comptime_expect_error` row in
`tests/dyn.test.yo`.
