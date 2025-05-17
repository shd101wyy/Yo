type Coord = {
  x: @i32;
  y: @i32;
}

let test = (c: Coord)-> {
  let a = 1;
  c.x = @a; // Error: Cannot reseat a reference
}

let main = ()-> {
  let a = 1;
  let b = 2;
  let coord = Coord { x: @a, y: @b }; // This is not allowed
  test(Coord { x: @a, y: @b }); // This is allowed
}

// ==================================================

let test = (x: @i32, y: @i32)-> i32 {
  x = x + 1;
  y = y + 1;
  x * y
}

// ==================================================
// Group (x: @i32, y: @i32) into a struct


// Problem

let test = ()-> {
  let x = String.from("Hi");
  let y: &String = &x;
  drop(x);
  println(y); // Dangling reference
}