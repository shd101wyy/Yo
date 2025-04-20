// Tuple desturcturing
x := (a: 1, b: true);

// Destructuring by position
(m, n) := x;

// Destructuring by label
(.a, .b) := x; // a == 1, b == true

// Renaming
(a: u, b: v) := x; // u == 1, v == true

// i := a;
i := u;
j := v;
z := x.a;