package main

import (
	"flag"
	"log"
	"net/http"

	"ax-term/internal/auth"
	"ax-term/internal/server"
	"ax-term/static"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	noAuth := flag.Bool("no-auth", false, "disable challenge-response authentication")
	shell := flag.String("shell", "bash", "shell to spawn PTY sessions with")
	flag.Parse()

	a, err := auth.New()
	if err != nil {
		log.Fatalf("auth init: %v", err)
	}
	defer a.Close()

	srv := server.New(a, static.FS, *noAuth, *shell)
	if *noAuth {
		log.Println("==============================================")
		log.Println("  WARNING: Authentication is DISABLED!")
		log.Println("  Anyone with network access can use the terminal.")
		log.Println("  Do NOT use this in production.")
		log.Println("==============================================")
	}
	log.Printf("ax-term listening on %s (shell=%s, no-auth=%v)", *addr, *shell, *noAuth)
	log.Fatal(http.ListenAndServe(*addr, srv))
}
