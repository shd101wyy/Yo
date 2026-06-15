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

## Priority order (suggested)

`.Some(ptr)` runtime enum-ctor and `*(T)(ptr)` cast are the most reusable
(appear across std container/allocator code). `&+` and comptime-namespace
allocator dispatch are more specialized. Build isolated corpus fixtures for each.
