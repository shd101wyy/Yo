import { readFileSync } from "node:fs";
import { formatErrorMessage } from "../error";
import { Expr } from "../expr";
import Parser from "../parser";
import { Token } from "../token";
import { ModuleValue } from "../value";

/**
 * Base Evaluator class containing core properties and utilities
 */
export abstract class BaseEvaluator {
  protected inputString: string;
  protected modulePath: string;
  protected stdPath: string;
  protected parser: Parser;
  protected program: Expr[];
  protected tokens: Token[];
  protected moduleValue: ModuleValue;
  protected moduleError: Error | undefined;
  protected loadModule: (modulePath: string) => {
    moduleValue: ModuleValue;
    moduleError: Error | undefined;
  };

  constructor({
    modulePath,
    stdPath,
    loadModule,
  }: {
    modulePath: string;
    stdPath: string;
    loadModule: (modulePath: string) => {
      moduleValue: ModuleValue;
      moduleError: Error | undefined;
    };
  }) {
    this.modulePath = modulePath;
    this.stdPath = stdPath;
    this.loadModule = loadModule;

    if (!this.modulePath.match(/^file:\/\//)) {
      throw new Error(
        `Invalid file protocol: ${this.modulePath}. Only file:// is supported for now.  `
      );
    }
    try {
      this.inputString = readFileSync(
        modulePath.replace(/^file:\/\//, ""), // NOTE: We only support local file for now
        "utf-8"
      );

      // Parse the module
      this.parser = new Parser({ modulePath, inputString: this.inputString });
      this.program = this.parser.getProgram();
      this.tokens = this.parser.getTokens();

      // Evaluate the program
      this.evaluateProgram();
    } catch (error) {
      throw new Error(
        `Failed to import module "${modulePath}":\n${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Add a public method to get the program
  public getProgram(): Expr[] {
    return this.program;
  }

  // Add a public method to get the tokens
  public getTokens(): Token[] {
    return this.tokens;
  }

  protected formatErrorMessage(token: Token, errorMessage: string) {
    return formatErrorMessage({
      token,
      errorMessage,
    });
  }

  protected abstract evaluateProgram(): void;

  public getModuleValue(): ModuleValue {
    return this.moduleValue;
  }

  public getModuleError(): Error | undefined {
    return this.moduleError;
  }
}
