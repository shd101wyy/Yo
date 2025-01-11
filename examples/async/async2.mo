extern "C" {
  setTimeout: (func: ()=> (), ms: i32)=> i32;
}

let waitForSeconds = (seconds: i32)=> Promise<()> {
  setTimeout(()=> {
    resume(());
  }, seconds * 1000);
}