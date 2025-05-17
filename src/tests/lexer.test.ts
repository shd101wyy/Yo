import * as fs from "fs";
import * as path from "path";
import { tokenize } from "../lexer";

describe("Lexer Tests", () => {
  beforeAll(() => {
    /*
    const testFileName = "test1.yo";
    // Tokenize the content
    const tokens = tokenize(
      fs.readFileSync(path.join(__dirname, `examples/${testFileName}`), "utf-8")
    );

    fs.writeFileSync(
      path.join(
        __dirname,
        `./examples/${testFileName.split(".")[0]}.tokens.json`
      ),
      JSON.stringify(tokens, null, 2)
    );
    */
  });

  test("should tokenize test1.yo correctly", () => {
    // Read the test file
    const filePath = path.join(__dirname, "examples/test1.yo");
    const fileContent = fs.readFileSync(filePath, "utf-8");

    // Tokenize the content
    const tokens = tokenize(fileContent);

    /*
    fs.writeFileSync(
      path.join(__dirname, "./examples/test1.tokens.json"),
      JSON.stringify(tokens, null, 2)
    );
    */

    // Define expected tokens
    const expectedTokens = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "examples/test1.tokens.json"),
        "utf-8"
      )
    );

    // Check number of tokens
    expect(tokens.length).toBe(expectedTokens.length);

    // Check each token type and value
    for (let i = 0; i < tokens.length; i++) {
      expect(tokens[i].type).toBe(expectedTokens[i].type);
      expect(tokens[i].value).toBe(expectedTokens[i].value);
      expect(tokens[i].position.line).toBe(expectedTokens[i].position.line);
      expect(tokens[i].position.character).toBe(
        expectedTokens[i].position.character
      );
    }
  });

  /*
  test("should tokenize basic language constructs", () => {
    const input = `
      // Comment
      let x = 5;
      if (x > 3) {
        print("hello");
      }
      true;
      false;
      'c';
      \`plus\`;
      x!;
      y?;
    `;

    const tokens = tokenize(input);

    // Verify specific tokens
    const tokenTypes = tokens.map((t) => t.type);
    const tokenValues = tokens.map((t) => t.value);

    // Check for comments
    expect(tokenTypes).toContain(TokenType.SingleLineComment);

    // Check for identifiers
    expect(tokenTypes).toContain(TokenType.Identifier);
    expect(tokenValues).toContain("let");
    expect(tokenValues).toContain("x");
    expect(tokenValues).toContain("if");
    expect(tokenValues).toContain("print");

    // Check for literals
    expect(tokenTypes).toContain(TokenType.Integer);
    expect(tokenValues).toContain("5");
    expect(tokenValues).toContain("3");

    // Check for operators
    expect(tokenTypes).toContain(TokenType.Operator);
    expect(tokenValues).toContain("=");
    expect(tokenValues).toContain(">");

    // Check for string, char
    expect(tokenTypes).toContain(TokenType.String);
    expect(tokenValues).toContain("hello");

    expect(tokenTypes).toContain(TokenType.Char);
    expect(tokenValues).toContain("c");

    // Check for booleans
    expect(tokenTypes).toContain(TokenType.Boolean);
    expect(tokenValues).toContain("true");
    expect(tokenValues).toContain("false");


    // Check for identifiers with ! and ?
    expect(tokenValues).toContain("x!");
    expect(tokenValues).toContain("y?");
  });

  test("should handle numbers correctly", () => {
    const input = `123 45.67`;
    const tokens = tokenize(input);

    expect(tokens.length).toBe(2);
    expect(tokens[0].type).toBe(TokenType.Integer);
    expect(tokens[0].value).toBe("123");
    expect(tokens[1].type).toBe(TokenType.Float);
    expect(tokens[1].value).toBe("45.67");
  });

  test("should throw error for invalid identifiers", () => {
    const input = `123abc`;
    expect(() => tokenize(input)).toThrow();
  });
  */
});
