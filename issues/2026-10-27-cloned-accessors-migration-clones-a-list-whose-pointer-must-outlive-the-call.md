# cloned-accessors migration clones a list whose pointer must outlive the call

**Severity:** S2 — `yo fix --migrate cloned-accessors` rewrote a call site whose
whole contract is that the container's storage outlives a C call
(`_exec_argv`, the test runner's RSS-valve exec-restart), so every `yo test`
run of a self-host-built compiler failed with
`exec-restart: execve failed rc=-1` ("the batch failed to compile", 0 of N
tests ran) until the site was reverted.

## Symptom

```text
$ yo test tests/option_result_combinators.test.yo --parallel 1 --std-path ./std
Using system allocator
exec-restart: execve failed rc=-1 — exiting instead
yo: error: test: ... — 0 of 54 tests in this batch ran: the batch failed to compile
```

The same command with a develop-built binary passes (54/54). The failing
binary was built from a tree whose only relevant change was the B6-c
cloned-accessors sweep over `src/main.yo`.

## Root cause

`_exec_argv` (src/main.yo) builds `argv` for `execve` out of C-string storage
that is DELIBERATELY LEAKED so it outlives the exec — its comment says so.
The site read each argument with `exec_cstrs.get(xj)` (a share of the leaked
list, whose `.ptr()` stays valid). The migration renamed it to
`exec_cstrs.get_cloned(xj)`: the clone is a temporary ArrayList; `cs.ptr()`
pointed into the TEMPORARY's buffer, and the temporaries drop at the loop
iteration's end — the argv pointers handed to `execve` dangle (freed or
reused storage), and execve fails.

The migrator's guards cover a raw pointer recorded against the SOURCE
container (`record_copy_pointer`), but not a pointer taken out of the CLONE
the accessor returns. Site reverted to `.get` with a comment; a scan found no
other `get_cloned(...)`-then-`.ptr()` shape in the tree.

## Reproducer / test

Any `yo test <file>` through a compiler built from the swept tree before the
revert (e.g. `tests/option_result_combinators.test.yo`); after the revert the
same run passes. The guard gap in the tool remains open for a future fix
(record a pointer-reach for the clone's own buffer too).

## Fix

The site (B6-c src half). The tool's guard gap (clone-then-ptr) is open for
the migrator's owner.
