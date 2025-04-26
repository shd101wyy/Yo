// Struct destructuring
Named :: struct(x: i32, y: boolean);
p := Named(1, false);

// Destructuring by position
Named(m, n) := p;

// Destructuring by label
// Named(.x, .y) := p;

// Renaming
Named(x: a, y: b) := p;
i := a;

// Inferred struct
_(x, y) := p;
_(.x, .y) := p;
_(x: a, y: b) := p;