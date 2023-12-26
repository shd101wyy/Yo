import Parser from "./parser";
import { TModule } from "./type-checker";

export class CodeGenerator {
  /**
   * Key is the absolute path of the module
   * Value is the module itself
   */
  public modules: Map<string, TModule> = new Map();

  constructor() {}

  /**
   * `modulePath` is the path of the module with protocol. For example:
   * - file:///home/username/project/src/main.mo
   * - https://github.com/username/project
   * - mo://std
   * @param modulePath
   * @returns
   */
  public loadModule(
    modulePath: string,
    {
      printLexer,
      printParser,
    }: { printLexer?: boolean; printParser?: boolean } = {}
  ): TModule {
    let module = this.modules.get(modulePath);
    if (module) {
      return module;
    }
    console.log(`= Loading module ${modulePath}`);
    const parser = new Parser(modulePath, this.loadModule.bind(this), {
      printLexer,
      printParser,
    });
    module = parser.generateModule();
    console.log(`= Loaded module ${modulePath}`);
    this.modules.set(modulePath, module);
    return module;
  }
}
