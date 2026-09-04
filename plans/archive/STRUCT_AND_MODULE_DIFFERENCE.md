> **ARCHIVED 2026-09-04 — TS-era scratch note** on struct-vs-module comptime-field
> rules. The authoritative semantics live in `docs/en-US/` and the yo-syntax
> instruction files.

- struct can only hold runtime fields, while module can hold both runtime and compile-time fields.
- module value can only be assigned to comptime variable, while struct value can be assigned to both comptime and runtime variables.

- Why do we need to differentiate between struct and module. For example:

Point :: struct(x: i32, y: i32);
p :: Point(1, 2); // p has comptime fields x == 1, y == 2;

mut(x) := 12; // x is runtime variable
p :: Point(x, 2); // should give error because Point(x, 2) is a runtime value, and cannot be assigned to comptime variable p.

// But this case should be allowed to module:
mut(x) := 12;
m :: SomeModule(x: x); // module can take runtime values as fields, and can be assigned to comptime variable m.
