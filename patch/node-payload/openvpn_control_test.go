package xray

import (
	"encoding/base64"
	"testing"
)

func TestDecodeOpenVPNControl(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"action":"connect","hostname":"it257.nordvpn.com","username":"service-user","password":"secret"}`))
	request, err := decodeOpenVPNControl(openVPNControlPrefix + payload)
	if err != nil {
		t.Fatalf("decodeOpenVPNControl returned error: %v", err)
	}
	if request.Action != "connect" || request.Hostname != "it257.nordvpn.com" {
		t.Fatalf("unexpected request: %#v", request)
	}
}

func TestDecodeOpenVPNControlRejectsMissingCredentials(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"action":"connect","hostname":"it257.nordvpn.com"}`))
	if _, err := decodeOpenVPNControl(openVPNControlPrefix + payload); err == nil {
		t.Fatal("expected missing credentials to be rejected")
	}
}
