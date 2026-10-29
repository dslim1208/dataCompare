package main

import (
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestStaticServer(t *testing.T) {
	files := fstest.MapFS{
		"index.html":       {Data: []byte("app")},
		"assets/test.wasm": {Data: []byte("wasm")},
	}
	serve := handler(files, "127.0.0.1:12345")
	for _, tc := range []struct {
		method, path, host string
		status             int
	}{
		{"GET", "/", "127.0.0.1:12345", 200},
		{"HEAD", "/assets/test.wasm", "127.0.0.1:12345", 200},
		{"GET", "/assets/", "127.0.0.1:12345", 404},
		{"GET", "/missing", "127.0.0.1:12345", 404},
		{"POST", "/", "127.0.0.1:12345", 405},
		{"GET", "/", "other.example", 403},
		{"GET", "/../go.mod", "127.0.0.1:12345", 404},
	} {
		r := httptest.NewRequest(tc.method, "http://"+tc.host+tc.path, nil)
		w := httptest.NewRecorder()
		serve.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Errorf("%s %s (%s): got %d, want %d", tc.method, tc.path, tc.host, w.Code, tc.status)
		}
		if tc.path == "/assets/test.wasm" && w.Header().Get("Content-Type") != "application/wasm" {
			t.Error("WASM content type missing")
		}
	}
}
