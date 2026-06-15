# ArrayList(u8).push() body — emitter gaps (post return-body-spec fix)

**Status:** OPEN. Surfaced after the return-body specialization fix (f2cf25e79)
made `ArrayList(u8).push()` *specialize* correctly (T→u8). The call site and
specialization are now correct; the remaining failures are all inside the
specialized push **body**.

## Repro

`/tmp/push1.yo`:
```rust
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
{ putchar } :: import("std/libc/stdio");
main :: (fn() -> unit)({
  al := ArrayList(u8).new();
  al.push(u8(65));
  al.push(u8(66));
  n := al.len();
  unsafe(putchar(int(i32(usize(48) + n))));
});
export(main);
```
TS prints `2`. self-bin: `main` body is CORRECT
(`yo_id_3753(al,65)`, `yo_id_3739(al)`), but the C fails to compile — the push
body (`yo_id_3753`) contains these `// Failed to transpile` forms:

1. `(GlobalAllocator.realloc)(.Some(*(void)(old_ptr)), sizeof(T)*new_capacity)`
   and `(GlobalAllocator.malloc)(...)` — **comptime-namespace method dispatch**
   (`GlobalAllocator` is a comptime value bundling malloc/realloc/free).
2. `*(T)(new_ptr)` — **raw-pointer cast** `*(T)(ptr)` (deref-cast to typed ptr).
3. `.Some(typed_ptr)` — **enum constructor in value position** assigned to a
   `?*(T)` field (runtime pointer payload).
4. `typed_ptr &+ (self._length)` — **pointer arithmetic operator `&+`**.

Each is a separate emitter gap. Also note `sizeof(T)` appears unsubstituted in
the realloc/malloc args (T should be u8 in the specialized body) — verify
whether the spec body substitutes T into `sizeof(T)`.

## Re-confirmed 2026-06-16 (after return-body + match-arm fixes — both unrelated)

Current `push1.yo` push-body failures (verbatim):
```
_tmp = // Failed to transpile (GlobalAllocator.realloc)(.Some(*(void)(old_ptr)), sizeof(T) * new_capacity);
_tmp = // Failed to transpile (GlobalAllocator.malloc)(sizeof(T) * new_capacity);
uint8_t* typed_ptr = // Failed to transpile *(T)(new_ptr);
self->_ptr = // Failed to transpile .Some(typed_ptr);
uint8_t* target_ptr = // Failed to transpile typed_ptr &+ (self._length);
```

### KEY NEW FINDING: T is NOT substituted in the specialized push body
`sizeof(T)` and `*(T)` show a bare `T`, not `u8` — so inside the specialized
`push` body the type param is still abstract. This is a generic-substitution gap
DISTINCT from the emitter gaps (ArrayList(u8).new()/len() worked because their
bodies don't use `sizeof(T)`/`*(T)`/raw-mem). Likely the keystone specialization
binds T for signature/return resolution but the body's `sizeof(T)`/`*(T)`
sub-exprs aren't re-evaluated with T=u8. If T were substituted, `sizeof(u8)` and
`*(u8)(ptr)` would lower cleanly and may unblock several of the lines above.
**Investigate this FIRST** — it may be the root, with the emitters secondary.

### Emitter gaps (after T-subst is fixed, isolate each)
- comptime-namespace method dispatch: `GlobalAllocator.realloc/malloc` (callee is
  a comptime value bundling fns — resolve to the bundled fn + emit a normal call).
- `*(T)(ptr)` raw-pointer cast (deref-cast); note `.Some(*(void)(old_ptr))` shows
  `*(void)` too — the void-ptr deref-cast form.
- `&+` pointer arithmetic — should lower to `__yo_ptr_add` (an inline builtin,
  BF_YO_PTR_ADD), so the gap is the `&+` operator not being recognized/lowered to
  it; check the eval/codegen path for `&+`.
- `.Some(ptr)` runtime enum-ctor into a `?*(T)` field — but this line cascades
  from `typed_ptr` (the `*(T)` cast) failing first, so it may resolve once `*(T)`
  works; verify independently (runtime `.Some(x)` value-position DOES work, per
  the `some2` fixture).

Build isolated corpus fixtures per gap. Each needs `unsafe`/raw-ptr scaffolding.
