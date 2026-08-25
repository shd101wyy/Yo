# A function whose body is ONE inline-builtin call is emitted with the CALLER's arguments

**Status: FIXED 2026-08-25.** `is_function_value_with_only_builtin_yo_inline_function_call`
(`src/codegen/utils/index.yo`) now also requires the body call to pass the
function's parameters through unchanged and in order; when it does not, the
wrapper is emitted as a real C function and called normally. Regression tests:
`tests/inline_builtin_alias.test.yo` (computed argument, reversed parameters,
and a straight pass-through that must still inline) — red-first verified, the
first two fail with exit code 6 on the unfixed compiler. `std/time/sleep.yo`'s
`sleep_blocking` is back to its natural one-expression body, and the
"never wrap an inline builtin in a ONE-EXPRESSION body" section added to
`.github/instructions/yo-design.instructions.md` as a workaround is deleted.

Found 2026-08-25 while implementing STD_API_AUDIT §5
(`time.sleep(Duration, io)` / `time.sleep_blocking(Duration)`).

**Severity:** silent miscompilation. When the wrapper's argument types happen to
match the caller's, no diagnostic is produced at all — the program just does the
wrong thing.

## Symptom

Codegen elides a user function whose body is a single call to a builtin
"inline" function (`__yo_op_add`, `__yo_ms_sleep`, …) and emits the builtin
directly at the call site — **substituting the caller's argument codes**. The
argument expressions written in the wrapper's own body are discarded.

For genuine operator aliases (`add : (fn(a, b) -> T)(__yo_op_add(a, b))`) the
caller's args and the body's args coincide, so the substitution is accidentally
correct. As soon as the body computes anything from its parameters, it is wrong.

## Minimal reproducer (measured, silent)

`issues/repros/inline-builtin-alias-drops-body-arguments.yo`:

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/libc/stdio"));
{ Instant } :: import("std/time/instant");
extern(
  "Yo",
  __yo_ms_sleep : (fn(ms : usize) -> unit)
);
/// Body sleeps HALF of `ms`.
half_sleep :: (fn(ms : usize) -> unit)(
  __yo_ms_sleep(ms / usize(2))
);
main :: (fn() -> unit)({
  t := Instant.now();
  half_sleep(usize(200));
  e := t.elapsed();
  unsafe(printf("half_sleep(200) slept %lld ms (correct: ~100)\n", e.as_millis()));
});
export(main);
```

```
$ yo compile issues/repros/inline-builtin-alias-drops-body-arguments.yo --release -o /tmp/repro.out
Using system allocator                      # compiles clean, no warning

$ /tmp/repro.out
half_sleep(200) slept 202 ms (correct: ~100)
```

Emitted C — the `/ 2` is gone, and `half_sleep` has no C definition at all:

```c
usleep((200ULL) * 1000);
```

## Second reproducer (this one at least fails loudly)

The shape that exposed the bug. A `Duration`-taking wrapper:

```rust
sleep_blocking :: (fn(duration : Duration) -> unit)(
  __yo_ms_sleep(usize(duration.as_millis()))
);
```

emits the `Duration` struct straight into `usleep`:

```
tmp/sleep_probe.out.c:4014:36: error: invalid operands to binary expression
      ('__yo_t11' (aka 'struct __yo_t11_struct') and 'int')
 4014 |   usleep((_file____User_temp_9182) * 1000);
```

`__yo_t11` is `Duration`; `_file____User_temp_9182` is `yo_id_6817(60LL)`, i.e.
`Duration.from_millis(60)` — the *caller's* argument. The body's
`usize(duration.as_millis())` never appears.

## Root cause

`is_function_value_with_only_builtin_yo_inline_function_call`
(`src/codegen/utils/index.yo:717`) returns the builtin's name whenever the
function body is a single call to a builtin inline function (optionally wrapped
in `unsafe` and/or a one-expression `begin`). It inspects only the **callee
name** of that body call — never its argument list.

Two consumers then emit the builtin with the **caller's** argument codes:

- `src/codegen/exprs/other_fn_call.yo:1880` — registered (named) function call:
  ```
  match(is_function_value_with_only_builtin_yo_inline_function_call(fv),
    .Some(op) => return(Option(String).Some(
      generate_yo_inline_function_call(op, args2, expr, context, indent.clone()))),
    .None => ());
  ```
  `args2` are the caller's generated args. This is the path the reproducer
  above takes.
- `src/codegen/exprs/other_fn_call.yo:1188` — the method-call equivalent, which
  builds `inline_args` from `dm_runtime` (again the caller's runtime args) and
  ref-amps them before the same substitution. So a *method* whose body is a
  single builtin call with computed arguments has the same defect.

The two other callers of the predicate are NOT affected — they consult it only
to special-case `BF_YO_ARRAY_INDEX` and otherwise fall back to a by-name call
(`src/codegen/exprs/generation.yo:446`, `src/codegen/exprs/ptr_fns.yo:141`).

Separately, `src/codegen/functions/declarations.yo:517` uses the same predicate
to SKIP emitting the function's C definition. That is why the substitution
cannot simply be deleted: with no definition emitted, a by-name call would
reference an undeclared function (exactly the failure the comment at
`other_fn_call.yo:1152` describes). Predicate and skip must be tightened
together.

## Suggested fix

Make the predicate structural, not name-only: return `.Some(op)` **only** when
the body call's argument list is exactly the function's parameters, in order,
as bare atom references (arity equal, each arg an `Atom` naming param *i*).
Anything else — a cast, a method call, a reordering, a constant, a differing
arity — must return `.None` so a real C function is emitted.

Genuine operator wrappers satisfy that condition, so the fix should be
byte-identical on the existing corpus; that is the acceptance test
(record corpus sha256 before editing, expect same=N diff=0).

`__yo_as` is already excluded by name for a related reason ("needs proper call
handling for complex args") — this is the general form of that same problem.

## Workaround in place

`std/time/sleep.yo` writes `sleep_blocking` with a two-statement body so the
predicate does not fire (a `begin` with more than one expression is not
unwrapped):

```rust
sleep_blocking :: (fn(duration : Duration) -> unit)({
  ms := usize(duration.as_millis());
  __yo_ms_sleep(ms)
});
```

The comment there points back at this file. Remove the workaround comment (the
binding may stay, it reads fine) once the predicate is fixed.

## Blast radius to check when fixing

Every `extern("Yo", ...)` builtin listed in `BuiltinYoInlineFunctions`
(`src/codegen/constants.yo:74`) can be wrapped this way. Wrappers around the
arithmetic/comparison builtins in `std/prelude.yo` are the population most
likely to exist today; all of them appear to be straight parameter forwards,
which is why this has gone unnoticed.
