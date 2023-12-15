https://effekt-lang.org/quickstart

```
interface Greet { def sayHello(): Unit }

interface MyEffect {}
def useMyEffect(): Unit / {MyEffect} = {
  println("Hello!!");
}


def test(): Unit / {Greet} = {
  do sayHello();
  do sayHello();
}

def helloWorld() = try {
  test()
} with Greet {
  def sayHello() = { println("Hello!!"); resume(()) }
}
```

```
interface Greet { def sayHello(): Int }

def useInt() = {
  3 + do sayHello() + 4
}

def useUseInt() = {
  5 + useInt() + 6
}

def helloWorld() = try {
  println("Hello!");
  1 + useUseInt() + 2;
  println("Done");
  12;
} with Greet {
  def sayHello() = { println("inside!"); 10 }
}

/*
Hello!
inside!
10
*/
```