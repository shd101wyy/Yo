/**
 * This file contains the prelude for the Mo language.
 */

import {*} from "./operator"

enum Option<T: Type>: Type {
  Some(value: T),
  None,
}

enum Result<T: Type, E: Type>: Type {
  Ok(value: T),
  Err(error: E),
}

type Promise<T: Type>;
