# yo-self segfaults on nested type application in impl method return type

## Status

Open. Discovered 2026-05-16 while extracting tests/blanket_impl_inner_forall.test.yo
"Inner forall in blanket impl method" into a standalone check fixture.

## Symptom

`yo-self-bin check` SIGSEGVs (exit 139) when an impl-defined method
returns a nested type-application like `Wrap(Wrap(P, i32), i32)`,
even when the inner forall and where-clause are removed and the
receiver is a concrete type.

TS reference handles the same shape successfully.

## Minimal repro

```yo
Wrap :: (fn(comptime(I) : Type, comptime(B) : Type) -> comptime(Type))(
  struct(_inner : I, _tag : B)
);

P :: struct(v : i32);

impl(
  P,
  promote : (fn(self : Self) -> Wrap(Wrap(P, i32), i32))(
    Wrap(Wrap(P, i32), i32)(
      _inner : Wrap(P, i32)(_inner : self, _tag : i32(0)),
      _tag : i32(0)
    )
  )
);

main :: (fn() -> unit)({});
export(main);
```

```
$ /tmp/yo-self-bin check /tmp/blanket_min14.yo
check: invoking evaluate_anonymous_module_begin_exprs
$ echo $?
139

$ ./yo-cli check /tmp/blanket_min14.yo
check: /tmp/blanket_min14.yo — evaluator OK
```

## Narrowing

Step-by-step narrowing showed:

| Shape                                                         | Result  |
| ------------------------------------------------------------- | ------- |
| `impl(P, simple : fn(...) -> Wrap(P, i32))`                   | OK      |
| `impl(P, with_self : fn(...) -> Wrap(Self, i32))`             | OK      |
| `impl(P, with_pp : fn(...) -> Wrap(P, P))`                    | OK      |
| `impl(P, with_nested : fn(...) -> Wrap(Wrap(P, i32), i32))`   | SIGSEGV |
| Standalone `make_nested : fn(...) -> Wrap(Wrap(P, i32), i32)` | OK      |

So the trigger is **nested type-application in the return type
combined with the impl-method evaluation context**. A standalone
function with the identical return type evaluates fine.

## Likely cause

`evaluate_module_value` in `evaluator/values/impl.yo` sets
`ctx.self_type = .Some(receiver_ty)` around method-body evaluation
(commit `f859a15c`). When the return type `Wrap(Wrap(P, i32), i32)`
is evaluated, the outer `Wrap` comptime call body is
`struct(_inner : I, _tag : B)`. The inner argument `Wrap(P, i32)`
is itself a comptime call to Wrap. Both are CTFE calls of the same
function. Recursing into the comptime-fn cache while `ctx.self_type`
is set to the impl's receiver may trip up the cache/specialization
logic.

Same fingerprint as `yo-self-where-clause-trait-eval-segfault.md`
in that the crash is silent and during the evaluator phase, with
no diagnostic surfaced.

## Next steps

1. Reproduce with a debug build and add breadcrumbs inside
   `evaluate_comptime_fn_call` to identify which inner call segfaults.
2. Check whether the comptime-fn cache key collides between the
   outer and inner Wrap call.
3. If the bug is in cache-bucket reuse, fix the key construction;
   if it's in nested ctx.self_type save/restore, hoist the save out
   of inner calls or thread the receiver explicitly.
