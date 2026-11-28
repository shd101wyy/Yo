# A generic impl member's type-constructor call is substituted, not re-evaluated, so a constructor that branches on its argument gets the other branch

**Kind:** design question — filed 2026-11-25 by lane `v81-v77` from VERDICTS-77 §8 item 4 (read-only audit; the probe below confirms it).

## The question

A generic impl's member type is computed once, at definition time, with the impl's binders as type
variables, and specialized per receiver by `substitute` (`find_methods_from_generic_impls`,
`src/evaluator/values/impl.yo`). That is exact when every type constructor in the signature maps
its argument structurally. A constructor that branches on its argument is evaluated once with the
argument abstract, so it takes the branch an abstract argument selects, and substitution cannot
re-run the branch for the concrete one:

```yo
{ println } :: import("std/fmt");
Sel :: (fn(comptime(T) : Type) -> comptime(Type))(cond(Type.eq(T, i32) => struct(a : i64), true => struct(a : T)));
Pair :: (fn(comptime(T) : Type) -> comptime(Type))(struct(p : T));
impl(
  generic(T : Type),
  Pair(T),
  read : (fn(self : &Self, s : &Sel(T)) -> bool)(true)
);
main :: (fn() -> unit)({
  p := Pair(i32)(p : i32(1));
  s := Sel(i32)(a : i64(7));
  println(p.read(&s));
});
export(main);
```

`yo check` (develop `8da9761d1`, and the VERDICTS-77 tree):

```text
error[E0601]: Cannot unify incompatible types: "i32" and "i64"
   --> q4branch.yo:12:19
   |
12 |   println(p.read(&s));
   |                   ^
```

`Sel(T)` at definition time is `struct(a : T)` (`Type.eq(T, i32)` is false for a variable), and
`T := i32` turns it into `struct(a : i32)`, which is not `Sel(i32)` (`struct(a : i64)`). A generic
free function taking `&Sel(T)` is accepted, because its argument is inferred from the call instead.

Two answers:

- **A: substitute** (today). Exact for structural constructors; wrong for one that inspects its
  argument (`Type.eq`, `Type.impls`, a `sizeof` branch).
- **B: evaluate.** Re-evaluate a member signature's constructor calls at the concrete arguments
  when the impl specializes, through the CTFE memo, as a direct call would.

## Recommendation

B, not before v0.2.82. Substitution stays the fast path for constructors whose definition-time
trial shows no branch on an argument; a constructor that does branch is re-evaluated at
specialization. VERDICTS-77 (substitution re-ties a recursive instance's back-edge) is independent
of this and does not change it.
