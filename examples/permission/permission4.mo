
type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
  length: (x: &Data)-> i32;
}

let main = ()-> {
  let mut x = malloc();
  let xRef: &Data = x;
  // let xRef = &x;
  let a = &xRef;
  let mut x2 = x;
  let mut b = @x2;
  consume(x2);
}