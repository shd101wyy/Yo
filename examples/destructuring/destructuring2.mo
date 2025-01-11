type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  length: (x: &Data)=> i32;
}

type Coord = {
  x: Data,
  y: Data
}

let main = ()=> {
  let coord = Coord {
    x: malloc(),
    y: malloc()
  };
  let {x, y} = coord;
  consume(y);
  consume(x);
}