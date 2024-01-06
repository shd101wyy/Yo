import {*} from "./builtins"

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


class Add<T: Type> {
  (+): (a: T, b: T) -> T;
}

class Sub<T: Type> {
  (-): (a: T, b: T) -> T;
}

class Mul<T: Type> {
  (*): (a: T, b: T) -> T;
}

class Div<T: Type> {
  (/): (a: T, b: T) -> T;
}

class Mod<T: Type> {
  (%): (a: T, b: T) -> T;
}

class BitLeftShift<T: Type> {
  (<<): (a: T, b: T) -> T;
}

class BitRightShift<T: Type> {
  (>>): (a: T, b: T) -> T;
}

class Exponentiation<T: Type> {
  (**): (a: T, b: T) -> T;
}

class Negate<T: Type> {
  (-): (value: T) -> T;
}
