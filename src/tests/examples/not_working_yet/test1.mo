// This is line comment
1 + 2;
/*
 * This is multiline comment
 */ a + b;
1.2 + 3 // This is line comment

x := 12;
y := true;
z := false;

x := [1, 2, 3];
y := (1, 2, 3);
z := (x: 1, y: 2);

x := "Hello, World!"; // This is string
y := 'a'; // This is character
z := (3 `add` 4);

is_zero? 0;    // identifier with ?
might_fail! 0; // identifier with !

[1, 2] ++ [3, 4];

block := {
  x := 1;
  y := 2;
  x + y
};