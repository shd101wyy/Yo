/*
 * This file contains the prelude for the Mo language.
 */

enum Some<T: Type> {
  Some(T),
  None,
}

enum Result<T: Type, E: Type> {
  Ok(T),
  Err(E),
}