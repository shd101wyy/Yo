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

## ROOT CAUSE (corrected 2026-08-25 — the first diagnosis was wrong)

**The check already exists and is correct.** `src/evaluator/calls/type.yo:347-364`,
in `try_to_call_type_with_arguments`:

```rust
// Check that all unchecked fields have defaults.
...
has_default := field.default_value.is_some();
if(!(has_default || has_assigned), {
  ... `Type member "${field.label}" is not provided and has no default value or assigned value.`
```

It never RUNS for this site. The offending construction is at
`std/fs/temp.yo:185`, and line 161 shows where it lives:

```rust
new_in : (fn(parent : Path, io : Io) -> Impl(Future(TempFile, IoExn)))(
  io.async((e) => {
    ...
    file := _file_mod.File(_fd : fd, _path : path, _is_closed : false);   // <-- inside the async closure
```

An `io.async` closure body is one of the four contexts `yo check` never
evaluates (macro `quote(...)` bodies, generic trait-impl bodies, generic
helpers in the defining module, async closure bodies — see
`.github/instructions/testing.instructions.md`). So the validation is
unreachable, codegen emits a struct literal short one member, and the field is
uninitialised.

This is therefore NOT a missing check — it is the **def-eval / async-closure
blind spot** again, the same root as
`issues/ftt-stub-in-live-closure-falls-off-non-void-function.md` and the "~220
type-level swallow classes" still open in
`issues/fixed/self-hosted-compile-swallows-undefined-call.md`.

### Why the #275 backstop does not catch this one

`-Werror=return-type` plus the abort-stub rewrite (PR #275) catch untranspilable
bodies because codegen leaves a `// Failed to transpile` MARKER it can find.
This failure leaves no marker at all: codegen happily emits a well-formed
compound literal that is simply missing a member. The C compiles, and the only
symptom is garbage in the field. **So the FTT backstop's coverage stops exactly
where this class begins**, and no existing gate sees it.

### What a fix would have to do

Either make the existing check reachable for async-closure bodies (the wider
strict-mode campaign — large, and previously reverted once), or add a
codegen-side assertion that a struct literal's member count matches its type's
field count, which is cheap and local and would have caught this instance.
The second is a backstop, not a cure, and should be labelled as such.

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
