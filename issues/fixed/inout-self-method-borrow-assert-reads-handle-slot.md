# The compiler-emitted borrow assert of an `inout(self)` method read the handle slot, not the object

**Status: FIXED (2026-09-07, `inout` local-bindings PR #476, found in its
soundness review).** Both emitters of `__yo_borrow_assert_unborrowed` for
object methods spelled the receiver as `(void*)self`. For a method whose
receiver is `inout(self) : Self` on a reference struct, the C parameter is
`T** self` — a pointer to the CALLER's handle slot — so the assert read an
RC header at `(char*)&caller_slot - sizeof(header)`: stack memory.

## Symptom

```rust
Bag :: ref(struct(items : ArrayList(i32), version : i32));
impl(Bag,
  iter : (fn(self : Self) -> ArrayListIterPtr(i32))(self.items.iter()),
  bump_version : (fn(inout(self) : Self) -> unit)({ self.version = (self.version + i32(1)); }));
for(bag, inout(x) => { bag.bump_version(); });  // must panic; did not
```

Emitted C (before):

```c
static inline void yo_id_9782(__yo_t0** self) {
  __yo_borrow_assert_unborrowed((void*)self);   // &bag, a stack slot
  (*self)->n = (((*self)->n) + (1));
}
```

Two consequences: a mutating `inout(self)` method called under a live borrow
was not caught (the flag read was garbage, usually zero), and any such method
called anywhere read out of bounds of the caller's frame — a spurious panic if
the bytes before the slot happened to be non-zero.

## Root cause

`_maybe_emit_method_entry_borrow_assert` (`src/codegen/functions/generation.yo`)
and `_maybe_emit_auto_borrow_assert` (`src/codegen/exprs/other_fn_call.yo`,
the `__yo_realloc`/`__yo_free` site from #473) both assumed a by-value `self`
(`T* self`). `FuncMeta.param_is_ref[0]` says when the receiver is `inout`.

## Fix

Both emitters spell the object as `(void*)(*self)` when the first parameter is
a ref parameter (`_current_self_param_is_ref` for the realloc/free site).

## Tests

- `tests/for_macro_borrow.test.yo` — "borrowed for over a user collection;
  inout(self) methods assert on the object, not the handle slot" (the
  no-false-panic side, and the first borrowed `for` over a user type whose
  `iter()` delegates to a std pointer iterator).
- `tests/cli-cases/inout-self-method-under-borrow-panics` — the panic side.
