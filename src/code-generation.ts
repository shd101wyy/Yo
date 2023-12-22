import { Expr, exprToString } from "./ast";
import { tokenize } from "./lexer";
import Parser from "./parser";
import { Token } from "./token";

export class CodeGenerator {
  private inputString: string;
  private tokens: Token[];
  private ast: Expr[];

  constructor(inputString: string) {
    this.inputString = inputString;
    this.tokens = tokenize(this.inputString);
    console.log(`= tokens: `, this.tokens);

    const parser = new Parser(inputString);
    this.ast = parser.parse(this.tokens);

    console.log("\n= ast: ");
    this.ast.map((expr) => console.log(exprToString(expr)));
    console.log("\n= ast end\n");
  }
}
