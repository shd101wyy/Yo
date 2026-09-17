# The old-value save on a non-dropping assignment is dead code — and that is fine

**Status:** NOTE, not a defect. Recorded 2026-09-17, **downgraded the same day**
after review. No fix is planned and none is wanted; see "Why this is not worth
fixing".

Found by reading the C emitted for `Array(T, U).default()` (#751), after the
question "does `MaybeUninit` for an array allocate on the stack or the heap?"
(it allocates on the **stack** — `MaybeUninit` is a zero-cost newtype over a
by-value struct in an ordinary automatic local, no `malloc` in the function).

## What is emitted

`src/codegen/exprs/assignment.yo:103-117` saves the LHS's old value into a temp
before every store:

```c
int32_t _file____priv_temp_… = a.data[i]; // Save old value for later use
a.data[i] = 1;
```

This is **by design**, and the design is right: the comment says *"Save the old
value into the result temp (for a deferred drop of it)"*, and for a
reference-counted old value the save is what the drop reads.

| assignment | the saved temp is | |
| --- | --- | --- |
| `(s : String) = …; s = …` | read **5 times**, feeding `__yo_decr_rc` | necessary |
| `a(i) = i32(1)` | declared once, never read | dead |
| `i = (i + usize(1))` | declared once, never read | dead |

## Why this is not worth fixing

- **The dead saves cost nothing.** They are loads from a local whose address is
  visible to the optimizer, never read afterwards, and clang removes them at
  `-O2`. There is no runtime effect to recover.
- **The fix is disproportionate and risky.** The saved temp is read by the
  deferred-drop machinery, so gating the save means gating where the temp is
  DECIDED (`attach_temp_variable_to_expr`), not where it is emitted.
  Suppressing one without the other emits a reference to an undeclared temp —
  the exact failure the `sm->` branch beside the save site was added to fix.
  The change would touch every assignment in every program and need a
  byte-identity corpus diff to land safely, to buy nothing at run time.

## The one nuance worth remembering

`Array(T, U).default()` writes into `MaybeUninit` storage, so its dead save
reads memory before anything has written it. For most `T` that is an
*unspecified value* rather than undefined behaviour, because the storage's
address is taken.

`bool` is the exception in principle: `Array(bool, U)` lowers to `bool data[N]`
(C `_Bool`), and an indeterminate `_Bool` outside `{0, 1}` is a trap
representation, which the standard does call UB — and clang does assume `_Bool`
is 0 or 1. It remains a DEAD load that clang deletes, so nothing has been
observed and nothing is expected; MemorySanitizer would flag it if it were ever
run here.

**If this ever does need addressing**, the cheap and local option is to make
`Array(T, U).default()` not read what it is about to write, rather than to
change assignment codegen globally.

## Reproducer

`issues/repros/assignment-saves-an-old-value-that-needs-no-drop.yo` — compile
with `--emit-c --skip-c-compiler` and `grep -c 'Save old value'`.
