
type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
  length: (x: read Data)-> i32;
}

let main = ()-> {
  let x = malloc();  
  let xRef = read x;
  let len = length(xRef);
  consume(x);
  
  // let len2 = length(xRef); error:
}