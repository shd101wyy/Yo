type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}

let main = ()-> {
  var x = malloc();
  let oldX = (x = malloc());
  consume(x);
  consume(oldX);
}