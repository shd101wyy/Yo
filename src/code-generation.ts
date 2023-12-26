import Parser from "./parser";
import { TModule } from "./type-checker";

export class CodeGenerator {
  /**
   * Key is the absolute path of the module
   * Value is the module itself
   */
  public modules: Map<string, TModule> = new Map();

  constructor() {}

  public loadModule(
    filePath: string,
    {
      printLexer,
      printParser,
    }: { printLexer?: boolean; printParser?: boolean } = {}
  ): TModule {
    let module = this.modules.get(filePath);
    if (module) {
      return module;
    }
    console.log(`= Loading module ${filePath}`);
    const parser = new Parser(filePath, this.loadModule.bind(this), {
      printLexer,
      printParser,
    });
    module = parser.generateModule();
    console.log(`= Loaded module ${filePath}`);
    this.modules.set(filePath, module);
    return module;
  }
}
