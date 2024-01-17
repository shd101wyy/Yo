type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: <T>(x: T)-> ();
  length: (x: read Data)-> i32;

  testOrder: (x: read Data, y: read Data)-> ();
}

let main = ()-> {
  let x = malloc();
  let y = malloc();

  let xRef = read x;
  let yRef = read y;

  testOrder(xRef, yRef);
  // testOrder(yRef, xRef); // error

  consume(y);
  consume(x);
}