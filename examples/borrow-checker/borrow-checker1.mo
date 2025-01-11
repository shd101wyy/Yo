
type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: (x: Data)=> ();
}

let test = (x: Data)=> Data {
  let a = malloc();
  consume(a);
  x
}