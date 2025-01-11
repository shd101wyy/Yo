type Coord = {
  x: i32,
  y: i32
}

let main = ()=> {
  let mut p: Coord = { x: 1, y: 2 };
  let pRef = &!p;
  let pRef2 = &!p.y; // error: p is already borrowed
}