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


export trait Add<Rhs=Self> {
  Output: Type = Self;
  (+): (lhs: Self, rhs: Rhs)-> this.Output;
}

export trait Sub<Rhs=Self> {
  Output: Type = Self;
  (-): (lhs: Self, rhs: Rhs)-> this.Output;
}

export trait Mul<Rhs=Self> {
  Output: Type = Self;
  (*): (lhs: Self, rhs: Rhs)-> this.Output;
}

export trait Div<Rhs=Self> {
  Output: Type = Self;
  (/): (lhs: Self, rhs: Rhs)-> this.Output;
}

export trait Mod<Rhs=Self> {
  Output: Type = Self;
  (%): (lhs: Self, rhs: Rhs)-> this.Output;
}

export trait BitLeftShift<Rhs=Self> {
  Output: Type = Self;
  (<<): (lhs: Self, rhs: Rhs)-> this.Output;
}

export trait BitRightShift<Rhs=Self> {
  Output: Type = Self;
  (>>): (lhs: Self, rhs: Rhs)-> this.Output;
}

export trait Exponentiation<Rhs=Self> {
  Output: Type = Self;
  (**): (lhs: Self, rhs: Rhs)-> this.Output;
}

export trait Negate {
  Output: Type = Self;
  (-): (self: Self)-> this.Output;
}
