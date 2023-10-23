import {tokenize, parse} from "./out/esm/index.mjs";

const code = `
function add(x:i32, y:i32):void {
  x + y
}
add(1, 2)
`;

const tokens = tokenize(code);
console.log(`Tokens: `, tokens);

const ast = parse(tokens);
console.log("AST: ", JSON.stringify(ast, null, 2))
