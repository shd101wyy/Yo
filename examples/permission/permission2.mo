
type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: &Data)-> i32;
}

let main = ()-> {
  let x = malloc();  
  let xRef = &x;
  let len = length(xRef);
  consume(x);
  // let len2 = length(xRef); error:
}