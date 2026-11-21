# A type-qualified call through a blanket bound at `T := &U` passes check and emits invalid C

**Severity:** S2: `yo check` accepts the program and codegen emits a C call passing one indirection too many, so the C compiler rejects it with an unrelated-looking pointer-type error (clang and gcc 14 both treat it as an error; no silently wrong binary was observed).

Found 2026-11-21 while gating the blanket `Hash(&T)` / `ToString(&T)` riders (branch `v0280/ref-blankets`). Pre-existing: the reproducer below uses only a user trait and a user blanket and fails identically on the v0.2.79 seed. The std riders make it easier to reach — once `&U <: ToString` / `&U <: Hash` hold through std, any generic body that spells the call the natural way walks into it.

## Reproducer

```yo ignore
{ String } :: import("std/string");
Show :: trait(show : (fn(self : &Self) -> String));
impl(String, Show(show : (fn(self : &Self) -> String)(self.*.clone())));
impl(
  generic(T : Type),
  where(T <: Show),
  &T,
  Show(show : (fn(self : &Self) -> String)(T.show(self.*)))
);
_use :: (fn(generic(T : Type), r : &T, where(T <: Show)) -> String)(T.show(r.*));
export(main);
main :: (fn() -> unit)({
  s := String.from("abc");
  rs := &s;
  u := _use(&rs);   // T := &String through the blanket
});
```

`yo check` passes ("evaluator OK", on the seed and on the blanket branch). `yo compile` emits C that the C compiler rejects:

```text
/tmp/….c:2988:103: error: passing argument 1 of ‘__yo_fs_…’ from incompatible pointer type
__yo_fs_…((&(__yo_v_r)));
             ~^~~~~~~~~~~
               const …_struct *** (expected …_struct **)
```

The emitted argument is `&r` — the address of the parameter — where the parameter wants the reference itself (`r`, i.e. `r.*`'s referent chain); exactly the lend the E0601 in
`issues/2026-11-21-a-reference-binder-whose-type-is-the-methods-own-slot-is-lent-once-too-often.md`
asks to undo, applied here as a silent rewrite of a written `r.*`.

## Root cause (not yet traced)

At `T := &String` the argument `r.*` (a deref of the `&&T` parameter, value type `&String`) is rewritten to `&r` somewhere between the evaluator's acceptance and the emitter — the reference-argument-as-referent rewrite (VERDICTS-49 gap 4 family) applied at one indirection too many. The evaluator's model and the emitted expression disagree, which is why check is green and the C is wrong.

## Fix

Make the rewrite agree with the slot: at `T := &U` the qualified call's `r.*` argument must lower to the reference itself, not `&r`. Test: the reproducer above compiles, links and prints the referent's rendering; with the std riders landed, a `where(T <: ToString)` helper written in this spelling is the user-visible row.
