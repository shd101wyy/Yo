import { readFileSync } from "node:fs";
import path from "node:path";
import {
  addVariableToEnv,
  createNewEnv,
  pushEnvFrame,
  setEnvContainingPrelude,
} from "../env";
import { Expr } from "../expr";
import Parser from "../parser";
import { Token } from "../token";
import { isModuleType } from "../types";
import { ModuleValue } from "../value";

// Import extracted evaluator functions
import { LoadModuleFn } from "./context";
import { evaluateAnonymousModuleBeginExprs } from "./values/anonymous_module";

/**
 * This class is responsible for:
 * - Type checking the program
 * - Compile-time evaluation
 */
export default class Evaluator {
  private inputString: string;
  private modulePath: string;
  private parser: Parser;
  private program: Expr[];
  private tokens: Token[];
  private moduleValue: ModuleValue;
  private moduleError: Error | undefined;

  constructor({
    modulePath,
    stdPath,
    loadModule,
  }: {
    modulePath: string;
    stdPath: string;
    loadModule: LoadModuleFn;
  }) {
    this.modulePath = modulePath;

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
      this.evaluateProgram(stdPath, loadModule);
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

  private evaluateProgram(stdPath: string, loadModule: LoadModuleFn): void {
    let env = createNewEnv({
      modulePath: this.modulePath,
      inputString: this.inputString,
    });

    // Auto-import prelude for all modules except prelude.yo itself
    const preludePath = "file://" + path.join(stdPath, "prelude.yo");
    const isPreludeItself = this.modulePath === preludePath;

    if (!isPreludeItself) {
      const { moduleValue: preludeValue, moduleError: preludeError } =
        loadModule(preludePath);

      if (preludeError) {
        console.error(preludeError);
        throw preludeError;
      }

      // Inject prelude exports into the environment
      if (preludeValue && isModuleType(preludeValue.type)) {
        // Push a new frame for prelude exports
        env = pushEnvFrame(env);

        // Add each exported element from prelude to the environment
        for (let i = 0; i < preludeValue.type.elements.length; i++) {
          const element = preludeValue.type.elements[i]!;
          const elementValue = preludeValue.elements[i];

          const { env: nextEnv } = addVariableToEnv({
            env,
            variable: {
              name: element.label,
              type: element.type,
              value: elementValue,
              isCompileTimeOnly: true,
              initializedAtToken:
                element.exprs.labelExpr?.token ?? element.exprs.expr.token,
              consumedAtToken: undefined,
              token: element.exprs.labelExpr?.token ?? element.exprs.expr.token,
            },
          });
          env = nextEnv;
        }
      }

      setEnvContainingPrelude(env);
    }

    const {
      moduleValue,
      env: nextEnv,
      partialModuleError,
    } = evaluateAnonymousModuleBeginExprs({
      beginExprs: this.program,
      env,
      context: {
        isExecuting: true, // We're executing the main program
        expectedType: undefined,
        SelfType: undefined,
        loadModule: loadModule.bind(this),
        stdPath,
      },
      allowPartialModule: true,
    });
    env = nextEnv;
    this.moduleValue = moduleValue;
    this.moduleError = partialModuleError;
  }

  public getModuleValue(): ModuleValue {
    if (!this.moduleValue) {
      throw new Error("Module value is not set");
    }
    return this.moduleValue;
  }

  public getModuleError(): Error | undefined {
    return this.parser.getParserError() ?? this.moduleError;
  }
}
