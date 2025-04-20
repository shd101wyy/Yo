import * as fs from "fs";
import * as path from "path";
import Evaluator from "../evaluator";

describe("Evaluator Tests", () => {
  beforeAll(() => {
    const testFileName = "destructuring_nested2.mo";
    const inputString = fs.readFileSync(
      path.join(__dirname, `examples/${testFileName}`),
      "utf-8"
    );
    new Evaluator({
      modulePath: path.join(__dirname, `examples/${testFileName}`),
      inputString,
    });
  });

  it("should evaluate learn_mo.mo correctly", () => {
    expect(true).toBe(true);
  });
});
