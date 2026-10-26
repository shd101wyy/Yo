# `Option.unwrap` cannot move a move-only payload out

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN — found 2026-10-23 while moving the std resources to move-only values (plans/VALUES_BY_DEFAULT.md V3, std half).

## What happens

`Option(T).unwrap` takes `self : &Self` and returns `T`. For a move-only `T`, the return copies the payload out of a borrow, which is E0901:

```yo ignore
r := child.take_stdout().unwrap();
// error[E0901]: use of moved value: cannot copy `value`, whose type `ChildStdout`
// is move-only, and it cannot be moved either: it is borrowed
```

`expect`, `unwrap_or`, `unwrap_or_else` and `unwrap_or_default` fail the same way. Since V3 every std resource is move-only: `File`, `TcpStream`, `ChildStdin`/`ChildStdout`/`ChildStderr`, `TlsStream` and the rest. So `child.take_stdout().unwrap()` fails, and so does unwrapping any `Option(File)`. The workaround is a consuming match:

```yo ignore
r := match(child.take_stdout(), .Some(h) => h, .None => __yo_panic("stdout was not piped"));
```

std and the tests use this form (`std/http/client.yo`, `tests/process/command.test.yo`).

## Options

1. **Make the extracting methods consume.** Use `unwrap(sink(self) : Self) -> T`, and likewise for `expect`, the `unwrap_or*` family and their `Result` counterparts. This is Rust's shape.
   - On a named `Copy` option the call copies it, as it does today.
   - On a named non-`Copy` option it moves it, which is what an extraction means.
   - Cost: `src/` and `std/` need a sweep for calls that unwrap the same option twice, because each of those becomes E0901.
2. **Add consuming twins** (`into_inner`, `take_value`, …) beside the borrowing methods. That is two spellings for one operation, against the one-name-per-operation rule (STD_API_AUDIT D2).
3. **Keep it as is** and teach the consuming `match`.

## Recommendation

Option 1, done with V3's src half. It is how Rust's `Option` works, and std's resource API only reads naturally if `unwrap` can hand a resource out. Today's `&Self` receiver was chosen when every payload could be copied.
