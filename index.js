let x = 12;
function Test() {
  return function test(a = x) {
    return a;
  };
}
const test = Test();

x = 15;
console.log(test());
