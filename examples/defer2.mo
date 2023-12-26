type Data: Linear;
extern malloc(): Data;
extern free(data: Data): ();

function test() {
  let data = malloc();
  defer free(data);
  let x = 1;
  ()
}