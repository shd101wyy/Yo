type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  length: (x: &Data)-> i32;
}

type Test = {
  x: {x: Data},
  y: {y: Data}
}


let main = ()-> {
  let x = malloc();
  let y = malloc();
  let z = Test {
    x: {x: x}, // FIXME: the order prevented setting like this
    y: {y: y}  // IDEA: We consume only in the end of each expression in block
  };
  consume(z);
}