# yo-self evaluator: stack overflow on default 8MB macOS main-thread stack

## Status

OPEN (workaround: `ulimit -s 65520` before running yo-self-bin)

## Symptoms

When the yo-self compiler evaluates large prelude files (e.g. `std/prelude.yo`),
the binary crashes with a silent SIGSEGV after ~900+ eval iterations. The crash
is timing-sensitive (inserting `eprintln` shifts where it occurs), no error
message is printed, and exit code is 139 / SEGV.

## Diagnosis

lldb backtrace at the crash point shows ~43 frames of the recursive evaluator
chain (`evaluate_expression` → `evaluate_function_call` → `evaluate_function_type`
→ `evaluate_function_parameter` → ... → `evaluate_enum_type` → `__yo_decr_rc`
→ `__yo_dispose_dispatch`). The crash site is the function prologue of
`__yo_dispose_dispatch`, with the faulting address one page above `sp`. The
stack-readable memory is exhausted: `frame variable` reports "read memory from
0x16f5ea780 failed".

In other words: the recursive evaluator carries large by-value structs
(`AstExpr`, `TypeValue`, `Environment`, cleanup blocks) on the stack. Each
frame can be several KB; ~50 deep frames + their cleanup machinery exceeds the
default macOS 8 MB main-thread stack soft limit.

## Workaround

Raise the soft stack limit before invoking yo-self-bin:

```bash
ulimit -s 65520   # 64 MB, macOS hard limit
./yo-self-bin check std/prelude.yo
```

With this, prelude evaluation advances past the crash. The next failure exposed
is a real evaluator gap (`-(1)` not accepted as comptime-int in enum
discriminant) — that is tracked separately.

## Why doesn't TypeScript hit this?

Node's V8 manages a much larger default stack and JS frames hold only heap
pointers — not by-value structs. The deep recursion in the TS evaluator is
cheap. In Yo, every frame copies all expression/type/environment payloads.

## Possible fixes (long-term)

1. Call `setrlimit(RLIMIT_STACK, …)` from the generated C `main()` for yo-self-bin
   specifically, before `__yo_user_main` runs.
2. Switch the hot recursive sites to use boxed (`Box(T)`) parameter passing so
   only pointers are on the stack.
3. Refactor the eval pipeline to use an explicit stack/queue instead of native
   recursion.

For now the `ulimit` workaround is sufficient to continue bootstrapping work.

## Reproduction

```bash
./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin
/tmp/yo-self-bin check /tmp/test_simple_prelude.yo   # SIGSEGV
(ulimit -s 65520; /tmp/yo-self-bin check /tmp/test_simple_prelude.yo)  # advances past
```

where `/tmp/test_simple_prelude.yo`:

```rust
main :: (fn() -> unit)({
  x := i32(42);
  ()
});
export(main);
```
