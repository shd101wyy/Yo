
type Data: Linear;
extern "C" {
  malloc: ()=> Data;
}

let test = ()=> {
  let x = malloc();
  let y: &Data = x;
  let z: &Data = y;
  consume(x);
}