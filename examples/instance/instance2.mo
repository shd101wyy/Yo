export enum Data<T> {
  Value(value: T)
}

export class Id<M> {
  id: (x: M)-> M;
}

extern "C" {
  malloc: ()-> Data<i32>;
}

instance<X> Id<Data<X>> {
  id: (x: Data<X>) -> Data<X> {
    x
  }
}

let main = ()-> i32 {
  let x = Data<i32>.Value(1);
  let y = id<Data<i32>>(x);
  let z = id(x);
  0
}