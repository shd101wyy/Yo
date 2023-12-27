export enum Option<T> {
  None,
  Some(value: T),
}

let test = ()-> {
  let x = Some(12);
  x;
}