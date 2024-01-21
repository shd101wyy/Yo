export enum Data<T> {
  Value(value: T)
}

export let main = ()-> i32 {
  let x = Data<i32>.Value(12);
  0
}