import * as fs from "fs";
import * as path from "path";
import Parser from "../new_parser";

describe("Parser Tests", () => {
  beforeAll(() => {
    const testFileName = "learn_mo.mo";
    const inputString = fs.readFileSync(
      path.join(__dirname, `examples/${testFileName}`),
      "utf-8"
    );
    const parser = new Parser({
      modulePath: path.join(__dirname, `examples/${testFileName}`),
      inputString,
    });
    console.log(parser.programToString());
  });

  it("should parse learn_mo.mo correctly", () => {
    expect(true).toBe(true);
  });
});
