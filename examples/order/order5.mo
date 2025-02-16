
type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: <T>(x: T)-> ();
  length: (x: &Data)-> i32;
}

let test = (flag: boolean)-> {
  let x = malloc();  
  let y = {
    &x
  }
  consume(x);
  // length(y);
}