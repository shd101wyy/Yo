import * as fs from "fs";
import { Expr, exprToString } from "./ast";
import { tokenize } from "./lexer";
import Parser from "./parser";
import { Token } from "./token";

export class CodeGenerator {
  private inputString: string;
  private tokens: Token[];
  private ast: Expr[];

  constructor(
    filePath: string,
    { printLexer, printParser }: { printLexer?: boolean; printParser?: boolean }
  ) {
    this.inputString = fs.readFileSync(filePath, "utf-8");
    this.tokens = tokenize(this.inputString);

    if (printLexer) {
      console.log(`= lexer: `, this.tokens);
    }

    const parser = new Parser(this.inputString);
    this.ast = parser.parse(this.tokens);

    if (printParser) {
      console.log("\n= parser: ");
      this.ast.map((expr) => console.log(exprToString(expr)));
      console.log("\n= parser end\n");
    }
  }
}
