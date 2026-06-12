# Soundness residual: indexed/deref ref-arg into a container that escaped to a global

**Status: FIX IN PROGRESS — runtime borrow-flag backstop (Swift's model).**
Decided 2026-06-12 to close completely via a runtime exclusivity flag
(after a benchmark proved ~0% time / 0 bytes memory — same-cache-line
load + predicted branch). **Foundation landed (commit 0ca4b7784):**
`uint16 borrow_count` in the RC header (free, in existing padding), init,
and the `__yo_borrow_acquire/release/assert_unborrowed` runtime
primitives. **Remaining (scheduled for the codegen-port RC phase, see
`plans/BOOTSTRAPPING_CODEGEN.md`):**
1. assert `borrow_count == 0` at container growth-method entry
   (push/insert/reserve/resize on ArrayList/HashMap/String);
2. `acquire`/`release` bracketing the interior-ref-arg call sites the
   static rule allows — the release MUST be unwind-safe (survive an
   effect-unwind through the borrowed call), which requires the
   deferred-cleanup machinery the RC phase reworks. Building it on the
   current runtime would duplicate that machinery and risk a stuck
   counter (→ spurious panics, worse than the residual), so it is
   sequenced into the port rather than bolted on first;
3. yo-self mirror of 1+2.

Until 1+2 land, the residual below remains (exotic; not reachable by
ordinary code).

## The shape (confirmed UAF, rc=139 under gmalloc, 5/5)

```rust
g_outer := ArrayList(ArrayList(i32)).new();      // module-level
grow_global :: (fn() -> unit)({
  inner := match(g_outer.get(usize(0)),.Some(x) => x,.None => ArrayList(i32).new());
  i := usize(0);
  while(i < usize(64), { inner.push(i32(0)); i = (i + usize(1)); });   // realloc
});
bump :: (fn(ref(v) : i32) -> unit)({
  grow_global();        // reaches g_outer (a GLOBAL), grows the inner list
  v = i32(99);          // writes into the freed buffer
});
main :: (fn() -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(41));
  g_outer.push(xs);     // <-- xs ESCAPES into a global heap structure
  bump(xs(usize(0)));   // element-only call (no other reaching arg) → ALLOWED
});
```

## Why the element-only rule misses it

`requireValidRefArgumentPlaces` rejects `xs(i)` as a ref argument when the
container `xs` is reachable by the callee — via another argument
(object/closure/pointer), an alias, or `xs` being module-level. Here the
call `bump(xs(0))` has no other reaching argument and `xs` is a local, so
the rule allows it. But `xs` was earlier stored into the module-level
`g_outer` (`g_outer.push(xs)`), so the callee reaches it through the
global. Detecting that requires whole-program escape analysis — exactly
the complexity v4.1 deliberately shed.

## What IS closed (the realistic vectors)

All of these are rejected (both compilers) — audit probes P1–P8:
- `f(xs(i), xs)` / alias / module-level container;
- `f(xs(i), closure_capturing_xs)`;
- `f(xs(i), wrapper_object)`;
- `f(box.*.n, box)`;
- method receivers (`xs(i).m(xs)`), nested containers;
- `f(o.s, own(o))` (ref/own gate).

## Options considered (decision: #2)

1. **Flow-sensitive escape bit** — REJECTED. Sound and zero-runtime, but
   reintroduces escape tracking (fragile: a missed escape site = silent
   UAF) and over-rejects read-only element access after any escape.
2. **Runtime borrow flag** (Swift-style) — **CHOSEN.** A counter in the RC
   header, asserted on container growth; turns the residual into a
   deterministic panic. Benchmark-confirmed ~0% time / 0 bytes memory
   (same-cache-line load + predicted branch), so it does not meaningfully
   conflict with the zero-overhead goal. Foundation landed (see Status);
   completion in the codegen-port RC phase. This is exactly what Swift
   does for shared-reference/global storage it can't prove statically.
3. **Document + accept** — superseded by #2; the shape is contrived
   (store a local into a global, then index-ref it while a callee grows
   it via the global), so it is harmless until #2 completes.

Tracked for the codegen-port era; does not block it.
