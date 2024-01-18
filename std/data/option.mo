export enum Option<T: Type>: Type {
  None,
  Some(value: T),
}
