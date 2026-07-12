package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"ax-term/internal/auth"
	"ax-term/internal/server"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	staticDir := flag.String("static", "", "path to static files directory (default: find relative to binary)")
	flag.Parse()

	a, err := auth.New()
	if err != nil {
		log.Fatalf("auth init: %v", err)
	}
	defer a.Close()

	dir := *staticDir
	if dir == "" {
		// Default to ../static relative to the binary.
		exe, _ := os.Executable()
		dir = filepath.Join(filepath.Dir(exe), "..", "static")
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			// Fallback: relative to CWD
			dir = "static"
		}
	}

	srv := server.New(a, dir)
	log.Printf("ax-term listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, srv))
}
