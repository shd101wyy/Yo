type Coord = {
  x: write i32;
  y: write i32;
}

let test = (c: Coord)=> {
  let a = 1;
  c.x = write a; // Error: Cannot reseat a reference
}

let main = ()=> {
  let a = 1;
  let b = 2;
  let coord = Coord { x: write a, y: write b }; // This is not allowed
  test(Coord { x: write a, y: write b }); // This is allowed
}

// ==================================================

let test = (x: write i32, y: write i32)=> i32 {
  x = x + 1;
  y = y + 1;
  x * y
}

// ==================================================
// Group (x: write i32, y: write i32) into a struct


// Problem

let test = ()=> {
  let x = String.from("Hi");
  let y: read String = read x;
  drop(x);
  println(y); // Dangling reference
}