type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: read Data)-> i32;
}

let main = ()-> {
  let coord = {
    x: malloc(),
    y: malloc()
  };
  let {x, y} = coord;
  @consume(y);
  @consume(x);
}