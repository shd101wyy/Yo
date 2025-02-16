type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: &Data)-> i32;
}

type Coord = {
  x: Data,
  y: Data
}

let main = ()-> {
  let mut coord = Coord {
    x: malloc(),
    y: malloc()
  };
  let mut ref = @coord;
  let mut x = @ref.x;
  let old = (x = malloc());
  consume(old);
  consume(coord);
}