type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}

let test = ()-> {
  var x = malloc();
  let y = &!x;
  consume(x); // Error: x is borrowed
}