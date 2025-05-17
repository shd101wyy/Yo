/**
 * This file contains the prelude for the Mo language.
 * References:
 * - Haskell: https://hackage.haskell.org/package/base-4.19.0.0/docs/index.html
 * - Rust: https://doc.rust-lang.org/std/index.html
 */

// builtins
{*} := import "./builtins.mo";

// interface
_arithmetic := import "./interfaces/arithmetic.mo";
_logic := import "./interfaces/logic.mo";
_common := import "./interfaces/common.mo";
_eq := import "./interfaces/eq.mo";
_ord := import "./interfaces/ord.mo";
_closure := import "./interfaces/closure.mo";

// data
_option := import "./data/option.mo";
_i32 := import "./data/primitive/i32.mo";
_boolean := import "./data/primitive/boolean.mo";
{
  ...(_arithmetic),
  ...(_logic),
  ...(_common),
  ...(_eq),
  ...(_ord),
  ...(_closure),

  ...(_option),
  ...(_i32),
  ...(_boolean),
}