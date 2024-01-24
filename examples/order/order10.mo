type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: read Data)-> i32;
}


let main = ()-> {
  let x = malloc();
  let y = malloc();
  let arr = [x, y];
  @consume(arr);
}