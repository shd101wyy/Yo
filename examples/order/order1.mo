
type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: (x: Data)=> ();
  length: (x: &Data)=> i32;
}

let main = ()=> {
  let x = malloc();
  let y = malloc();
  let z = malloc();

  consume(z);
  consume(y);
  consume(x);
}