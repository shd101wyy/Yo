extern "C" {
  setTimeout: (func: ()-> (), ms: i32)-> i32;
}

let waitForSeconds = (seconds: i32)-> Promise<()> {
  setTimeout(()-> {
    resume(());
  }, seconds * 1000);
}

let async1 = ()-> Promise<()> {
  let x = 1;
  let p = await waitForSeconds(10);
  ()
}

let async2 = ()-> Promise<()> {
  await async1();
  // 12 // error: Expected () but got i32
}