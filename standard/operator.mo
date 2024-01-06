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


class Add<T: Type> {
  (+): (lhs: T, rhs: T) -> T;
}

class Sub<T: Type> {
  (-): (lhs: T, rhs: T) -> T;
}

class Mul<T: Type> {
  (*): (lhs: T, rhs: T) -> T;
}

class Div<T: Type> {
  (/): (lhs: T, rhs: T) -> T;
}

class Mod<T: Type> {
  (%): (lhs: T, rhs: T) -> T;
}

class BitAnd<T: Type> {
  (&): (lhs: T, rhs: T) -> T;
}

class BitOr<T: Type> {
  (|): (lhs: T, rhs: T) -> T;
}

class BitXor<T: Type> {
  (^): (lhs: T, rhs: T) -> T;
}

class BitLeftShift<T: Type> {
  (<<): (lhs: T, rhs: T) -> T;
}

class BitRightShift<T: Type> {
  (>>): (lhs: T, rhs: T) -> T;
}

class BitNot<T: Type> {
  (~): (value: T) -> T;
}

class LogicalAnd<T: Type> {
  (&&): (lhs: T, rhs: T) -> boolean;
}

class LogicalOr<T: Type> {
  (||): (lhs: T, rhs: T) -> boolean;
}

class LogicalNot<T: Type> {
  (!): (value: T) -> boolean;
}

class Equal<T: Type> {
  (==): (lhs: T, rhs: T) -> boolean;
}

class NotEqual<T: Type> {
  (!=): (lhs: T, rhs: T) -> boolean;
}

class LessThan<T: Type> {
  (<): (lhs: T, rhs: T) -> boolean;
}

class LessThanOrEqual<T: Type> {
  (<=): (lhs: T, rhs: T) -> boolean;
}

class GreaterThan<T: Type> {
  (>): (lhs: T, rhs: T) -> boolean;
}

class GreaterThanOrEqual<T: Type> {
  (>=): (lhs: T, rhs: T) -> boolean;
}

class Exponentiation<T: Type> {
  (**): (lhs: T, rhs: T) -> T;
}

class Negate<T: Type> {
  (-): (value: T) -> T;
}