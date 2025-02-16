type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: &Data)-> i32;
}

type Test = {
  x: Data,
  y: Data
}


let main = ()-> {
  let x = malloc();
  let y = malloc();
  let z = Test {
    x: x,
    y: y
  };
  consume(z);
}