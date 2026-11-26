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

## Fix

VERDICTS-77 (lane `v81-v77`, two stacked PRs: the `type_key` rendering, then substitution and the registries).

- **Substitution re-ties the back-edge** (`src/types/substitution.yo`, `_subst_shell`). At a self-shell,
  `substitute` maps the shell's list (the images of its final's recorded type arguments, then of the
  final's type variables those do not mention) and returns the shell carrying the new list. The final
  under the same substitution is registered once per (shell id, list) in `g_shell_subst_finals`
  (`src/types/creators.yo`), and `resolve_enum_shell` / `resolve_struct_shell` read it, so the
  self-reference inside `GKind(T)[T := i32]` is `GKind(T)[T := i32]`, not `GKind(T)`. A struct's
  registry final records no arguments, so the comptime-fn call site stamps them by id
  (`stamp_struct_final_type_arguments`).
- **One key for the two presentations.** `type_key` renders a recursion cut and an enum past its
  depth cap as `rec:` + declaration identity + argument keys instead of the instance id; a
  recursive enum's pre-final reads its final's recorded arguments (it is the same instance) for its
  node and its substituted copy records them; a generic struct instance's cut renders as its full
  `gs_` key. The CTFE memo compares a substituted shell by what it resolves to.
- **Only a recursive enum is a node of the cut.** `type_key`'s cycle guard pushed every enum
  instance by (id, type arguments), so a non-recursive instance around a recursive type
  (`Option(Rc(N))`, a field of `N`) cut at different depths depending on whether the walk entered
  through a substituted copy (def-era id) or the constructor's instance (its own id). The enum
  definition records whether a payload held the self-shell (`mark_enum_recursive`), and only those
  enums are guard nodes. `YO_DEBUG_SELF_PATTERN_CHECK=1` (at `fmg_spec_ty`, `_is_self_pattern`
  bypassed: the substituted receiver pattern against the receiver, by key and exact compatibility
  both ways) counted 258 such mismatches over `check ./src` before this and 0 after; 0 over
  `check ./std` either way.
- **Exact struct identity** no longer rejects two instances of one constructor whose stamped names
  differ (`Box(<struct:…n0>)` against `Box(<struct:…n2>)`): the type arguments decide, as in the
  lenient rule. This was the struct twin's E0605.

Every row of the table above now compiles and runs, plus the verdict's p3/p5/p6/p7 probes, a
six-deep `Option` nesting and an origin-parameter holder (`tests/recursive-enum.test.yo`, "Substituted
recursive instance"), including the `Option(Box(Self))`, `ArrayList(Self)` and `Rc(Self)` payload rows.
The untyped literal's `rhs` still is not recognized as the receiver
pattern; it no longer needs to be.
