
type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
  length: (x: read Data)-> i32;
}

let main = ()-> {
  var x = malloc();
  let xRef: read Data = x;
  // let xRef = read x;
  let a = read xRef;
  var x2 = x;
  var b = write x2;
  consume(x2);
}