type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}

let length = <T:Type, R:Region>(x: &<T,R>) -> i32 {
  0  
}

let test = ()-> {
  let x = malloc();
  let ref = &x;
  let len = length(ref);
  {
    let ref = &x;
  }
  consume(x);
}