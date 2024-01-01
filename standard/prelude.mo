/*
 * This file contains the prelude for the Mo language.
 */

enum Option<T: Type>: Type {
  Some(T),
  None,
}

enum Result<T: Type, E: Type>: Type {
  Ok(T),
  Err(E),
}

type Promise<T: Type>;