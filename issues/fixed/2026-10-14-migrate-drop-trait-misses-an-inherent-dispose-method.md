# `yo fix --migrate drop-trait` says nothing about an inherent `dispose` method that Generation A ran as the destructor

**Severity:** S2 — after decision 45's Generation B, a reference type whose
"destructor" is an inherent method named `dispose` silently stops releasing
its resource (a leak, an fd or lock never released), and the migration that
is supposed to carry user code across reported nothing.

**Status:** Fixed (v0.2.64, decision 45 Generation B). Found while running the
repair over the tree: `tests/atomic_object.test.yo` had exactly this shape.

## Symptom

```yo
{ println } :: import("std/fmt");
R :: ref(struct(id : i32));
impl(R, dispose : (fn(self : &Self) -> unit)(println(`dispose ran for ${self.id}`)));
main :: (fn() -> unit)({
  {
    r := R(id : i32(1));
    println(`made ${r.id}`);
  };
  println("after scope");
});
export(main);
```

Built by the develop compiler (Generation A) it prints `made 1`,
`dispose ran for 1`, `after scope`: the codegen's `_destructor_method_name`
(`src/codegen/functions/collection.yo`) found a destructor by the method name
`dispose` alone, whatever declared it, so an inherent method served as one.
Generation B recognizes only `Drop`'s `drop`, so the same program prints no
`dispose ran` line, and `yo fix <path> --migrate drop-trait` rewrote nothing
and listed nothing: the method is neither a `Dispose(...)` impl entry nor a
`.dispose` member.

## Root cause

`_dtm_walk` (`src/main.yo`) looked only at `Dispose` names, the entries of a
`Dispose(...)` impl or trait definition, and `.dispose` members. An inherent
impl entry `impl(T, dispose : ...)` matched none of them.

## Fix

`_dtm_walk` lists each inherent `dispose` impl entry for a hand edit ("an
inherent `dispose` method, which Generation A ran as the destructor: move it
into a `Drop(drop : (fn(self : &mut Self) -> unit)(...))` entry"); a span
edit cannot move it into a trait entry. The summary's count is now "site(s)
left for a hand edit". `tests/atomic_object.test.yo` gives `AtomicResource` a
`Drop` impl.

## Test

`tests/cli-cases/fix-migrate-drop-trait`: `inherent.yo`'s
`impl(Pool, dispose : ...)` is now listed in the `fix inherent.yo` stdout
golden, which fails before the fix (no such line).
