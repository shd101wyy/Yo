# A call argument inside a struct-literal tail is never released

> Found 2026-09-25 by the holder census (`scripts/bootstrap/holder_census_t.py`,
> `HOLDER_DEEP` + the unreached-object split): in `check` of one std file,
> 53,771 `ArrayList(u8)` string buffers were alive at exit with NO pointer to
> them anywhere; 42,479 came from `String.from` inside `new_frame`
> (`src/env.yo`). Fixed in the same PR as this doc.

## Reproduction

```rust
Holder :: ref(struct(a : i32));
take :: (fn(p : Probe) -> i32)(p.n);
build :: (fn() -> Holder)(Holder(a : take(Probe(n : i32(1)))));   // Probe leaks
```

The same body as a block (`{ h := Holder(...); h }`) and a direct call tail
(`(fn() -> i32)(take(Probe(...)))`) release the `Probe`. The compiler's own
`new_frame` is this shape: `Frame(id : generate_variable_id(String.from(""), String.from("frame")), …)`,
and it leaked the two `String` buffers on every frame it built.

The emitted C released the argument temps only on the effect-escape paths;
the normal path ended in `return <new Frame>;`.

## Root cause

The temp's drop sits on the function body's shared-id node. The pre-body
flush in `generation.yo` skips it because the temp is not declared yet. The
nested call is an argument of a struct constructor, not a statement-level
call, so no post-call flush emits it. And `generate_implicit_return_statement`
(`src/codegen/exprs/return.yo`) emitted only the PARAM drops after the tail.

## Fix

`has_pending_emittable_drop` (`src/codegen/exprs/drop_dup.yo`, replacing
`has_pending_param_drop`) reports any not-yet-emitted drop that would emit
now, whether param-targeted or targeting a temp declared while the tail rendered.
When one is pending, the tail is materialized into `__yo_scope_ret`, ALL
pending drops are emitted, and the temp is returned.

## Test

`tests/rc.test.yo`: "a call argument inside a struct-literal tail is released"
(Dispose counter).
