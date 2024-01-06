/**
 * This file contains the prelude for the Mo language.
 * References:
 * - Haskell: https://hackage.haskell.org/package/base-4.19.0.0/docs/index.html
 * - Rust: https://doc.rust-lang.org/std/index.html
 */

export {*} from "./builtins";
export {*} from "./data/primitive/i32";

export enum Option<T: Type>: Type {
  Some(value: T),
  None,
}

export enum Result<T: Type, E: Type>: Type {
  Ok(value: T),
  Error(error: E),
}
