export type Option<T: Type>: Type =
  | .None
  | .Some(value: T)
