import Parser from "./parser";

export class CodeGenerator {
  private filePath: string;

  constructor(
    filePath: string,
    { printLexer, printParser }: { printLexer?: boolean; printParser?: boolean }
  ) {
    this.filePath = filePath;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const parser = new Parser(this.filePath, { printLexer, printParser });
  }
}
