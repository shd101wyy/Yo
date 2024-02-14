/**
 * This file contains the prelude for the Mo language.
 * References:
 * - Haskell: https://hackage.haskell.org/package/base-4.19.0.0/docs/index.html
 * - Rust: https://doc.rust-lang.org/std/index.html
 */

// builtins
export {*} from "./builtins.mo";

// interface
export {*} from "./interface/arithmetic.mo";
export {*} from "./interface/logic.mo";
export {*} from "./interface/common.mo";
export {*} from "./interface/eq.mo";
export {*} from "./interface/ord.mo";

// data
export {*} from "./data/option.mo";
export {*} from "./data/primitive/i32.mo";
export {*} from "./data/primitive/boolean.mo";