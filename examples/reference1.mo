type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}

let anotherLength = <T:Type, P:Region>(x: &<T,P>) -> i32 {
  0
}

let length = <T:Type, R:Region>(x: &<T,R>) -> i32 {
  anotherLength(x)
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