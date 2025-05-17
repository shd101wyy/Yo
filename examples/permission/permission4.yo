
type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
  length: (x: &Data)-> i32;
}

let main = ()-> {
  var x = malloc();
  let xRef: &Data = x;
  // let xRef = &x;
  let a = &xRef;
  var x2 = x;
  var b = @x2;
  consume(x2);
}