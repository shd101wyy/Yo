/**
 * This file contains the prelude for the Mo language.
 * References:
 * - Haskell: https://hackage.haskell.org/package/base-4.19.0.0/docs/index.html
 * - Rust: https://doc.rust-lang.org/std/index.html
 */

// builtins
export let {*} = import("./builtins.mo");

// interface
export let {*} = import("./classes/arithmetic.mo");
export let {*} = import("./classes/logic.mo");
export let {*} = import("./classes/common.mo");
export let {*} = import("./classes/eq.mo");
export let {*} = import("./classes/ord.mo");
export let {*} = import("./classes/closure.mo");

// data
export let {*} = import("./data/option.mo");
export let {*} = import("./data/primitive/i32.mo");
export let {*} = import("./data/primitive/boolean.mo");