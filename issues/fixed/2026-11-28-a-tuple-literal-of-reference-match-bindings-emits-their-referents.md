# A tuple literal of reference match bindings emits their referents: `(a, b)` over `.Some(a)` of an `Option(&String)` is invalid C

**Severity:** S2 — a program the evaluator accepts fails in the C compiler: a tuple literal whose element is a match binding of a reference payload (`.Some(a)` over `Option(&U)`, a generic `A := &U`) writes the referent `(*a)` into the tuple's pointer field.

Filed 2026-11-28 by the `v81-s1` lane (STD_RUST_ALIGNMENT S-1): replacing `IterPair(A, B)(_0 : a, _1 : b)` with the tuple
`(a, b)` in `IterZip.next` / `IterEnumerate.next` made every zip or enumerate of borrowed walks
(`(&xs).into_iter().zip((&ys).into_iter())`) fail to compile (`tests/for-read-walk.test.yo`). The struct constructor
was right: it keys on the evaluator's recorded lend (`_lend_field_addr`).

## Reproducer

`issues/repros/2026-11-28-a-tuple-literal-of-reference-match-bindings-emits-their-referents.yo`:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
pair_up :: (fn(generic(A : Type), x : Option(A), y : Option(A)) -> Option(Tuple(A, A)))(
  match(
    x,
    .Some(a) => match(
      y,
      .Some(b) => .Some((a, b)),
      .None => .None
    ),
    .None => .None
  )
);
main :: (fn() -> unit)({
  s := String.from("ab");
  t := String.from("cde");
  p := pair_up(Option(&String).Some(&s), Option(&String).Some(&t));
  match(p, .Some(q) => println(`${q.0.len()} ${q.1.len()}`), .None => println("none"));
});
export(main);
```

```text
tmp/tup.c:2811:113: error: initializing 'const __yo_t_380057191393874787 *' (aka 'const struct __yo_t_15255868433470720360_struct *') with an expression of incompatible type '__yo_t_380057191393874787' (aka 'struct __yo_t_15255868433470720360_struct'); take the address with &
  ... = (__yo_t_17431648703733402783){ ._0 = (*__yo_v_a), ._1 = (*__yo_v_b) };
```

## Root cause

The match binding's C local is the reference itself (`String* __yo_v_a = …payload`), and its atom read is the place
`(*__yo_v_a)` (`atom_read_is_referent_place`). `_build_tuple` (`src/codegen/exprs/tuple-fn.yo`) took the address of a
reference element only for a recorded lend or an R-TAIL chain leaf (`is_chain_ref_binding_leaf`); for any other `&U`-typed
operand it trusted `reference_operand_is_value` and emitted the read as the pointer, which for such a binding is the
referent.

## Fix

`_build_tuple` treats an atom whose read is its referent place (`atom_read_is_referent_place`, the predicate
`_reference_value_at_own_slot` already uses) like a chain leaf: its address, `&((*a))`, is the pointer. Test:
`tests/iterator-combinators.test.yo`, "a tuple of reference match bindings holds the references" (the generic pair and a
`zip` of two borrowed walks), and `tests/for-read-walk.test.yo`'s "zip and enumerate of borrowed cursors, then filter",
which failed in clang before the fix.
