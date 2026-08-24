# A generic struct instantiated over ITSELF gets two C type identities

**Status:** OPEN
**Found:** 2026-08-25, implementing `rev` for STD_API_AUDIT D3.4.
**Pre-existing:** yes — reproduced identically with the previous compiler
(develop before the D3.4 branch), so it is not caused by the routing-gate fix
that shipped alongside. `IterRev` is simply the first std adaptor whose own type
is a legal type argument to itself.

## Symptom

`x.rev().rev()` fails at the C compiler with two distinct structs for one
logical type:

```
error: initializing '__yo_t19' (aka 'struct __yo_t19_struct') with an expression
       of incompatible type '__yo_t11' (aka 'struct __yo_t11_struct')
  __yo_t19 _file____priv_temp_7587 =
      yo_id_3979_rtparam0_gs_yo_id_3539_gs_yo_id_17_i32_ret_gs_yo_id_3539_gs_yo_id_3539_gs_yo_id_17_i32(…);
```

Reading the mangled name: the function takes `IterRev(Range(i32))`
(`gs_3539(gs_17(i32))`) and returns `IterRev(IterRev(Range(i32)))`
(`gs_3539(gs_3539(gs_17(i32)))`) — which is correct. The defect is that the
CALL SITE recorded a *different* instantiation of that same type (`__yo_t19`)
than the one the function returns (`__yo_t11`).

## Reproducer

`issues/repros/nested-rev-identity-split.yo`:

```rust
out := array_list(i32(0));
(i32(0) .. i32(4)).rev().rev().for_each((x) => {
  out.push(x);
});
```

A single `.rev()` compiles and runs correctly (`[0, 4, 3, 2, 1, 0]` for
`0 .. 5`), as does `.collect(...)`. Only the self-nesting fails.

## Reading

`rev`'s declared return is `IterRev(Self)`. With a concrete receiver the
substituted return carries no SomeTs, so it takes the return-expression
re-evaluation path (`rre_era_suspect`, `src/evaluator/calls/function.yo`) which
re-evaluates `IterRev(Self)` through the constructor memo — that is what gives
each call site one canonical identity, and it works when `Self` is
`Range(i32)`.

It stops working when `Self` is ITSELF an `IterRev` instance. The likely cause
is that the memo is keyed on the type ARGUMENTS as given, and the inner
`IterRev(Range(i32))` reaching the second call is a non-canonical copy of the
instance the first call minted — so the key misses and a fresh struct id is
issued. That is the same family as the era split fixed in #247, where the
repair was to canonicalize the *result* through the constructor memo
(`canonicalize_instantiation_via_ctfe_memo`); the fix here is likely to
canonicalize each concrete type ARGUMENT before keying the memo.

## Measured evidence (2026-08-25)

From the emitted C of the reproducer:

```c
struct __yo_t9_struct  { __yo_t10 _inner; };  //  : <struct:struct_yo_id_3978>
struct __yo_t19_struct { __yo_t9  _inner; };  //  : <struct:struct_yo_id_3978>
struct __yo_t11_struct { __yo_t9  _inner; };  //  : <struct:struct_yo_id_6252>
```

`t19` and `t11` are structurally IDENTICAL — both `IterRev(IterRev(Range(i32)))`
— but carry DIFFERENT eval struct ids. `struct_yo_id_6252` appears exactly ONCE
in the whole emitted C: as that one struct definition, used only as the `rev`
function's return type. So one logical type was minted twice, and the call site
holds the other instance.

`3978` is the shared def-era `IterRev` id — `substitute()` keeps `id` and
`constructor_func_id` while rewriting type arguments, so EVERY `IterRev`
instantiation shares it and the distinction lives in the rendered type key.
`6252` is a genuinely separate instantiation.

Two hypotheses were tested and REFUTED:

1. *The constructor memo key misses on a non-canonical copy.* No —
   `_ctfe_args_equal` compares struct arguments by id first (a copy hits
   trivially) and then by constructor fid plus recursive era-equality, so a copy
   or an era instance unifies.
2. *The return-type re-evaluation path (`rre_era_suspect`) mints it.* No —
   running the reproducer with `YO_DEBUG_RRE=1` prints seven `[rre]` lines and
   NONE of them is for `rev`. That path is never entered for this call, so it
   cannot be the source.

What remains: the two instances are produced by two different mechanisms — one
substitution-derived (`3978` + rewritten arguments) for the call site, one a real
constructor instantiation (`6252`) for the callee's return — and nothing
reconciles them. #247 added exactly such a reconciliation
(`canonicalize_instantiation_via_ctfe_memo`) but wired it to the trait-OPERATOR
dispatch path only; a method call never reaches it.

## Impact

Any generic type applied to an instance of itself: `.rev().rev()`,
`IterMap(IterMap(...))` if ever written by hand, `Box(Box(T))`-shaped
constructions. Chains of *different* adaptors are unaffected (each is a distinct
constructor), which is why the existing combinator surface never hit this.

`tests/iterator_combinators.test.yo` therefore covers `.rev()` but not
`.rev().rev()`, with a pointer here.
