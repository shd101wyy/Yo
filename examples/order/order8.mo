type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: <T>(x: T)-> ();
  length: (x: read Data)-> i32;

  testOrder: (x: Data, y: Data)-> ();
}

let main = ()-> {
  let x = malloc();
  let y = malloc();

  testOrder(x, y);
}