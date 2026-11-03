# A std generic body's error, instantiated from std, names no call site

**Severity:** S3 (diagnostics only: the program is rejected correctly, but the
error points only into the generic body, so a std author cannot find the
caller; no wrong code, no user-facing wrong verdict)

**Found:** 2026-10-27 by the B8 std flip (branch `vbd/b8-arraylist-string-flip`,
plans/handover/VBD_LOOKAHEAD_2026-10-23.md §4.5 B8).

## The bug

When a std generic function's body is rejected while it is specialized for a
call that is ALSO in std, the error carries no note naming that call. After
the B8 flip (`String` and `ArrayList` are values), `ArrayList(String).get(i)`
is E0901 inside `get` (decision 20: the copy is the check), and `yo check
std/env.yo` reports only:

```text
error[E0901]: use of moved value: cannot copy `(_ptr.add)(index).*`, whose type `String` is move-only, ...
    --> std/collections/array_list.yo:454:49
note: while importing this module (import chain collapsed — the error above is from the imported file)
    --> std/process/index.yo:68:20
```

`--error-format json` has no call site either (`"notes":[]`). The caller was a
`self._args.get(i)` in `std/process/command.yo`, found by grepping the module
the import chain names. The B8 flip hit this shape at ~30 std modules.

The same shape in user code is reported well: a user generic body rejected for
a user call gets `note: in \`(b.peek)\`, instantiated here` at the call, and a
std body rejected for a USER call is re-anchored at that call
(`_reported_at_user_call`, `src/evaluator/calls/function.yo`).

## Root cause

`_with_instantiation_note` (`src/evaluator/calls/helper.yo`) adds no note when
the callee's body is in the standard library, because `evaluate_function_call`
re-anchors those errors at the USER's call. When the caller is in std too,
nothing re-anchors them, so neither mechanism names the call.

## Fix direction

Add the instantiation note when the callee is in std and the call site is in
std as well (the re-anchoring only covers a call outside std). A test: a
cli-case that checks a std-shaped fixture tree (`--std-path` at a fixture std
whose generic body copies a move-only element, called from another std file)
and expects the `instantiated here` note.
