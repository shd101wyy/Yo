# Every assignment saves the old value, even when nothing will drop it — and into `MaybeUninit` storage that reads as indeterminate

**Status:** OPEN. Found 2026-09-17 by reading the C emitted for
`Array(T, U).default()` (#751), after the question "does `MaybeUninit` for an
array allocate on the stack or the heap?".

**Not a correctness bug that has been observed.** It is dead code in the common
case and a read of indeterminate storage in one specific case. Both are
measured below; neither has been shown to miscompile anything.

## What is emitted

`src/codegen/exprs/assignment.yo:103-117` saves the LHS's old value into a temp
before the store:

```c
int32_t _file____priv_temp_… = a.data[i]; // Save old value for later use
a.data[i] = 1;
```

The comment above it says why: *"Save the old value into the result temp (for a
deferred drop of it)"*. That is correct and necessary when the old value is
reference-counted — the assignment overwrites the only handle, so the old one
must be released.

The emission is gated on three things: the LHS is not a compile-time-only atom,
its type is not `unit`, and `ei.variable_name` is `.Some(...)`. **It is not
gated on whether the old value needs dropping at all.**

## Measured

| assignment | saved temp is | verdict |
| --- | --- | --- |
| `(s : String) = …; s = …` | used **5 times**, feeding `__yo_decr_rc` | NECESSARY |
| `a(i) = i32(1)` on an initialized `Array(i32, 4)` | declared once, **never used** | dead |
| `i = (i + usize(1))` on a loop counter | declared once, **never used** | dead |
| `(p.add(i)).* = T.default()` into `MaybeUninit` storage | declared once, **never used** | dead **and reads indeterminate memory** |

Eight `Save old value` lines appear in the C for a four-line program.

## The second row is the one that is more than untidy

`Array(T, U).default()` (std/prelude.yo, #751) obtains storage via
`MaybeUninit(Self).new()` and writes each element through a pointer. The
storage is deliberately uninitialized, so the save reads it **before anything
has written it**:

```c
static inline Array_int32_t_4 yo_id_…_ret_Array_i32__4_() {
  __yo_t_… __yo_uninit_r6879c29_n0;                 // indeterminate
  int32_t* p = ((int32_t*)((Array_int32_t_4*)(&(mu))));
  while (…) {
    int32_t _file____priv_temp_… = (*(p + i));      // <-- reads indeterminate memory
    (*(p + i)) = yo_id_…();
    …
  }
}
```

For `int32_t` this is benign in practice — no trap representations, and the
load is dead so clang removes it at `-O2`. It is not benign as a general rule:
the impl is bounded on `T <: Default`, so `T` may be any type with a `Default`,
including one with padding or a representation where an indeterminate load is
not free. It is also exactly what MemorySanitizer exists to flag.

`std/sys/tty.yo` and `std/process/command.yo` use `MaybeUninit(Array(…))` too
but write through a C call, not a Yo assignment, so they never hit this.
`Array(T, U).default()` appears to be the first Yo-level element-wise write
into uninitialized storage.

## Reproducers

```rust
// dead save, ordinary array
a := Array(i32, usize(4)).fill(i32(7));
(i : usize) = usize(0);
while(i < usize(4), { a(i) = i32(1); i = (i + usize(1)); });
```

```rust
// dead save that READS uninitialized storage
a := Array(i32, usize(4)).default();   // std/prelude's impl, via MaybeUninit
```

Inspect with `yo compile <file> --optimize 2 --emit-c --skip-c-compiler` and
grep the `.c` for `Save old value`.

## Fix shape, NOT yet measured

Gate the save on the old value actually needing a drop, rather than on a temp
having been attached. The predicate the evaluator already uses for this family
is `type_contains_rc_type` (`src/types/utils.yo`).

**The obvious version of that is not safe on its own.** The saved temp is read
by the deferred-drop machinery, so suppressing the save without also
suppressing the drop that reads it would emit a reference to an undeclared
temp — which is the exact failure the `sm->` branch immediately below the save
site was added to fix ("this branch previously emitted NOTHING, so the deferred
drop either dropped calloc zero (silent leak) or referenced an undeclared
temp"). The gate belongs wherever the temp is decided — `attach_temp_variable_to_expr`
in the evaluator — not at the emission site alone.

Before changing it: record the corpus C, apply, and diff. This is an
"additive" codegen change in the sense of
[[yo-byte-identity-gate-for-additive-codegen-change]] — every assignment in
every program is affected, so byte-identity over the corpus modulo the removed
lines is the acceptance test, and an RC assignment keeping its save is the
canary that must not move.
