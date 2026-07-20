package runtime

import (
	"reflect"
	"testing"
)

func TestParseLogOptions(t *testing.T) {
	opts, err := ParseLogOptions([]string{"-n", "25", "--prev", "-f"})
	if err != nil {
		t.Fatal(err)
	}
	want := LogOptions{Lines: 25, Previous: true, Follow: true}
	if !reflect.DeepEqual(opts, want) {
		t.Fatalf("got %#v want %#v", opts, want)
	}
}

func TestParseLogOptionsRejectsBadN(t *testing.T) {
	if _, err := ParseLogOptions([]string{"-n", "0"}); err == nil {
		t.Fatal("expected error")
	}
}
