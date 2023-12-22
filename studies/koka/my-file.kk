import std/os/file
import std/os/path
import std/core

fun test() {
  println("Hello, world")
  val content = read-text-file(path("./test.kk"))
  println(content)
}

fun main() {
  test()
}