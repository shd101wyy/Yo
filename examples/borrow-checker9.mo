
type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}

let test = ()-> {
  let mut x = malloc();
  let y = &!x;
  consume(x); // Error: x is borrowed
}