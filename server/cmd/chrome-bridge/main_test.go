package main

import "testing"

func TestParsePort(t *testing.T) {
	port, err := parsePort("10087")
	if err != nil {
		t.Fatal(err)
	}
	if port != 10087 {
		t.Fatalf("got %d", port)
	}
}

func TestParsePortRejectsInvalid(t *testing.T) {
	if _, err := parsePort("0"); err == nil {
		t.Fatal("expected error")
	}
	if _, err := parsePort("70000"); err == nil {
		t.Fatal("expected error")
	}
	if _, err := parsePort("abc"); err == nil {
		t.Fatal("expected error")
	}
}
