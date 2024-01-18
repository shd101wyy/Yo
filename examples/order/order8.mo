type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: read Data)-> i32;
  testOrder: (x: Data, y: Data)-> ();
}

let main = ()-> {
  let x = malloc();
  let y = malloc();
  testOrder(x, y);
}