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