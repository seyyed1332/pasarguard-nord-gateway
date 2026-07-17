package xray

import (
	"encoding/base64"
	"testing"
)

func TestDecodeOutboundHTTPProbe(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"tag":"nord-test","protocol":"wireguard","settings":{"secretKey":"key"}}`))
	outbound, err := decodeOutboundHTTPProbe(outboundHTTPProbePrefix + payload)
	if err != nil {
		t.Fatalf("decode probe: %v", err)
	}
	if outbound["tag"] != "nord-test" {
		t.Fatalf("unexpected tag: %v", outbound["tag"])
	}
}

func TestDecodeOutboundHTTPProbeRejectsNonWireGuard(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"tag":"direct","protocol":"freedom","settings":{}}`))
	if _, err := decodeOutboundHTTPProbe(outboundHTTPProbePrefix + payload); err == nil {
		t.Fatal("expected non-WireGuard probe to be rejected")
	}
}
