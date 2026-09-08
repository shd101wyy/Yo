# A generic fn's forall stays `unknown` when its argument is a METHOD CALL, minting an abstract spec the emitter skips

**Status:** open — root-caused, NOT fixed. Needs dedicated evaluator work.
**Found:** 2026-09-08, writing the Core-numerics tests
**Supersedes:** `generic-impl-method-result-passed-directly-to-a-generic-fn-fails-to-transpile.md`,
whose stated cause was WRONG (see "Corrections" below).

## Reproducer (5 lines, no std beyond the prelude)

```rust
impl(i32, wrap : (fn(self : i32) -> Option(i32))(Option(i32).Some(self)));
_take :: (fn(generic(U : Type), o : Option(U)) -> bool)(match(o, .Some(_) => true, .None => false));
_probe :: (fn(x : i32) -> bool)(_take(x.wrap()));
main :: (fn() -> unit)({ _p := _probe(i32(1)); });
export(main);
```

`_probe` compiles to an `abort()` stub. In `main` it is instead the fatal
"Failed to transpile part of main's body".

## Isolation

| argument form | result |
| --- | --- |
| `_take(x.wrap())` — METHOD call | **FTT** |
| `_take(i32.wrap(x))` — same method, UFCS | OK |
| `_take(_mk(x))` — free fn returning `Option(i32)` | OK |
| `o := x.wrap(); _take(o)` — via a local | OK |
| `_take(x.wrap())` where `_take`'s param is a bare `U`, not `Option(U)` | OK |

So BOTH halves are required: the callee generic over a **type-constructor
application** (`Option(U)`), and the argument written as **method-call syntax**.
Neither alone fails. The generic impl is NOT involved — a plain
`impl(i32, ...)` reproduces it.

## Mechanism (measured, not guessed)

With `YO_DEBUG_SWALLOW=1`:

```
[trial] v.yo:3:23 → [flow-post] out=1          ← _probe's body evaluates FINE
[abstract-spec] fid=yo_id_4101_unknown_rtparam0_enum_yo_id_4100_value_1688_ret_bool
                sig=fn(o : <enum:enum_yo_id_4100>) -> bool
```

1. `_probe`'s body does NOT fail definition-time evaluation — `out=1`. **The
   stub's "definition-time evaluation failed and was swallowed" message is
   misleading for this class**, and cost an hour of chasing swallow logs.
2. The forall `U` resolves to the literal string `unknown` in the compile-time
   signature (`calls/helper.yo:1300-1330` — it looks the generic label up in
   `callee_env` and falls back to `"unknown"`), so `U` was never bound.
3. The argument's own runtime key is `enum_yo_id_4100_value_1688` — the
   **generic-era `Option`** with a SomeT payload, not `Option(i32)`.
4. That mints an **abstract-keyed** specialization. Codegen deliberately skips
   emitting such a spec while the call site still emits a call to it
   (`calls/function.yo:2511` and its comment: *"an abstract-keyed spec is
   skipped by the emitter while its call site still emits"*), leaving the
   `// Failed to transpile` marker that becomes the stub.

## Where it is NOT

`check_if_function_parameter_matches_argument` (`calls/helper.yo:636`) is where
Step 6 synthesizes generic bindings from the argument type. **It is never called
for `_take`'s `o` parameter in either the failing or the working form** —
verified with `YO_DEBUG_PARAMCHECK=1`, whose 1805-line traces for the two
programs differ by exactly ONE line (the extra `label=self` receiver check of
the method form). So the binding of `U` happens on the deferred-generic
specialization path, not the param-matching path, and that is where the fix
belongs.

## Corrections to the earlier issue

- "a generic-impl method's result" — WRONG, a non-generic `impl` reproduces it.
- "`evaluate_function_call: TypeVal SomeT callee without FnTrait (Phase 4)`" —
  WRONG, that swallow came from an unrelated prelude specialization; against a
  std without the `Integer` impl the stub appears with no such error.

## Why it is not fixed here

The binding happens inside the deferred-generic specialization path. A
speculative patch there changes specialization KEYS, which every `std` emission
depends on — the failure mode of getting it wrong is a silently different
specialization, not a compile error. It needs its own change with the fixpoint
and byte-identity gates run against it, not a fold-in to an std batch.

**Not worked around in std**: no std code hits this shape. The Core-numerics
tests use an inline `match`, which is the idiomatic form there regardless.
