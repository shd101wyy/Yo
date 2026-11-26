# A generic container's method result is typed by whichever instance looked the method up first

**Severity:** S1 (safe code compiles to a use-after-free: ASan reports stack-use-after-scope).

**Status:** FIXED (branch `fix/p12-t6-static-store`, 2026-11-25). Found 2026-11-25 by the p12-t6 lane on develop
`1175c046c`, in the audit the coordinator asked for: which readers consult a specialized method's types that the
static bit should distinguish. P12 (#2082) split `Box1(&X)` and `Box1(&(X, static))` into two instances, and made
`static` spellable in safe code.

## The repro

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
Box1 :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(v : Option(T))
);
impl(
  generic(T : Type),
  Box1(T),
  get : (fn(self : &Self) -> Option(T))(self.v)
);
G := X(s : String.from("g"));
Keep :: struct(r : Option(&(X, static)));
main :: (fn() -> unit)({
  a := Box1(&(X, static))(v : .Some(&G));
  _s := a.get();
  mut(k) := Keep(r : .None);
  {
    x := X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
    b := Box1(&X)(v : .Some(&x));
    k.r = b.get();
  };
  match(k.r, .Some(r) => println(`OUT: ${r.*.s.len().to_string()}`), .None => println("none"));
});
export(main);
```

`yo check` accepts it, and the ASan build reports `stack-use-after-scope`. Without the two lines over `a`, the store
`k.r = b.get()` is E0923 ("the value holds `b`").

## Root cause

`find_methods_from_generic_impls` caches its candidates under `_fmg_cache_key` (`src/evaluator/values/impl.yo`): the
receiver's `type_key`, the method name and the owner. `type_key` leaves out every origin, the static bit included,
so after `a.get()` the lookup for `b.get()` returned the static instance's specialized `get`, whose result is
`Option(&(X, static))`. A read typed over `static` is a static value (VERDICTS-74 rule 3), so the field write's static
check passed. With the cache bypassed (`YO_DEBUG_WARM=1`, which turns it off) the same program is E0923: the scan
itself specializes per instance, through the CTFE memo P12 made static-aware.

## The fix

`_fmg_cache_key` appends the receiver's static bits (`static_origin_marks_text`, `src/types/utils.yo`, the walk
`static_origin_marks_differ` already compares). The fast path compares handles, which already differ between the two
instances.

## The test

`tests/origins/unsound/generic-method-result-shared-instance.yo` (the repro, `// expect: E0923`), and a
`comptime_expect_error` row in `tests/unsized-places.test.yo` (`_UpBox1(&_UpX).get()` stored in a static field after
`_UpBox1(&(_UpX, static)).get()`).

## What this does not cover

A method whose type parameter its arguments bind (`put(self : &mut Self, v : T)`) still shares one specialization
between the static and the elided receivers, with the cache bypassed as well (`YO_DEBUG_WARM=1` on the
`issues/fixed/2026-11-25-a-generic-containers-elided-instance-skips-…` repro still shows the static `self` slot),
so that sharing sits below this cache: `issues/2026-11-25-a-by-argument-method-specialization-shares-its-self-slot-across-the-static-and-elided-instances.md`. `lend_through` reads the lent argument's own type for the static store check and for step 3's solve
(`issues/fixed/2026-11-24-a-generic-containers-method-stores-a-local-reference-into-a-static-instantiated-receiver.md`,
`issues/fixed/2026-11-25-a-generic-containers-elided-instance-skips-its-store-check-after-the-static-instance-specialized-the-method.md`).
