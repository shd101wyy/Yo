
// Runtime immutable variable
x : i32;

// Runtime mutable variable
mut(x) : i32;

// Compile-time immutable variable
compt(x) : i32;

// Compile-time mutable variable
compt(mut(x)) : i32;

// Runtime immutable variable
x := 12; 

// Runtime mutable variable
mut(x) := 12;

// Compile-time immutable variable
x :: 12;

// Compile-time mutable variable
mut(x) :: 12;