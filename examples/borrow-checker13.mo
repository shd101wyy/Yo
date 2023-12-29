type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}
enum Color {
  Red,
  Green,
  Blue,
}


let test = (color: Color)-> {
  let x = malloc();
  match Color {
    case Red: {
      consume(x);
    }
    case Green: {
      consume(x);
    }
    case Blue: {
      consume(x);
    }
  }
}