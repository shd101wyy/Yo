package main

import (
	"fmt"
	// "runtime"
)

func say(s string, val int, ch chan int) int {
	fmt.Println(s)
	ch <- val // send to channel
	fmt.Printf("goroutine sent %d\n", val)
	return val
}

/*
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
*/

/*
func main() {
    ch := make(chan int32) // Unbuffered channel

    i := 0
    for i < 10 {
        go func() {
            ch <- int32(i)
            fmt.Printf("Sent %d\n", i)
        }()
        i++
    }

    i = 0
    for i < 10 {
        val := <-ch
        fmt.Printf("Received %d\n", val)
        i++
    }

    fmt.Println("Done")
}
*/

func main() {
	ch := make(chan int32) // Unbuffered channel

	// Spawn 10 goroutines
	for i := 0; i < 10; i++ {
		i := i // Go idiom: shadow the loop variable to capture by value
		go func() {
			ch <- int32(i)
			fmt.Printf("Sent %d\n", i)
		}()
	}

	// Receive 10 values
	for i := 0; i < 10; i++ {
		val := <-ch
		fmt.Printf("Received %d\n", val)
	}

	fmt.Println("Done")
}
