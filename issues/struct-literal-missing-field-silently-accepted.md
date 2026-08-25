# A struct literal that OMITS a required field is silently accepted — the field is uninitialised and the program SIGSEGVs

**Status: OPEN**, but see the **CORRECTION 2026-08-25 (measured)** section
below before acting on this: the title and the first root-cause analysis are
both wrong. Nothing is emitted "short" — the statement is dropped as
`// Failed to transpile`, and `-Werror=return-type` (PR #275) already rejects
the release build — on BOTH optimisation arms. What remains open is
`unit`-returning functions and the swallowed diagnostic.

Found 2026-08-25 while adding a field to `std/fs/file.yo`'s `File`. Verified on
`develop` at `340a9e735`.

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

### CORRECTION 2026-08-25 (measured) — this IS the FTT class, and #275 covers it

**Everything from "codegen emits a struct literal short one member" onwards in
the section above is wrong.** It was inferred, not measured. Measured on this
tree, the mechanism is:

1. the evaluator check at `src/evaluator/calls/type.yo:347-364` **does fire**
   for this site,
2. the error is **swallowed** by the codegen-time evaluation of the `io.async`
   closure body,
3. codegen therefore has no `ExprInfo` for the call and emits
   `// Failed to transpile` for the **whole statement** — it never reaches the
   object-constructor emit path at all,
4. the enclosing value-returning C function falls off its end,
5. → SIGSEGV.

So there is **no short constructor call and no short compound literal**. There
IS a marker, and `-Werror=return-type` (PR #275, `dd4dbbf5a`) rejects it. This
is not a class the FTT backstop stops short of; it is
`issues/ftt-stub-in-live-closure-falls-off-non-void-function.md` with a missing
struct field as the trigger instead of a renamed method.

#### Evidence

`File` at HEAD already carries `_pos` and `std/fs/temp.yo:185` already supplies
it, so the original instance is fixed in the tree. Reproduced by adding a FIFTH
field `_probe : u64` to `File`, updating only the `File(...)` at
`std/fs/file.yo:82`, and leaving `std/fs/temp.yo:185` short. Driver: a
standalone `main` calling `TempFile.new(io)` and printing the path.

`yo compile <driver> --emit-c --skip-c-compiler --release` → rc=0, and the
emitted C contains:

```c
static inline __yo_t21* closure_yo_id_9134(void* closure_context, __yo_t22 e) {
  ...
  // Failed to transpile file := (_file_mod.File)(_fd : fd, _path : path, _is_closed : false, _pos : u64(0));
  // Failed to transpile TempFile(_file : file, _path : path, _removed : false)
}
```

`__yo_new___yo_t20` (the `File` constructor, now five parameters) appears in that
file **only** as a declaration and a definition — there is no call site anywhere.
Codegen did not emit a short call; it emitted nothing.

The evaluator check is demonstrably alive — the same omission outside an
`io.async` closure is rejected:

```
$ yo check tmp/missfield_sync.yo
check: error in: Error: Type member "c" is not provided and has no default value or assigned value.
```

Running clang by hand with HEAD's exact release flag list
(`src/main.yo:1854-1859`) over that same emitted C:

```
$ clang -Wno-everything -Wincompatible-pointer-types -Wint-conversion \
        -Wimplicit-function-declaration -Werror=return-type -O2 -c td.bin.c
td.bin.c:6658:1: error: non-void function does not return a value in all control paths [-Werror,-Wreturn-type]
```

The build only succeeded during this investigation because the `yo` binary on
PATH was the released **0.2.16**, which predates `dd4dbbf5a` (landed
2026-08-25 20:26, in HEAD, in no tag).

Three minimal synthetic repros behave identically — ref struct in the same
module, ref struct reached module-qualified (`_thing_mod.Thing(...)`, the shape
`temp.yo` uses), and a plain value struct: all three emit
`// Failed to transpile` for the binding, none emits a short literal.

### Residual gap — why this stays OPEN

`-Werror=return-type` is a backstop on the SYMPTOM, and three holes remain:

- ~~**`-O0` only warns.**~~ **NOT A GAP — this was measured wrong.** PR #275
  (`dd4dbbf5a`) put `-Werror=return-type` on **both** arms, not just the
  optimised one: `src/main.yo:1871` adds it to the `-Wall -Wextra …` `-O0` arm
  alongside `src/main.yo:1859` on the release arm. A default build rejects this
  C exactly as `--release` does.
- **A `unit`-returning function is not covered at all.** If the FTT'd
  construction sits in a function with no return value, nothing fires and the
  statement is silently dropped — missing side effects rather than
  uninitialised memory.
- **The diagnostic is wrong.** The user gets a C-level "does not return a
  value" against a generated line, not `Type member "_probe" is not provided`.
  The real error was computed and then discarded.

The cure is still to stop swallowing the evaluator error for async-closure
bodies (the wider strict-mode campaign).

### The codegen arity assertion is NOT a fix for this — it would be dead code

An assertion in the constructor / compound-literal emit paths
(`src/codegen/exprs/other_fn_call.yo:1513` and `:1636`) **can never fire for
this bug**, because codegen never reaches those paths: the statement is FTT'd
first. Shipping it would buy false confidence.

If it is wanted anyway as a diagnostics upgrade, the safe form is narrow and
provably free of false positives:

- the object constructor's parameter list is built from
  `get_runtime_struct_fields(type)` (`src/codegen/functions/constructors.yo:46`),
  which is the **same view** `ctor_rt_n` uses at `other_fn_call.yo:1530` — so
  `ctor_args.len() != ctor_rt_n` is an exact arity contradiction,
- and any such mismatch that survives today already emits a wrong-arity
  `__yo_new_…(…)` call (ref path) or a `.label = ` with no initializer (value
  path), both of which are **guaranteed C errors**.

So it can only ever turn a guaranteed clang error into a better message. It is a
diagnostics improvement, never a memory-safety backstop, and it must be labelled
as such. Note also that fields with a declared default (`?=`, used heavily in
`std/build.yo`) are legitimately absent from the call site, so the gate must key
off the post-recovery `ctor_args` / `vs_args` length and never off the raw
labeled-argument count.

## Expected

A struct literal missing a required field should be a hard evaluator error
naming the field and the literal's location, in the same way a wrong-typed
argument is rejected. Fields with a declared default (`?=`) may of course be
omitted.

## Reproduce

As originally recorded (against `340a9e735`, before `_pos` was added):

1. `git checkout 340a9e735`
2. Add a fourth field to `File` in `std/fs/file.yo`:
   `_pos : u64` (any type without a default).
3. Do NOT update `std/fs/temp.yo:185`.
4. `yo check ./std` → 153/153 passed, rc=0.
5. `yo test tests/fs/temp.test.yo --parallel 1` → 6 tests fail with exit code 11.

On a tree where `_pos` is already present, add a FIFTH field instead
(`_probe : u64`), update only the `File(...)` at `std/fs/file.yo:82`, and leave
`std/fs/temp.yo:185` short. Then compile a standalone driver that calls
`TempFile.new(io)` — a `.test.yo` file cannot be given to `yo compile`.

Note step 5 only reproduces the SIGSEGV with a `yo` binary that predates
`dd4dbbf5a`; with #275's flags the C compile fails instead.

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
