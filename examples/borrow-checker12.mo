type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}


let test = (flag: boolean)-> {
  let x = malloc();
  if (flag) {
    consume(x);
  } else {
    consume(x);
  }

  // consume(x); // error
}