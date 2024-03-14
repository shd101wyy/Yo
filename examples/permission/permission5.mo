
type Data: Linear;
extern "C" {
  malloc: ()-> Data;
}

let test = ()-> {
  let x = malloc();
  let y: read Data = x;
  let z: read Data = y;
  consume(x);
}