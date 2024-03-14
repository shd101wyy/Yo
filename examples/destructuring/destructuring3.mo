type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: read Data)-> i32;
}

type Coord = {
  x: Data,
  y: Data
}

let main = ()-> {
  var coord = Coord {
    x: malloc(),
    y: malloc()
  };
  var ref = write coord;
  var x = write ref.x;
  let old = (x = malloc());
  consume(old);
  consume(coord);
}