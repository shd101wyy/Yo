# yo-self: ONE Bucket GC-tracer specialization shared across ALL Bucket instantiations

**Status:** OPEN (stage-2 family, 3 clang errors as of 2026-07-09; also a latent
wrong-offset tracing bug whenever two Bucket layouts happen to be
pointer-compatible).

## Symptom

Stage-2: `member reference base type 'size_t' is not a structure or union` in
`yo_id_12__struct_struct_yo_id_13636__...` — the tracer body traces an
Option-tagged `key` but the slot struct is `Bucket(usize, _)`. Before the
struct-self-shell fix (b5b43a604) the same root manifested as 5x "passing
incompatible type" at tracer call sites.

## Minimal repro (warnings, shared tracer, wrong-offset tracing)

```rust
open(import("std/string"));
{ println } :: import("std/fmt");
{ HashMap } :: import("std/collections/hash_map");

Node :: ref(
  struct(
    v : i32,
    next : Option(Self)
  )
);

main :: (fn(io : Io) -> unit)({
  m1 := HashMap(String, Node).new();
  m1.set(`a`, Node(v : i32(1), next : Option(Node).None));
  m2 := HashMap(usize, Node).new();
  m2.set(usize(7), Node(v : i32(2), next : Option(Node).None));
  x := match(m1.get(`a`),.Some(n) => n.v, .None => i32(0));
  y := match(m2.get(usize(7)),.Some(n) => n.v, .None => i32(0));
  println(x + y);
});
export(main);
```

`yo-self-bin compile` emits ONE `yo_id_12__...` Bucket tracer (called from BOTH
HashMap trace loops) + 3 incompatible-pointer warnings. TS emits per-instantiation
tracers and is clean.

## Root (probe-confirmed)

The inner `bucket.trace(tracer)` call during each HashMap-trace body re-eval
carries receiver arg_type = the SHARED GENERIC `Bucket(K, V)` TypeValue object,
so `compute_compile_time_signature` renders the identical degenerate sig for
every instantiation and the specialization cache + func-id collide.

TS cannot collide: per-instantiation FunctionValue objects carry their own
`specializedFunctionCaches`.

## Reverted attempts (both INERT)

Resolving the sig's runtime-param types via
`evaluate_function_parameter_type_again` against callee_env and caller_env —
substitution does not recurse into nominal struct types (by design, both
compilers). Concretization requires RE-INSTANTIATION of `Bucket(K, V)` with the
bound K/V (comptime-fn call) — the generic-instantiation type-identity
consistency critical path.

## Candidate fixes

1. Re-instantiate the receiver's generic instantiation at the inner-call site
   when its SomeT content is resolvable from the env (drive the comptime-fn
   cache — stable per-instantiation identity for free).
2. Port TS's FuncVal-attached per-instantiation specialization caches.

## Probe kit

- `[SPEC-MISS/HIT]` at create_specialized_function_inline's cache lookup,
  guarded on any runtime param whose `type_key` contains `"<struct:"`.
- `[TRSPEC] ctkey/fid` in `_specialize_and_register_trace`
  (codegen/functions/collection.yo).

## Related

- `type_key` has NO Pointer arm — `*(T)` falls to the `type_to_string`
  catch-all (types/type_key.yo:270). Not sufficient for this family but worth
  aligning.
