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


export class Add<Lhs, Rhs=Lhs> {
  Output: Type = Lhs;
  (+): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export class Sub<Lhs, Rhs=Lhs> {
  Output: Type = Lhs;
  (-): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export class Mul<Lhs, Rhs=Lhs> {
  Output: Type = Lhs;
  (*): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export class Div<Lhs, Rhs=Lhs> {
  Output: Type = Lhs;
  (/): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export class Mod<Lhs, Rhs=Lhs> {
  Output: Type = Lhs;
  (%): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export class BitLeftShift<Lhs, Rhs=Lhs> {
  Output: Type = Lhs;
  (<<): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export class BitRightShift<Lhs, Rhs=Lhs> {
  Output: Type = Lhs;
  (>>): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export class Exponentiation<Lhs, Rhs=Lhs> {
  Output: Type = Lhs;
  (**): (lhs: Lhs, rhs: Rhs)-> this.Output;
}

export class Negate<Self> {
  Output: Type = Self;
  (-): (self: Self)-> this.Output;
}
