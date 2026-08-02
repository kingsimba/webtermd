package main

import (
	"flag"
	"log"
	"net/http"

	"webtermd/internal/auth"
	"webtermd/internal/server"
	"webtermd/static"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	noAuth := flag.Bool("no-auth", false, "disable challenge-response authentication")
	shell := flag.String("shell", "bash", "shell to spawn PTY sessions with")
	previewLimit := flag.Int64("preview-limit", server.DefaultMaxPreviewFileSize, "maximum size in bytes of text files that can be previewed")
	flag.Parse()

	a, err := auth.New()
	if err != nil {
		log.Fatalf("auth init: %v", err)
	}
	defer a.Close()

	srv := server.New(a, static.FS, *noAuth, *shell)
	srv.SetMaxPreviewFileSize(*previewLimit)
	if *noAuth {
		log.Println("==============================================")
		log.Println("  WARNING: Authentication is DISABLED!")
		log.Println("  Anyone with network access can use the terminal.")
		log.Println("  Do NOT use this in production.")
		log.Println("==============================================")
	}
	log.Printf("webtermd listening on %s (shell=%s, no-auth=%v, preview-limit=%d)", *addr, *shell, *noAuth, *previewLimit)
	log.Fatal(http.ListenAndServe(*addr, srv))
}
