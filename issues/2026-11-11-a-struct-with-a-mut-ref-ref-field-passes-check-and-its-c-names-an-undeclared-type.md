# A struct with a `&mut &T` field passes check and its C names an undeclared type

**Severity:** S2. `M :: struct(rp : &mut &String)` with `m := M(rp : &mut r)` passes `yo check`, and `yo compile`
fails in the C compiler: `error: unknown type name '__yo_t_…'` at the field. The build stops, so nothing runs
wrongly, but a program the checker accepts cannot be built. Only a newtype referent (`String`) fails; the same holder
over `&mut &Rc(X)` compiles. New this cycle: v0.2.76 rejects the type itself; P3 (#1841, `&&T` and
`&mut &T`) made it expressible.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 B4). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-struct-with-a-mut-ref-ref-field-passes-check-and-its-c-names-an-undeclared-type.yo`
(positive: must check, compile and print `OUT: 1`):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
M :: struct(rp : &mut &String);
main :: (fn() -> unit)({
  a := String.from("a");
  mut(r) := &a;
  m := M(rp : &mut r);
  println(`OUT: ${m.rp.*.*.len().to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: rejected (the field type)
$ yo compile repro.yo --optimize 1 --cc clang -o t
t.c:820:3: error: unknown type name '__yo_t_17030455559196638567'
  __yo_t_17030455559196638567 const * * __yo_v_rp;
```

The ledger suspected an unsound shape behind the C failure (a re-point through the field). It does not need this
fix to show: with an `Rc(X)` referent the C compiles, and `m := M(rp : &mut r); m.rp.* = ri;` with a block-local
`inner` is accepted and reads `inner` after its scope (stack-use-after-scope). It is filed with the store-through-a-
borrow family as
`issues/repros/2026-11-11-a-store-through-a-local-mut-borrow-of-a-holder-does-not-widen-the-holders-flow-set-ref-ref-field.yo`
(`issues/2026-11-11-a-store-through-a-local-mut-borrow-of-a-holder-does-not-widen-the-holders-flow-set.md`).

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `struct(rp : &mut &String)`, constructed and read | check OK, C compile fails | compiles, `OUT: 1` |
| the same, re-pointing `r` through `m.rp.* = rb` inside one scope (ledger) | check OK, C compile fails | compiles, runs |
| `struct(rp : &mut &Rc(X))`, re-point at a block-local, read after | compiles; stack-use-after-scope (filed, above) | E0911 |
| a tuple `(&mut r, i32(0))` re-pointed through `t.0.*` at a block-local (ledger) | E0923 | E0911 or E0923 |
| a parameter `dst : &mut &(T, p)` | compiles and runs | — |

## Root cause

Verified in the source and the emitted C. The struct's C declaration names the referent's newtype typedef
(`String` lowers to `typedef __yo_t_… __yo_t_17030455559196638567;`), which is emitted about 90 lines AFTER the
struct. Declaration order comes from the type dependency walk: `_walk_by_value_dep`
(`src/codegen/types/generation.yo`) gives a reference field an edge to its referent's newtype
(`_pointee_spelling_newtype(&ref_pt)`) so the struct follows the typedef. It looks one level deep: for
`&mut &String` the referent is `&String`, a reference, not a newtype, so no edge is added and the struct can be
emitted before `String`'s typedef. (Why the parameter form compiles is not checked here; prototypes are
presumably emitted after every type declaration.)

## Expected

The positive program compiles and prints `OUT: 1`: P3 accepts `&mut &T` wherever a reference type may stand
(`BORROW_CHECKER_COMPLETENESS.md` §7 P3: "`&mut r` on a `mut(r)` binding is `&mut &T`"), and a struct field is
one (N2b's inline composites). The dependency walk peels every reference level before asking for the newtype.

## Test

With the fix: the positive program moves to `tests/` as a codegen case (`tests/ref_binding.test.yo` or a new
`ref-of-ref-field` row in `tests/origins/corpus.tsv`, ACCEPT), with a `String` referent so the ordering is
exercised.
