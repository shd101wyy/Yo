type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: (x: Data)=> ();
}


let test = ()=> {
  let mut x = malloc();
  consume(x);
  let y = (x = malloc()); // y == ()
  consume(x);
}