
type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}

let test = ()-> Data {
  let x = malloc();
  let y = &x;
  consume(x); // Error: x is borrowed
}