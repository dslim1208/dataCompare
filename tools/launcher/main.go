package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// The packager copies the complete Vite dist into this directory before compiling.
//
//go:embed web
var content embed.FS

var version = "dev"

func handler(files fs.FS, host string) http.Handler {
	static := http.FileServer(http.FS(files))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host {
			http.Error(w, "Local access only", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		info, err := fs.Stat(files, path)
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")
		if strings.HasPrefix(path, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		if strings.HasSuffix(path, ".wasm") {
			w.Header().Set("Content-Type", "application/wasm")
		}
		static.ServeHTTP(w, r)
	})
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func run() error {
	port := flag.Int("port", 0, "Local port (0 selects an available port)")
	noBrowser := flag.Bool("no-browser", false, "Do not open the browser automatically")
	flag.Parse()
	if *port < 0 || *port > 65535 {
		return fmt.Errorf("invalid port: %d", *port)
	}
	files, err := fs.Sub(content, "web")
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(*port))
	if err != nil {
		return err
	}
	defer listener.Close()
	host := listener.Addr().String()
	server := &http.Server{Handler: handler(files, host), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	url := "http://" + host + "/"
	fmt.Printf("Data Migration Validation %s\nURL: %s\nKeep this window open. Close it or press Ctrl+C to stop.\n", version, url)
	if !*noBrowser {
		if err := openBrowser(url); err != nil {
			fmt.Fprintln(os.Stderr, "Open the URL above in your browser:", err)
		}
	}
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Unable to start:", err)
		os.Exit(1)
	}
}
