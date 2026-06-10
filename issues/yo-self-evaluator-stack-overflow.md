# yo-self evaluator: stack overflow on default 8MB macOS main-thread stack

## Status

**FIXED** — the generated `main()` now runs the whole program body on a
dedicated POSIX worker thread with a 1 GiB stack (commit on
`feat/bootstrapping-evaluator`). `ulimit -s 65520` is **no longer
required**: `check std/prelude.yo` passes at the default 8 MB stack.

Verified: at `ulimit -s 8192`, the old binary SIGSEGVs on
`std/prelude.yo` (exit 139) while the new binary exits 0.

## Fix

`generateMainWrapper` (`src/codegen/functions/generation.ts`) emits, for
POSIX native targets (`isTargetPosix`), a `__yo_main_thread_entry`
function holding the program body (async scheduler init, module-level
variable init, `__yo_user_main`, `__yo_async_wait_all`). `main()` sets
the arg globals, then `pthread_create`s that entry on a
`pthread_attr_setstacksize(…, 1 GiB)` thread and `pthread_join`s it. The
macOS main thread is hard-capped at ~64 MiB; a pthread stack is not. The
1 GiB reservation is virtual-only (committed on touch), so ordinary
programs pay nothing. The async runtime's scheduler-init flag and task
queue are thread-local, so they correctly live on this worker thread.
Windows / WASM keep the direct main-thread call. Thread-safety verified
against the async/thread/parallelism test suites.

## NOTE — this was NOT what blocked the net/sys/http std files

The earlier survey labelled 13 `net/*` `sys/*` `http/*` files as
"stack-overflow" failures. That was a **misdiagnosis**. With the
worker-stack fix in place they still fail, deterministically and at a
shallow depth, with genuine evaluator-coverage gaps:

- **9 files** (`sys/socket.yo`, `sys/tcp.yo`, `sys/udp.yo`,
  `sys/unix.yo`, `net/tcp.yo`, `net/udp.yo`, `net/dns.yo`,
  `http/client.yo`, `http/index.yo`):
  `Expected bool type for "or" argument, got: platform == (Platform.Macos)`.

  **Root cause (pinned):** comptime comparison operators produce a
  `unit`-typed result instead of `bool`. Minimal repro:
  `(r : bool) = ("a" == "a");` → `Incompatible types: Expected bool,
Given unit`. This is NOT string-specific — `(i32(1) == i32(1)) ||
(i32(1) == i32(1))` fails the same way. `==` (an operator-trait /
  `Eq` dispatch) falls into the evaluator's unbound-operator-name
  fallback in `evaluator/exprs/identifer_and_operator.yo`, which returns
  `UnknownVal(t_unit())`; the call result therefore types as `unit`.
  `cond` tolerates a non-`bool` condition, which is why a bare
  `cond((a == b) => …)` passes — but `||`/`&&`
  (`evaluator/builtins/and_or.yo`) and `bool`-typed bindings strictly
  require `is_bool_type`, so they reject it. `platform` and
  `Platform.Macos` are both comptime strings, so socket.yo's
  `(platform == Platform.Macos) || (platform == Platform.Windows)`
  hits exactly this.

  The crash (139) is secondary: `_evaluate_expression_wrapper` prints the
  error and unwinds with a `make_err_expr()` placeholder, and evaluation
  limps on with that placeholder until a downstream access segfaults.

  **Real fix:** port comptime operator-trait (`Eq`/`Ord`/…) dispatch so
  comparison operators on comptime values resolve to their impl and type
  as `bool`. Sizable evaluator-coverage work; would unblock all 9 files
  at once.

- **`build.yo`**: `evaluate_yo_build_functions: not yet implemented`.
- **`env.yo`, `os/env.yo`, `fs/temp.yo`**:
  `Failed to import module "./libc/stdlib"`.

These are tracked as evaluator-coverage work, separate from the stack
issue. The dominant one (comptime-string `==` → bool) would unblock 9
files at once.

## Original report (for history)

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
