type Holder<T: Type> = {
  x: T;
  y: T;
}

let test = <X>(x: &X, y: &X)-> Holder<X> {
  var holder = Holder<&X> {
    x: x,
    y: y
  };
  // let z = 3;
  // holder.x = &z;
  holder               // We disallow to return any type that contains a `read` or `write` field that are defined in function body.
}