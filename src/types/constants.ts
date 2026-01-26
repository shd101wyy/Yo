import { TypeAvailability } from "./definitions";

/**
 * Type availability constants indicating in which evaluation contexts a type can be used.
 */

/**
 * Type available only at compile-time.
 * Examples: compt_int, compt_float, Type, Module, Trait
 */
export const COMPTIME_ONLY: TypeAvailability = {
  comptime: true,
  runtime: false,
} as const;

/**
 * Type available only at runtime.
 * Examples: *(T), [T], Iso(T), Dyn(T), void, C-compatible types
 */
export const RUNTIME_ONLY: TypeAvailability = {
  comptime: false,
  runtime: true,
} as const;

/**
 * Type available in both compile-time and runtime contexts.
 * Examples: i32, bool, u8, unit
 */
export const BOTH_AVAILABLE: TypeAvailability = {
  comptime: true,
  runtime: true,
} as const;

/**
 * Invalid availability (no context available).
 * This represents an error state where a type cannot be used in any context.
 */
export const INVALID_AVAILABILITY: TypeAvailability = {
  comptime: false,
  runtime: false,
} as const;
