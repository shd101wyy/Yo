# A generic impl member whose signature names a recursive generic type instance emits mismatched C types

**Severity:** S2 — a valid program (a generic impl member whose signature spells a recursive generic type, such as `GKind(T)` where `GKind(T)` holds a `Box(Self)` payload, instead of `Self`) passes `check` and then fails in the C compiler with incompatible pointer types. The struct version of the same program is rejected by `check` with E0605.

- Filed: 2026-11-20 (fix-forward lane for develop battery 44642495937). Found while looking for a Case 2 (generic impl) twin of `issues/fixed/2026-11-20-a-forced-impl-member-s-phase-a-flag-is-lost-on-its-evaluation-copy.md`. It is not that bug: the v0.2.78 seed, before R7, fails the same way.
- Re-derived 2026-11-22 (lane `fix-box-self`) under the v0.2.79 seed and a tree binary built from develop `f06ff5889`. The first version of this document said the untyped literal was the trigger and a typed member compiled. That was wrong: the trigger is any parameter type spelled `GKind(T)` in a generic impl's member signature. The untyped literal only reaches it through the trait's `Rhs`.

## Reproducer

```yo
{ println } :: import("std/fmt");
GKind :: (fn(comptime(T) : Type) -> comptime(Type))(enum(Leaf(v : T), Node(elem : Box(Self))));
impl(
  generic(T : Type),
  GKind(T),
  Eq(GKind(T))(
    (==) : ((lhs, rhs) -> match(lhs, .Leaf(a) => match(rhs, .Leaf(b) => true, _ => false), .Node(l) => match(rhs, .Node(r) => true, _ => false)))
  )
);
main :: (fn() -> unit)({
  k := GKind(i32).Node(elem : Box.new(GKind(i32).Leaf(v : i32(1))));
  j := GKind(i32).Node(elem : Box.new(GKind(i32).Leaf(v : i32(1))));
  println(k == j);
});
export(main);
```

`yo compile` (v0.2.78, v0.2.79, and develop `69f09baf4` and `f06ff5889`):

```text
error: incompatible pointer types initializing '__yo_t_14231802450936743744 *' (aka 'struct __yo_t_5576353772928820833_struct **') with an expression of type '__yo_t_7794407632329119377 *' (aka 'struct __yo_t_1660586658762785880_struct **')
error: incompatible pointer types passing '__yo_t_1660586658762785880 *' ... to parameter of type '__yo_t_5576353772928820833 *'
yo: error: compile: C compiler failed (exit 1)
```

## Which spellings fail

| Member | Result |
| --- | --- |
| `(lhs, rhs) -> …` (the reproducer; `rhs` takes the trait's `Rhs = GKind(T)`) | C compiler error |
| `(lhs : &Self, rhs) -> …` | C compiler error |
| `(fn(lhs : &Self, rhs : &GKind(T)) -> bool)(…)` | C compiler error |
| `(fn(lhs : &GKind(T), rhs : &GKind(T)) -> bool)(…)` | C compiler error (three) |
| `(fn(lhs : &Self, rhs : &Self) -> bool)(…)` | compiles and runs |
| inherent `is_node : (fn(self : &GKind(T)) -> bool)(…)` | C compiler error |
| `impl(generic(T : Type), Pair(T), is_node : (fn(self : &Self, k : &GKind(T)) -> bool)(…))` | C compiler error |
| payload `ArrayList(Self)`, `Rc(Self)` or `Option(Box(Self))` instead of `Box(Self)` | C compiler error |
| payload `i32` (not recursive) | compiles and runs |
| a generic free function `(fn(generic(T : Type), lhs : &GKind(T)) -> bool)(…)` | compiles and runs |
| the struct twin `GS :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T, next : Option(Box(Self))))` with `has_next : (fn(self : &GS(T)) -> bool)(…)` | `check` rejects it: E0605 `Expected: GS(T)`, `Got: GS(i32)` |
| the same struct member spelled `self : &Self` | compiles and runs |

## Root cause

A generic impl's member type is computed once, at definition time, with the impl's `T` a type
variable, and specialized per receiver by `substitute` (`find_methods_from_generic_impls`,
`src/evaluator/values/impl.yo`: `fmg_spec_ty := substitute(&mut spec_s, &ftype)`). The member body
is then checked against the substituted parameter types. `Self` is exempt: `subst_set_self` maps the
exact receiver pattern to the concrete receiver, the memo's `GKind(i32)`. Every other spelling of
`GKind(T)` goes through the structural walk.

A recursive type is stored as two unrolled levels plus a registry back-edge. The final `GKind(T)`
holds `Box(<pre-final>)`. The pre-final holds `Box(<GKind(T)__self_shell>)`, an empty enum that
`resolve_enum_shell` maps BY ID to the registered final (`src/types/creators.yo`). `substitute`
rebuilds the two unrolled levels with `T := i32` and keeps the def-era id, but the shell has no
payloads to rewrite, so the back-edge still resolves to the final with `T` open. The result says
`GKind(i32)` at depth 0 and 1 and `GKind(T)` from depth 2 on. In the reproducer's C, `rhs` has
type `__yo_t_2474843297263469379` (`v : int32_t`, `elem : Box(5576…)`), `5576…` has `v : int32_t`
and `elem : Box(15281…)`, and `15281…` has `v : void*` (T open). These are three C types where
there should be one, `GKind(i32)` (`1660…`).

Even an exact walk would not give one C type. `type_key` (`src/types/type-key.yo`, EnumT arm)
cuts a recursive enum's expansion at an already-seen node and renders the cut as the instance's
`eid`. The substituted copy keeps the def-era id and `GKind(i32)` has its own CTFE id. Their field
parts differ at the cut, so the structural-signature dedup (`g_enum_sig_keys`) cannot merge them,
even though `plans/reference/TYPE_IDENTITY.md` makes them one type (same declaration, identical type
arguments, identical payloads).

The struct twin is the same back-edge. A struct shell shares its final's id and the registry
final keeps `T` open, so flow compares `GS(T)[T := i32]` with `GS(i32)` and finds `T` against
`i32` two levels down (E0605).

A separate question is why the untyped literal's `rhs`, typed by the trait's `Rhs = GKind(T)`,
is not recognized as the receiver pattern. The spec reads `fn(lhs : &GKind(i32), rhs : &GKind(T))`
(`YO_DEBUG_DISPATCH=1`, `[fmg-cand]`). This is not investigated. Fixing it would rescue only the
reproducer, not the other rows.
