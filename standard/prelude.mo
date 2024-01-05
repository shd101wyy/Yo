/**
 * This file contains the prelude for the Mo language.
 */

/**
 * Define the operator precedence for the Mo language.  
 * 1 is the lowest precedence.  
 * Reference: https://rosettacode.org/wiki/Operator_precedence#Haskell
 */
infixr 20 ||  // Logical OR
infixr 30 &&  // Logical AND
infix  40 ==  // Equality
infix  40 !=  // Inequality
infix  40 <   // Less than
infix  40 <=  // Less than or equal to
infix  40 >   // Greater than
infix  40 >=  // Greater than or equal to
infixl 60 +   // Addition
infixl 60 -   // Subtraction
infixl 60 |   // Bitwise OR
infixl 60 ^   // Bitwise XOR
infixl 70 *   // Multiplication
infixl 70 /   // Division
infixl 70 %   // Modulus
infixl 70 <<  // Bitwise left shift
infixl 70 >>  // Bitwise right shift
infixl 70 &   // Bitwise AND
infixr 80 **  // Exponentiation. 3 ** 4 ** 6 == 3 ** (4 ** 6)

enum Option<T: Type>: Type {
  Some(T),
  None,
}

enum Result<T: Type, E: Type>: Type {
  Ok(T),
  Err(E),
}

type Promise<T: Type>;

class Add<T: Type> {
  (+): (T, T) -> T;
}

class Sub<T: Type> {
  (-): (T, T) -> T;
}

class Mul<T: Type> {
  (*): (T, T) -> T;
}

class Div<T: Type> {
  (/): (T, T) -> T;
}

class Mod<T: Type> {
  (%): (T, T) -> T;
}

class BitAnd<T: Type> {
  (&): (T, T) -> T;
}

class BitOr<T: Type> {
  (|): (T, T) -> T;
}

class BitXor<T: Type> {
  (^): (T, T) -> T;
}

class BitLeftShift<T: Type> {
  (<<): (T, T) -> T;
}

class BitRightShift<T: Type> {
  (>>): (T, T) -> T;
}

class BitNot<T: Type> {
  (~): (T) -> T;
}

class LogicalAnd<T: Type> {
  (&&): (T, T) -> T;
}

class LogicalOr<T: Type> {
  (||): (T, T) -> T;
}

class LogicalNot<T: Type> {
  (!): (T) -> T;
}

class Equal<T: Type> {
  (==): (T, T) -> T;
}

class NotEqual<T: Type> {
  (!=): (T, T) -> T;
}

class LessThan<T: Type> {
  (<): (T, T) -> T;
}

class LessThanOrEqual<T: Type> {
  (<=): (T, T) -> T;
}

class GreaterThan<T: Type> {
  (>): (T, T) -> T;
}

class GreaterThanOrEqual<T: Type> {
  (>=): (T, T) -> T;
}

class Exponentiation<T: Type> {
  (**): (T, T) -> T;
}

class Negate<T: Type> {
  (-): (T) -> T;
}