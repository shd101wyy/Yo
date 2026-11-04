# A second instance of an origin-parameterized composite names the first one's origin

**Severity:** S2: an invalid program is accepted. A function declared `-> V(a)` may return a holder built over its other parameter `b`, so the caller freezes `a` and not `b`. Nothing reads a reference field before N1e-2, so no run-time access dangles yet. It is still a hole in the return rule that N3's cursors and entries would inherit.

**Status:** FIXED 2026-11-03 (vbd/d43-step4-n3, N3-0): the composite return rule checks the origin a result spells (E0923), and an origin-carrying instance renders its own origins.

## Reproducer

`issues/repros/2026-11-03-a-second-instance-of-an-origin-parameterized-composite-names-the-first-ones-origin.yo` passes `yo check`. Without `f`, `h` is still accepted, and a two-place probe shows the cause:

```yo ignore
v := V(x)(at : &x, lo : usize(2));
w := V(y)(at : &y, lo : usize(2));
(n : i32) = w; // E0601 "Given: V(origin(x))", where V(origin(y)) is expected
```

## Root cause

There are two defects, and the second one hid the first.

- **The return rule.** N2b's composite return rule (`reject_composite_result_local_roots`, `src/evaluator/utils.yo`) rejects a frozen root that is a LOCAL. It never compares a parameter root against the origin the result type SPELLS. The projection rule (`_spelled_origin_error`) makes that comparison for `-> &(T, o)`, but nothing does it for `-> V(a)`.
- **The display.** One instance id serves every origin (N2a T3: the constructor memo erases origins), and `register_type_display_name` keeps the first call's `Ctor(args)` for that id. So every later instance renders the first instance's places (`Given: V(origin(x))` for a `V(y)`). The memo hit itself restamps the instance's `type_arguments` correctly (`_restamp_instance_origins`). A `YO_DEBUG_ORIGIN_STAMP` probe confirmed it: `args=origin(y) carry0=true stas=1`. Only the rendering was wrong.

## Fix

- `fn_result_composite_origin_names` (`src/types/definitions.yo`) lists the origins a by-value result spells (none when one is elided). The composite return rule rejects a parameter root that those origins do not name, as E0923 (`E_ORIGIN_MISMATCH`), with the same parameter test as the projection rule (`fn_param_in_result_origin`).
- A constructor call whose arguments carry origins also registers a display template with a marker at each origin argument (`register_type_display_origin_template`). `type_to_string` fills each marker from the instance's own `type_arguments`.
- Tests are in `tests/borrow_spelling.test.yo`: a second instance's method, and the return rule as a `comptime_expect_error` (`whose origin does not name \`b\``).
