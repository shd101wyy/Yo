import {tokenize, parse} from "./out/esm/index.mjs";

const code = `
3 + 4 * 6;
5 - 4;
`;

const tokens = tokenize(code);
console.log(`Tokens: `, tokens);

const ast = parse(tokens);
console.log("AST: ", JSON.stringify(ast, null, 2))
