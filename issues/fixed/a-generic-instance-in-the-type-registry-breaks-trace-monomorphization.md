# A generic instance in the type registry breaks `trace` monomorphization

**Status:** FIXED 2026-09-11 — `collect_trace_methods_from_generic_impls`
(`src/codegen/functions/collection.yo`).
**Supersedes:** `issues/fixed/an-arraylist-of-a-waker-like-ref-loses-its-tracer-inside-std-async-channel.md`,
which reported the symptom and bisected it correctly but named the wrong
object — see "What the earlier report got wrong" below.

## Symptom

Rewriting `std/async/channel.yo` over wakers (`plans/WAKER_BASED_SCHEDULING.md`
stage 3b) made `ArrayList(T)`'s `Trace` impl fail to evaluate, in a file the
change never touched:

```
error: No matching call found with arguments:
(base.add)(i)
    --> std/collections/array_list.yo:862:30
    |
862 |             tracer.visit(base.add(i));
```

`base` comes from `match(self._ptr, .Some(base) => …)`, so it is `*(T)`, and
`add` is an unconstrained blanket impl on `*(T)` in the prelude. It resolves
everywhere else.

## Root cause

`collect_trace_methods_from_generic_impls` force-specializes the `trace` method
of every reference-semantics type in the codegen type registry — `trace` has no
call site, so nothing else would. It took every registered ref struct/enum as a
candidate, and **a GENERIC instance can be in that registry**: `is_registerable`
(`codegen/types/collection.yo`) deliberately admits a struct whose SomeType
content sits behind function-typed fields.

Instrumenting the collector shows exactly that, and shows why the async `Mutex`
— the same `ArrayList(Waker)` field, the same park — does not hit it:

```
channel:  ct=ArrayList(Waker)  cap T = Waker     ✓
          ct=ArrayList(u8)     cap T = u8        ✓
          ct=ArrayList(T)      cap T = T         ✗ generic instance
mutex:    ct=ArrayList(u8)     cap T = u8        ✓
          ct=ArrayList(Waker)  cap T = Waker     ✓        (no third entry)
```

For the generic entry the impl's own `T` is bound to itself, so the body is
re-evaluated with the element type unresolved, and the first thing it does with
an element — `base.add(i)` on a `*(T)` whose `T` is an unresolved SomeT — finds
no method. The two CONCRETE instantiations either side of it specialize
perfectly; the error names `ArrayList` only because that is where the generic
body lives.

## Fix

Monomorphizing a type that is not monomorphic is meaningless, so the collector
now takes concrete candidates only:

```rust
if((is_reference_struct_type(ty) || is_reference_enum_type(ty)) && !type_contains_some_type_deep(ty), {
  type_list.push(ty);
});
```

Nothing is lost by skipping it: the traversal generators look a trace function
up by the CONCRETE container's `type_key` (`get_trace_function_for_type`), so a
monomorphization keyed on a generic instance could never be called.

## What the earlier report got wrong

The earlier issue concluded that "`ArrayList(Waker)`'s `Trace` is being
instantiated with the element type still bound to `ArrayList`'s own generic
parameter" — the stale-substitution family. That is not what happens:
`ArrayList(Waker)` specializes correctly, in the channel exactly as in the
mutex. The failing instantiation is a THIRD, generic one that only the channel
puts in the registry. The probe that produced the "two different `T`s that print
identically" error was reading that third entry.

The bisection in that report was sound and is what made this quick to find: the
fields alone are fine, a park in `send`/`recv` is what adds the entry, and the
sync-only path never reaches the collector.

## Regression test

`tests/async/channel.test.yo` — the waker-based `Channel` is itself the
reproducer, and it does not compile without the guard. Verified red-first: with
the patched `std/async/channel.yo` and an unguarded compiler the error above is
raised at `array_list.yo:862`; with the guard the same tree compiles, runs, and
`tests/async` is 73/73.
