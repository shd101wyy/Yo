export enum Option<T> {
  None,
  Some(value: T),
}

function test() {
  let x = Some(12);
  x
}