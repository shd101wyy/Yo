type Data: Linear;
extern "C" {
  malloc: ()-> Data;
}

let test = ()-> {
  let x = malloc();
  let y = malloc();

  consume(x);
  consume(y);
}