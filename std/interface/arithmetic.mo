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


export class Add<T: Type> {
  (+): (a: T, b: T)=> T;
}

export class Sub<T: Type> {
  (-): (a: T, b: T)=> T;
}

export class Mul<T: Type> {
  (*): (a: T, b: T)=> T;
}

export class Div<T: Type> {
  (/): (a: T, b: T)=> T;
}

export class Mod<T: Type> {
  (%): (a: T, b: T)=> T;
}

export class BitLeftShift<T: Type> {
  (<<): (a: T, b: T)=> T;
}

export class BitRightShift<T: Type> {
  (>>): (a: T, b: T)=> T;
}

export class Exponentiation<T: Type> {
  (**): (a: T, b: T)=> T;
}

export class Negate<T: Type> {
  (-): (value: T)=> T;
}
