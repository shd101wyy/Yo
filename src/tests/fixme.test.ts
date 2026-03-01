import { beforeAll, describe, it } from "bun:test";
import * as path from "node:path";
import { printYoError } from "../error";
import { ModuleManager } from "../module-manager";
import {
  _printEvalProfile,
  _resetEvalProfiler,
} from "../evaluator/exprs/_expr";
import { _printCallProfile } from "../evaluator/calls/helper";

describe("Evaluate fixme.yo", () => {
  beforeAll(() => {});

  it("should evaluate learn_mo.yo correctly", () => {
    _resetEvalProfiler();
    const moduleManager = new ModuleManager();
    const testFileName = "fixme.yo";
    const { moduleError } = moduleManager.loadModule(
      "file://" + path.join(__dirname, `/${testFileName}`)
    );
    _printEvalProfile();
    _printCallProfile();
    if (moduleError) {
      printYoError(moduleError);
      throw moduleError;
    }
  });
});
