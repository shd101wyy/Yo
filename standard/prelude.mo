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