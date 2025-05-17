type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: <T>(x: T)-> ();
  length: (x: &Data)-> i32;

  testOrder: (x: &Data, y: &Data)-> ();
}

let main = ()-> {
  let x = malloc();
  let y = malloc();

  let xRef = &x;
  let yRef = &y;

  testOrder(xRef, yRef);
  // testOrder(yRef, xRef); // error

  consume(y);
  consume(x);
}