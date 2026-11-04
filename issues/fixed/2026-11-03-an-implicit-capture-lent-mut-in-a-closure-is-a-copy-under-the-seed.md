# An implicit capture lent `&mut` inside a closure is a copy under the v0.2.73 seed

**Severity:** S1. A compiler that the v0.2.73 seed built from the B8 tree wrote a corrupt `<out>.imports` file on every `yo build`, so no project could build with it, the compiler itself included. The cause is a seed miscompile of valid code: the elements a closure moves out of a captured list are freed again with the closure's environment.

Found 2026-11-03 by v5gb on the B8 flip (`vbd/b8-arraylist-string-flip-r4`). The `yo-tree-a1196b7c9` binary, and every later B8 or B9 tree binary built by the seed, failed `tests/cli-cases/build-path-dep-import` and `build-run` with:

```
yo: error: --imports yo-out/x86_64-unknown-linux-gnu/bin/app.imports: line 1 is not "name=/path/to/root.yo": ��`    lib/src/lib.yo
```

The file should hold `mylib=mylib/src/lib.yo`. Instead, its first 8 bytes were an allocator free-list pointer: the line's buffer had already been freed when the stamp writer copied it.

## Reproducer

```yo
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ RefCell } :: import("std/sync/refcell");
{ println } :: import("std/fmt");
(g_lines : RefCell(ArrayList(String))) = RefCell(ArrayList(String)).new(ArrayList(String).new());
fill :: (fn() -> unit)({
  mut(lines) := ArrayList(String).new();
  lines.push(String.from("mylib=mylib/src/lib.yo"));
  g_lines.with_mut(xs => xs.append(&mut lines));
});
main :: (fn() -> unit)({
  fill();
  println(g_lines.with(xs => xs(usize(0)).clone()));
});
export(main);
```

`yo compile repro.yo --std-path <B8 std> --sanitize address --allocator system` behaves differently depending on which compiler builds it:
- With the v0.2.73 seed, ASan reports `heap-use-after-free` (READ of size 22) at the `println`.
- With the B8 tree compiler, the program prints the line and ASan stays clean.

## Root cause

The implicit capture moves `lines` into the closure's environment, and the checker accepts this: a later read of `lines` is E0901 under both compilers. The seed then passes that environment to `with_mut` by value, and lowers `&mut lines` inside the body to a pointer into a copy of it. `append` moves the elements into the global and sets the copy's length to zero. The environment that is finally dropped is a different copy, which still has the old length, so it frees the strings the global now holds.

Before B8 the list was a `ref` handle: the copy and the original were one object, and `append` emptied both. The B8 tree compiler writes the environment's own capture, so only a seed-built binary has the bug.

## Fix

Three `src/` sites have this shape: `xs.append(&mut <local>)` inside a `with_mut` closure with no capture list. They are `resolve_build_import_roots` (`src/build_runner.yo`, the `.imports` corruption), `_rerun_pending_def_evals` (`src/evaluator/calls/function_type.yo`) and `_clear_pragma_for_module` (`src/evaluator/memory_safety.yo`).

Each now moves the list in through the capture list and consumes it: `g.with_mut({ lines }(xs) => xs.extend(lines))`. Both compilers build that shape correctly; the seed-built binary was checked under ASan.

The other closures that write an outer local were found with `vbd-logs/b8/scripts/implicit_capture_write_scan2.py` over `src/` and `std/`, and they do not move elements out of the capture.

## Test

`tests/closure_capture_list.test.yo`, "an implicit capture lent &mut inside a closure moves its elements out exactly once": a global filled through `xs.append(&mut lines)` holds both lines intact. It fails under the seed (exit 256, the use-after-free) and passes under the B8 tree compiler.
