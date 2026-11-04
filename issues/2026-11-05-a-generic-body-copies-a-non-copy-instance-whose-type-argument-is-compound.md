# A generic body implicitly copies a non-`Copy` instance whose type argument is compound

**Severity:** S3: an invalid program is accepted. Inside an instantiated generic body, a value of a generic type without `Copy` (here `_E(Option(V))` at `V := i32`) copies implicitly, while the same copy in concrete code is E0901. The value is plain data, so the copy is bitwise-safe, but decision 36's flip is not enforced there.

Found 2026-11-05 while fixing `issues/fixed/2026-11-05-a-hashmap-of-a-plain-data-struct-without-copy-cannot-insert.md`, on develop `304e8ecf2` plus that fix.

## Reproducer

```yo
_E :: (fn(comptime(T) : Type) -> comptime(Type))(enum(A(x : T), B));
_N :: (fn(comptime(V) : Type) -> comptime(Type))(struct(tag : u8));
impl(
  generic(V : Type),
  _N(V),
  mk : (fn(self : &Self, v : V) -> _E(Option(V)))(.A(x : .Some(v))),
  twice : (fn(self : &Self, v : V) -> bool)({
    r := Self.mk(self, v);
    a := r;
    b := r; // accepted: `r` was moved by `a := r`
    match(a, .A(_) => true, .B => false) && match(b, .A(_) => true, .B => false)
  })
);
main :: (fn() -> unit)({
  n := _N(i32)(tag : u8(0));
  _ := n.twice(i32(1));
  r := _E(Option(i32)).A(x : .Some(i32(1)));
  a := r;
  b := r; // E0901: use of moved value: `r`
});
export(main);
```

`yo check repro.yo --test-bodies` reports only the copy in `main`.

## Root cause

- An instantiated enum keeps a compound type argument in its definition-era spelling. `substitute` rewrites an enum type argument only when it is a bare variable or sits at a phantom position (`src/types/substitution.yo`, the `EnumT` arm, a measured performance carve-out). So `_E(Option(V))` at `V := i32` carries the argument `Option(V)` with `V` open, while its payload is the concrete `Option(i32)`.
- An impl query binds the impl's parameter to that open variable, so the flip cannot ask `Copy` of the type (`type_lacks_copy_for_flip`). It judges such a type by its parts instead (`_flip_part_lacks_copy`). That catches a part without `Copy`, but not a nominal type without `Copy` whose parts all copy, as here.

## Fix direction

Refresh an instantiated enum's compound type arguments where the instance is built, so a trait query sees the concrete instance. The substitution's node memo may now make that cheap: the argument and the payload are often one node. The carve-out's 25-minute measurement predates the memo.

## Status

Open. The reproducer above is the test to add with the fix.
