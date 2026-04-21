# Closure capture of RC value leaks: original variable not dropped after capture

## Status

**Open** — not blocking bootstrap pre-work (workaround: avoid capturing RC
values in `for_each`-style closures; pre-create indices instead). Filed as
follow-up after fixing box-forall-V regression.

## Symptom

When a closure captures a reference-counted value (e.g., `ArrayList`,
`String`, `Box(T)`) and is invoked through a Fn-trait method like
`Iterator.for_each`, the original captured variable is leaked. ASan
reports an indirect leak of the heap allocation owned by the variable.

## Reproducer

```rust
open import "std/libc/stdio";
open import "std/collections/array_list";

main :: (fn() -> unit) {
  out := array_list(i32(0));
  src := array_list(i32(1), i32(2), i32(3));
  src.iter().for_each((x) => { (_ := out.push(x.*)); () });
  printf("len=%zu\n", out.len());
};

export main;
```

ASan output (relevant excerpt):

```
SUMMARY: AddressSanitizer: 56 byte(s) leaked in 2 allocation(s).
  - Direct leak of 40 bytes in __yo_new___yo_struct_<ArrayList(i32)>
  - Indirect leak of 16 bytes in fn_..._push_...
```

## Cause (preliminary)

Generated C code (excerpt):

```c
__yo_struct_..._id_712* out = _yo84b2db60_temp_26309;  // out created
...
// out captured by value (no dup):
__yo_struct_..._id_6 __capture = (__yo_struct_..._id_6){ .out = out };
...
fn_..._for_each(iter, capture);
size_t len = fn_..._len(out);
printf("len=%zu\n", len);
fn_..._drop(iter);
fn_..._drop(src);
// out is NEVER dropped!
```

The codegen treats `out` as moved into the capture struct (no `dup`), but
then continues to use `out` after the call AND fails to emit a final drop
for `out` at function end. Either:

- The capture should `dup` the original (and the closure-call site should
  drop the capture's copy when the closure is dropped), OR
- The capture move semantics should still emit a drop at `out`'s scope end
  for the live variable.

## Workaround

Don't capture RC values in `for_each` closures. Instead, use an explicit
loop:

```rust
mut iter := src.iter();
mut next := (&iter).next();
while runtime(true), {
  match(next,
    .None => { break },
    .Some(x) => {
      (_ := out.push(x.*));
    }
  );
  next = (&iter).next();
}
```

Or use index-based iteration where possible.

## Next steps

- Investigate `src/codegen/exprs/anonymous-function.ts` capture
  generation: should the capture struct's RC fields be incremented when
  the capture is constructed?
- Investigate `src/evaluator/exprs/begin.ts` ownership tracking: are
  captured variables being marked "moved" when they are still live in the
  caller scope?
- Add `tests/closure_capture_rc_leak.test.yo` once fixed.
