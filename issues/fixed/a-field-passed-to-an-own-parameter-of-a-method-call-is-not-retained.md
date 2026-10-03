# A field passed to an `own` parameter of a method call is not retained

**Severity:** S1 — `Type.method(x.field)` / `recv.method(x.field)` into an `own` parameter releases the field's value one time too many, and a method receiver projection is not held for the call: heap use-after-free in safe code.

**Found:** 2026-10-03, while preparing the String S3 change (`String.from_bytes(own(bytes))`; the compiler has ~13 `String.from_bytes(out.stdout)` sites). **Status:** FIXED on `fix/own-arg-retain`.

## Reproducer

```rust
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
Holder :: struct(bytes : ArrayList(u8));
impl(Holder, make : (fn(own(b) : ArrayList(u8)) -> Self)(Self(bytes : b)));
W :: struct(buf : ArrayList(u8), n : i32);
fin :: (fn(self : W) -> Holder)(Holder.make(self.buf));
main :: (fn() -> unit)({
  w := W(buf : ArrayList(u8).new(), n : i32(1));
  w.buf.push(u8(0x41));
  h := fin(w);
  println(h.bytes.len());
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system -o r && ./r` (v0.2.49 and develop 60e4f7def):

```
==2572731==ERROR: AddressSanitizer: heap-use-after-free on address 0x7812fc4e1870 at pc 0x63e1d6f63cb5 bp 0x77e2f9dfec50 sp 0x77e2f9dfec48
READ of size 4 at 0x7812fc4e1870 thread T1
...
SUMMARY: AddressSanitizer: heap-use-after-free (field3.bin+0x178cb4)
```

The same happens for a local's field (`out := run(); h := Holder.make(out.stdout);`),
a nested field (`Holder.make(o.w.m)`), a borrowed parameter (`Holder.make(p)`) and an
instance method (`holder.adopt(w.m)` with `adopt : (fn(self : Self, own(b) : T) -> …)`).
The plain call `make(self.buf)` is correct.

## Root cause

The evaluator treats every call form the same way: `consume_argument_for_parameter`
(`src/evaluator/calls/helper.yo`) marks a borrowed argument of an `own` parameter
"needs dup + consumed", which records a deferred `___dup` on the argument's temp.
A gated probe there showed the identical decision for `Holder.make(self.buf)` and
`make(self.buf)` (`own=true chk=false var=<temp>` in both).

Codegen is where the two forms part. The plain call path generates each argument
through `_materialize_arg` (`src/codegen/exprs/other_fn_call.yo`), which declares the
temp and emits the deferred dup:

```c
T* tmp = self.buf;
__yo_incr_rc((void*)(tmp));
yo_id_make(tmp);
```

The method-dispatch emitters in `generate_other_function_call` — the concrete
`recv.method(...)` / `Type.method(...)` dispatch, the inlined builtin-method form, the
recorded method callee of a rewritten value call, and the vtable slot call — generated
each argument with a bare `_call_generate_expr`, so the dup was never emitted:

```c
yo_id_make(self.buf);
```

The callee released its `own` parameter at scope end, and the caller's own drop of the
field then released it again.

### The same gap dropped the Stage-0 projection +1

The bare emission dropped EVERY deferred argument dup, not only the `own` one. A
borrowed field projection passed to a borrowing parameter gets a caller-owned +1 for the
call (Aliasing Stage 0, rule 4c of `consume_argument_for_parameter`) unless the callee is
read-only, balanced by a drop after the call. In method dispatch neither half appeared:
the dup was not emitted, and the drop targets the dup's temp, which was never declared,
so codegen's undeclared-temp guard skipped it too. The balance hid a second
use-after-free:

```rust
Inner :: ref(struct(v : i32));
Outer :: ref(struct(inner : Inner));
replace :: (fn(o : Outer) -> unit)({ o.inner = Inner(v : i32(0)); });
impl(Inner, poke : (fn(self : Self, o : Outer) -> i32)({ replace(o); self.v }));
// o2.inner.poke(o2)   -> heap-use-after-free reading self.v
// poke_f(o.inner, o)  -> fine: the plain call holds the projection for the call
```

Making the method emitters agree with the plain call closes both. Measured on the
compiler's own C (`compile src/main.yo --emit-c`, same tree, pre-fix vs fixed compiler):
1,898,880 → 1,955,702 lines; the added lines are 18,534 `incr`/18,551 `decr` pairs of
that Stage-0 +1 (almost all `buf.*.push(byte)`-style receivers through a pointer deref
into a mutating method, which the plain-call path already pays), 194/172 conditional
pairs for nullable values, and the temps that hold them. Both C files compiled with the
fixpoint gate's flags (`clang -O2`, system malloc), `check ./src --std-path ./std`:
353.2 s → 363.4 s wall (+2.9 %, one run each), peak RSS unchanged (1.16 GB).

## Fix

The method-dispatch emitters generate each argument through `_dispatch_arg_code`: an
argument that carries a deferred dup (the `own` copy or the Stage-0 projection +1) is
materialized exactly as the plain-call path does (`_materialize_arg`, gated by the
parameter's `inout` flag); any other argument is its plain code, so a method call without
a dup emits the same C as before.

## Tests

`tests/rc.test.yo`, the five tests after "a borrowed value passed to an `own`
parameter": `Type.method` with a borrowed parameter's field, a local's field, a nested
field and a borrowed parameter; `recv.method` with a field argument; and the plain call.
Each checks `rc(...)` while both holders are live (2, or 1 after the callee released its
copy) and a `Dispose` counter after the scope (exactly one release per box, so the dup
is matched and nothing leaks). "a receiver projection outlives a method that replaces
it" covers the Stage-0 half. They fail before the fix.
