# A generic fn whose `&T` tail forwards a projection call emits the value, not the address

**Severity:** S1 — miscompilation in safe code: the C returns the referent where the function returns a pointer (clang rejects it with `-Wint-conversion`; a lenient C compiler builds a binary that dereferences the value as an address and crashes).

- Filed: 2026-11-08 (deref lane, VERDICTS-38 §5 item 2; Fable's probes p10b/p10c).
- Reproduced on develop `a25a71ee1` (a tree build) and the v0.2.75 seed, user file, no `unsafe`.

## Reproducer

```yo
{ println } :: import("std/fmt");
W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), W(T), get : (fn(self : &Self) -> &T)(&self.v));
fwd_g :: (fn(generic(T : Type), r : &W(T)) -> &T)(r.get());
main :: (fn() -> unit)({
  w := W(i32)(v : i32(8));
  p := fwd_g(&w);
  println(`${p.*}`);
});
export(main);
```

```text
tmp/f2d.c:2374:10: error: incompatible integer to pointer conversion returning 'int32_t' (aka 'int') from a function with result type 'int32_t *' (aka 'int *'); take the address with & [-Wint-conversion]
yo: error: compile: C compiler failed (exit 1) on tmp/f2d.c
```

With a move-only payload the same shape is rejected instead, with a
diagnostic that reads the forwarded result as a copy of `T`:

```text
error[E0901]: use of moved value: cannot copy `(r.as_ref)()`, whose type `S` is move-only ...
note: in `use_g` with T = S, instantiated here
```

(`use_g :: (fn(generic(T : Type), r : &Rc(T)) -> &T)(r.as_ref())`.)

## What the concrete form does

The non-generic form is diagnosed correctly: `(fn(r : &Rc(i32)) -> &i32)(r.as_ref())`
is the projection error "The body forwards another projection: a `&i32`
result lends it at the call site — write `&r.as_ref()`". In a generic body
that check does not fire (the body is evaluated at the call, with `T`
substituted), the tail is typed `T` instead of `&T`, and codegen returns the
value. Either the projection-tail rule must run on the specialized body, or
the forwarded `&T` call result must be accepted as the tail (then lowered as
the pointer it is). The `Rc`/`Arc` holders of G2 (`get_mut -> Option(&mut T)`)
will meet the same shape.

A test belongs with the fix: the reproducer above prints `8`.
