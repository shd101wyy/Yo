# A borrow-returning generic method breaks its own `&T` parameters

**Severity:** S2 — a generic impl method whose result type is `&T`/`&mut T` gets pointer-flavored `&T` parameters whose every use (forwarding to another `&T` parameter, reading into a `&T`-typed local) emits a C pointer where the callee expects the value, so the program does not compile; the check passes and the failure surfaces only in the C compiler.

**Found:** 2026-10-25, implementing B7c (`HashMapEntry.or_insert` returning `&mut V`, decision 22). Reproduces identically on the seed `yo` v0.2.70 and on a b6-a tree build, so it is not new in the branch.

## Reproducer

```yo ignore
pragma(Pragma.AllowUnsafe);
Box2 :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T, w : T));
impl(
  generic(T : Type),
  Box2(T),
  inner : (fn(self : &mut Self, value : &T) -> T)({
    (out : T) = value;
    out
  }),
  outer : (fn(self : &mut Self, d : &T) -> &mut T)({
    (x : T) = self.inner(d);
    consume(self.v = x);
    addr_of(self.v)
  })
);
```

```sh
yo compile repro.yo -o repro   # check passes; gcc then rejects the emitted C
```

```text
error: passing argument 2 of ‘yo_id_985…_i32_rtparam1_i32_ret_i32’ makes
integer from pointer without a cast [-Wint-conversion]
  int32_t _file_… = yo_id_985…(__yo_v_self, __yo_v_d);
                                                    ^~~~~~~~~
                                       int32_t * {aka int *}
```

(The `yo ignore` fence above is only because this file is Markdown; the body
is the exact repro, verified with the tree binary and the seed.)

## Root cause (as far as measured)

`outer`'s specialization carries its `&mut T` result, and with it its `d : &T`
parameter is lowered as a REAL C pointer (`int32_t* __yo_v_d`). `inner`'s
specialization — same declared shape `value : &T` — is lowered with the
parameter BY VALUE (`int32_t`). The call `self.inner(d)` forwards the pointer
unchanged into the by-value parameter, and `(out : T) = value` inside `inner`
compiles for the by-value flavor, so the disagreement is invisible to `check`
and only gcc sees it. Flip `outer`'s result to `T` and everything lowers
by-value consistently — the borrow in the RESULT is what pulls the pointer
flavor into the whole specialization.

Two adjacent measurements from the same session (both check-clean, C-broken
or inference-broken):

- `HashMap.or_insert` returning `&mut V`: its `default : &V` parameter and
  every read of it lower as `V*` while `_insert_at`'s `value : &V` lowers
  by-value — the exact clash above (B7c keeps `or_insert -> V` until this is
  fixed).
- A with-shape body whose result is a borrow cannot infer the shape's `R`:
  `ArrayList.with` — the shipped `with` shape — fails
  `Cannot unify incompatible types: "i32" and "*(i32)"` for
  `xs.with(usize(0), v => v)` with the caller declared `-> &mut i32`. So the
  borrow cannot escape through `R` either.

## Fix direction

The specialization of a function whose result mentions a borrow must lower
its `&T` parameters the same way the non-borrow-returning twin does (or every
read/forward of such a parameter must deref per its pointer flavor). The `R`
inference arm should unify a closure body of type `&T`/`&mut T` with `R`
instead of the pointee.

## Blocking

- decision 22's `or_insert`/`or_insert_with` returning `&mut V`
  (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.3) — B7c landed them
  returning `V` (the pre-B7c contract) with the entry/slot machinery in
  place; flipping the return types is the follow-up.
- `get_or_insert`/`get_or_insert_with` returning `&mut V` (Rust's shape).
