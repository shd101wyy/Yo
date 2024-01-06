/**
 * This file contains the prelude for the Mo language.
 * References:
 * - Haskell: https://hackage.haskell.org/package/base-4.19.0.0/docs/index.html
 * - Rust: https://doc.rust-lang.org/std/index.html
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
