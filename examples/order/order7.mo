type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: <T>(x: T)=> ();
  length: (x: &Data)=> i32;

  testOrder: (x: Data @2, y: Data @1)=> ();
}

let main = ()=> {
  let x = malloc();
  let y = malloc();

  testOrder(x, y);
}