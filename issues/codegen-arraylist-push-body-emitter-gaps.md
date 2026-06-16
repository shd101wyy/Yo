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

### CORRECTION 2026-06-16: there is NO T-substitution gap
An earlier note here claimed `T` was unsubstituted in the specialized push body
(from `sizeof(T)`/`*(T)` in the "Failed to transpile" lines). That was a MISREAD:
those strings are the **source-text echo** (`ast_expr_to_string` of the
un-transpiled expr in the `// Failed to transpile <src>` comment), NOT the lowered
type. The TRANSPILED lines prove T is correctly substituted to `u8`:
`uint8_t* old_ptr`, `uint8_t* typed_ptr`, `uint8_t* target_ptr`, and `self->_ptr`
typed `uint8_t*`. So the blockers are PURELY the emitters below (a `*(T)` cast
would correctly emit `(uint8_t*)`), not generic substitution.

### ✅ `*(T)(ptr)` pointer cast — FIXED 2026-06-16 (commit d8a23ab2a)
Resolved together with runtime numeric casts: both `*(T)(ptr)` and `i32(runtime)`
were rewritten to `__yo_as` by the eval but the rewrite never reached codegen
(returned new node, codegen walks the original). Fixed via the original node's
`macro_expansion` → fresh-id `__yo_as` node. The `*(T)(new_ptr)` line is gone from
push1's failures.

### Remaining emitter gaps (isolate each)
- comptime-namespace method dispatch: `GlobalAllocator.realloc/malloc` (callee is
  a comptime value bundling fns — resolve to the bundled fn + emit a normal call).
- `*(T)(ptr)` raw-pointer cast (deref-cast); note `.Some(*(void)(old_ptr))` shows
  `*(void)` too — the void-ptr deref-cast form.
- `&+` pointer arithmetic — NOT a direct `__yo_ptr_add` inline (corrected): in TS
  (`_expr.ts:1222`) `&+` is only unsafe-gated then dispatched as a NORMAL call;
  `&+` is a pointer OPERATOR-METHOD whose body calls `__yo_ptr_add`. So codegen
  must dispatch the `&+` operator method (then the inner `__yo_ptr_add` lowers via
  the inline path). Same operator/method-dispatch complexity class as the others —
  NOT a one-liner.
- `.Some(ptr)` runtime enum-ctor into a `?*(T)` field — but this line cascades
  from `typed_ptr` (the `*(T)` cast) failing first, so it may resolve once `*(T)`
  works; verify independently (runtime `.Some(x)` value-position DOES work, per
  the `some2` fixture).

Build isolated corpus fixtures per gap. Each needs `unsafe`/raw-ptr scaffolding.
