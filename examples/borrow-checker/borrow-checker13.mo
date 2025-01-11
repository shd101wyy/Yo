type Data: Linear;
extern "C" {
  malloc: ()=> Data;
  consume: (x: Data)=> ();
}
enum Color {
  Red,
  Green,
  Blue,
}


let test = (color: Color)=> {
  let x = malloc();
  match (color) {
    Red => {
      consume(x);
    }
    Green => {
      consume(x);
    }
    Blue => {
      consume(x);
    }
  }
}