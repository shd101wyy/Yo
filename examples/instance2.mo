export enum Data<T> {
  Value(value: T)
}

export class Id<T> {
  id: (x: T)-> T;
}

instance<X> Id<Data<X>> {
  id: (x: Data<X>) -> Data<X> {
    x
  }
}