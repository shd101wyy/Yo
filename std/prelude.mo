/**
 * This file contains the prelude for the Mo language.
 * References:
 * - Haskell: https://hackage.haskell.org/package/base-4.19.0.0/docs/index.html
 * - Rust: https://doc.rust-lang.org/std/index.html
 */

export {*} from "./builtins.mo";
export {*} from "./data/primitive/i32.mo";
export {*} from "./data/option.mo";

export enum Result<T: Type, E: Type>: Type {
  Ok(value: T),
  Error(error: E),
}

export class Drop<T: Type> {
  drop: (value: T)-> ();
}