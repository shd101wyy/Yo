// Struct destructuring
Point := struct(x: i32, y: i32);
p := Point(1, 2);

// Destructuring by position
Point(x, y) := p;

// Destructuring by label
Point(.x, .y) := p;

// Renaming
Point(.x: a, .y: b) := p;

// Inferred struct
_(x, y) := p;
_(.x, .y) := p;
_(.x: a, .y: b) := p;