import * as fs from "fs";
import * as path from "path";
import Parser from "../parser";

describe("Parser Tests", () => {
  beforeAll(() => {
    const testFileName = "fixme.yo";
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

  it("should parse learn_mo.yo correctly", () => {
    expect(true).toBe(true);
  });
});
