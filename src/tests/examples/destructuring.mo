x := (a: 1, b: 2);

// Destructuring by position
(m, n) := x;

// Destructuring by label
(.a, .b) := x;

// Renaming
(.a: u, .b: v) := x;