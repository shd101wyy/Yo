package main

import (
	"fmt"
	"runtime"
)

func say(s string, val int, ch chan int) int {
	fmt.Println(s)
	ch <- val // send to channel
	fmt.Printf("goroutine sent %d\n", val)
	return val
}

func main() {
	runtime.GOMAXPROCS(1)

	ch := make(chan int) // unbuffered channel

	go say("world", 16, ch)
	go say("hello", 18, ch)

	t1_result := <-ch // receive from channel
	fmt.Printf("main received %d\n", t1_result)

	t2_result := <-ch
	fmt.Printf("main received %d\n", t2_result)

	result := t1_result + t2_result
	fmt.Printf("result: %d\n", result)
}
