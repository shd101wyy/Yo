d := (a: 1, b: true, c: (x: 2, y: false));

// Destructuring by position
(m, n, (x, y)) := d;

// Destructuring by label
(c: (.y, .x), a: m, .b) := d;

// Different types of data structures
SomeStruct :: struct(
  x: i32,
  y: boolean 
);

d := (a: 1, b: SomeStruct(2, false));

// Support destructuring struct
(a, _(x, y)) := d;
/// or
(a, _(x, y)) := d;

