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


export type Add<T: Type> = {
  (+): (a: T, b: T)=> T;
}

export type Sub<T: Type> = {
  (-): (a: T, b: T)=> T;
}

export type Mul<T: Type> = {
  (*): (a: T, b: T)=> T;
}

export type Div<T: Type> = {
  (/): (a: T, b: T)=> T;
}

export type Mod<T: Type> = {
  (%): (a: T, b: T)=> T;
}

export type BitLeftShift<T: Type> = {
  (<<): (a: T, b: T)=> T;
}

export type BitRightShift<T: Type> = {
  (>>): (a: T, b: T)=> T;
}

export type Exponentiation<T: Type> = {
  (**): (a: T, b: T)=> T;
}

export type Negate<T: Type> = {
  (-): (value: T)=> T;
}
