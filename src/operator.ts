export const Operators = [
  "=",
  "+",
  "-",
  "*",
  "/",
  "<",
  ">",
  "@",
  "$",
  "~",
  "&",
  "%",
  "|",
  "!",
  "?",
  "^",
  ".",
  ":",
  "\\",
];

export const SpecialOperators = ["*mut", "&mut", "*linear"];

export function charIsOperator(char: string): boolean {
  return Operators.includes(char);
}

export function stringIsOperator(str: string): boolean {
  let isOperator = true;
  for (let i = 0; i < str.length; i++) {
    if (!charIsOperator(str[i])) {
      isOperator = false;
      break;
    }
  }
  return isOperator;
}

export type OperatorAssociativity = "infix" | "infixl" | "infixr";

export type OperatorPrecedence = {
  operator: string;
  associativity: OperatorAssociativity;
  /**
   * 1 is the lowest precedence
   */
  precedence: number;
};

/*
export function generateOperatorDefaultPrecedence(
  operator: string
): OperatorPrecedence {
  return {
    operator,
    associativity: "infixl",
    precedence: 1,
  };
}
*/
