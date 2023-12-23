/*
 * This file contains the prelude for the Mo language.
 */

type Reference<T: Type, R: Region>: Free;
type MutableReference<T: Type, R: Region>: Free;

enum Some<T: Type> {
  Some(T),
  None,
}

enum Result<T: Type, E: Type> {
  Ok(T),
  Err(E),
}