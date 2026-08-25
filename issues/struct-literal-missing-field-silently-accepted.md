# A struct literal that OMITS a required field is silently accepted — the field is uninitialised and the program SIGSEGVs

**Status: OPEN.** Found 2026-08-25 while adding a field to `std/fs/file.yo`'s
`File`. Verified on `develop` at `340a9e735`.

## Symptom

`File` is declared with four fields:

```rust
File :: ref(struct(_fd : i32, _path : Path, _is_closed : bool, _pos : u64));
```

`std/fs/temp.yo:185` constructs one with only THREE:

```rust
file := _file_mod.File(_fd : fd, _path : path, _is_closed : false);
```

`yo check` is happy:

```
$ yo check std/fs/temp.yo
check: std/fs/temp.yo — evaluator OK          (rc=0)
```

`yo check ./std` also passes 153/153. The program then dies at runtime:

```
✗ TempFile.new creates a file
    Test failed with exit code 11        # SIGSEGV
```

Six tests in `tests/fs/temp.test.yo` crashed this way. The missing `_pos` is
never initialised, so the first read of it hands the pread/pwrite path a garbage
offset.

## Why it matters

This is silent MEMORY UNSAFETY from an ordinary omission — exactly the class a
statically-typed language is expected to reject. It is also a booby trap for any
change that ADDS a field to an existing struct: every construction site that was
not updated keeps compiling and starts producing objects with uninitialised
memory. There is no diagnostic anywhere in the pipeline — not `check`, not
`build`, not the C compiler, because codegen emits a compound literal whose
missing member is simply absent.

The failure is also badly localised: the crash surfaces in `temp.test.yo`, while
the defect is a literal in `temp.yo` referring to a type declared in `file.yo`.

## Expected

A struct literal missing a required field should be a hard evaluator error
naming the field and the literal's location, in the same way a wrong-typed
argument is rejected. Fields with a declared default (`?=`) may of course be
omitted.

## Reproduce

1. `git checkout 340a9e735`
2. Add a fourth field to `File` in `std/fs/file.yo`:
   `_pos : u64` (any type without a default).
3. Do NOT update `std/fs/temp.yo:185`.
4. `yo check ./std` → 153/153 passed, rc=0.
5. `yo test tests/fs/temp.test.yo --parallel 1` → 6 tests fail with exit code 11.

## Related

Same family as the evaluator's other silent acceptances:
- `issues/yo-self-async-await-argcount-overpermissive.md`
- the def-time swallow surface in
  `issues/fixed/self-hosted-compile-swallows-undefined-call.md`, whose "wider
  strict mode — the ~220 type-level swallow classes" is recorded as still OPEN.

Found alongside a second silent acceptance in the same session: passing `EINVAL`
(declared `int`) where `IoError.from_errno` expects `i32` was also accepted by
the evaluator, and codegen then emitted a C identifier with a Yo type expression
spliced into it (`__yo_dyn_box_unknown_fn(T : Type) -> Type`), which fails the C
compile with "expected ')'" rather than reporting a type error. That one is at
least LOUD; this one is silent.
