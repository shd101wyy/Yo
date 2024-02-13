import {*} from "../builtins.mo"

/**
 * Define the operator precedence for the Mo language.  
 * 1 is the lowest precedence.  
 * Reference: https://rosettacode.org/wiki/Operator_precedence#Haskell
 */
infixl 60 +   // Addition
infixl 60 -   // Subtraction
infixl 70 *   // Multiplication
infixl 70 /   // Division
infixl 70 %   // Modulus
infixl 70 <<  // Bitwise left shift
infixl 70 >>  // Bitwise right shift
infixr 80 **  // Exponentiation. 3 ** 4 ** 6 == 3 ** (4 ** 6)


export interface Add<T: Type> {
  (+): (a: T, b: T) -> T;
}

export interface Sub<T: Type> {
  (-): (a: T, b: T) -> T;
}

export interface Mul<T: Type> {
  (*): (a: T, b: T) -> T;
}

export interface Div<T: Type> {
  (/): (a: T, b: T) -> T;
}

export interface Mod<T: Type> {
  (%): (a: T, b: T) -> T;
}

export interface BitLeftShift<T: Type> {
  (<<): (a: T, b: T) -> T;
}

export interface BitRightShift<T: Type> {
  (>>): (a: T, b: T) -> T;
}

export interface Exponentiation<T: Type> {
  (**): (a: T, b: T) -> T;
}

export interface Negate<T: Type> {
  (-): (value: T) -> T;
}
