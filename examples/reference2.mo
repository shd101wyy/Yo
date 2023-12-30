type Data: Linear;
extern "C" {
  malloc: ()-> Data;
  consume: (x: Data)-> ();
}

let anotherLength = <T:Type, R:Region>(x: &<T,R>) -> i32 {
  0
}

let length = <X:Type, P:Region>(x: &<X,P>) -> i32 {
  anotherLength(x)
}
