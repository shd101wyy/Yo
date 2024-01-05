type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}

let main = ()-> {
  let mut x = malloc();
  let oldX = (x = malloc());
  consume(x);
  consume(oldX);
}