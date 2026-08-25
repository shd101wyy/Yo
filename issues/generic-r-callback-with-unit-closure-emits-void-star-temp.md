# A callback generic over its result (`with_lock`-shape) emits `void* tmp = <void call>` when the closure returns unit

**Status: OPEN.** Found 2026-08-26 while making `RwLock(T)` match
`Mutex(T).with_lock` (STD_API_AUDIT §D7). A ready-to-apply codegen patch is in
`issues/patches/generic-r-callback-unit-closure-void-temp.patch` — it is
**unvalidated**: verifying it needs a compiler rebuild, which the session that
found this was not allowed to run.

## Symptom

```
/tmp/unitprobe_out.c:2207:9: error: initializing 'void *' with an expression of incompatible type 'void'
 2207 |   void* _file____User_temp_7507 = closure_yo_id_6238(&(body), (&(self->_value)));
      |         ^                         ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
yo: error: compile: C compiler failed (exit 1)
```

`yo check` and `yo compile --emit-c --skip-c-compiler` both pass — the emitted
`.c` carries no "Failed to transpile" marker. Only the C compiler rejects it, so
`scripts/count-transpile-failures.sh` scores the file clean (0 real, 0 floor).

## Minimal reproducer

`issues/repros/generic-r-callback-unit-closure.yo`:

```rust
apply :: (fn(generic(R : Type), body : Impl(Fn(inout(v) : i32) -> R)) -> R)({
  x := i32(1);
  body(x)
});

main :: (fn() -> unit)({
  n := apply((v) => (v + i32(1)));   // R = i32   — fine
  apply((v) => { v = i32(5); });     // R = unit  — invalid C
});
```

The by-value form (`Impl(Fn(v : i32) -> R)`) fails identically, so this is about
`R` binding to unit, not about `inout`. An explicit `return(body(x))` does not
change it: the temp is emitted by the call site, before the return statement is
formed.

## This hits shipped std today

`std/sync/mutex.yo`'s flagship API has exactly this signature:

```rust
with_lock : (fn(generic(R : Type), self : Self, body : Impl(Fn(inout(v) : T) -> R)) -> R)
```

so the single most natural use of it does not compile:

```rust
m := Mutex(i32).new(i32(0));
m.with_lock((v) => { v = i32(7); });   // C compile error
m.with_lock((v) => { v = i32(7); v }); // works — has a value
```

`tests/sync/mutex.test.yo` misses this by accident: all three of its cases use
value-returning closures. The same hole reaches every `with_lock`-shaped API:
`RwLock(T).with_read` / `with_write` (added in the same §D7 pass) and the
`Once.call` slow-path rewrite the THREAD_SAFETY Phase D plan calls for
(`self._mutex.with_lock((v) => { ... })`), which is blocked on this and is why
`Once.call` still uses the manual `_raw_lock` / `_raw_unlock` pair.

## Root cause

`src/codegen/exprs/other_fn_call.yo`, `generate_other_function_call`.

At the top of the emitter the call's result type is normalized:

```rust
(result_type : TypeValue) = match(function_type, .Func({ result : r }) => r, _ => TypeValue.Unit);
...
if(is_some_type(result_type) && !(is_unit_type(ei.ty)), {
  result_type = ei.ty;
});
```

The `!(is_unit_type(ei.ty))` guard is deliberate: for a generic-ResumeType `ctl`
(`Exception.throw`) the DECLARED spelling must survive, or the fn-pointer cast
claims an instantiated type against a `void*`-returning handler and displaces
the sret argument (`issues/fixed/ctl-handler-void-signature-vs-sret-cast.md`).
The consequence is that whenever the call's own type is unit, `result_type`
stays an unresolved `SomeT`, which `get_type_string` lowers to `void*`.

The **registered-callee** path compensates for that (same file, ~line 1906):

```rust
rt_void := if(is_some_type(result_type), get_type_string(result_type, context.base) == `void`, is_unit_type(result_type));
```

The **fn-pointer / closure** path (the `ou_may_unwind` block, ~line 2127) does
not — it tests `is_unit_type(result_type)` only:

```rust
if(ou_may_unwind, {
  if(is_unit_type(result_type), { ...emit the call as a STATEMENT... });
  ...
  fpc := get_type_string(result_type, context.base);   // "void*"
  em.emit_string_line(`${indent}${fpc} ${fp_tv} = ${out};`);
```

`is_unit_type` does not walk the `SomeT` resolution chain, so the unit
specialization falls through to the temp form and declares a `void*` temp for a
call to a `void`-returning C function.

## Proposed fix (UNVALIDATED)

`issues/patches/generic-r-callback-unit-closure-void-temp.patch` widens that one
test to mirror the registered-callee path, plus the unresolved-`SomeT` case the
registered path never had to face:

```rust
ou_result_is_void := cond(
  is_unit_type(result_type) => true,
  ctl_generic_ret => false,
  is_some_type(result_type) => {
    ou_rts := get_type_string(result_type, context.base);
    ((ou_rts == `void`) || ((ou_rts == `void*`) && is_unit_type(ei.ty)))
  },
  true => false
);
```

`ctl_generic_ret` is excluded so the generic-ResumeType `ctl` branch below keeps
declaring the temp its escape-path drops reference.

Why the change should be safe: every shape it newly captures emits invalid C
today (`void tmp = call();`, or `void* tmp = <void call>;`), so it can only turn
a C-compile error into working output — no currently-compiling program takes the
new branch. That argument is a paper one; the patch has NOT been compiled,
because validating a codegen change needs a full self-compile.

## Verification when the fix lands

1. `yo compile issues/repros/generic-r-callback-unit-closure.yo --release -o /tmp/r && /tmp/r` (rc 0).
2. Add to `tests/sync/mutex.test.yo` a case using a unit-returning body:
   `m.with_lock((v) => { v = i32(7); });` then read it back.
3. Add the equivalent to `tests/sync/rwlock.test.yo` for `with_write` /
   `with_read`, and rewrite `Once.call`'s slow path onto
   `self._mutex.with_lock(...)` so an `unwind` out of the user's `f` cannot
   strand the mutex.
