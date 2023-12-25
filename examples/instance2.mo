export enum Data<T> {
  Data(value: T)
}

export class Id<T> {
  id(x: T): T;
}

instance<T> Id<Data<T>> {
  id(x: Data<T>): Data<T> {
    return x;
  }
}