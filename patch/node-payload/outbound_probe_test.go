package xray

import (
	"encoding/base64"
	"strings"
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

func TestDecodeOutboundHTTPProbeBatch(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`[
		{"tag":"nord-one","protocol":"wireguard","settings":{"secretKey":"key"}},
		{"tag":"nord-two","protocol":"wireguard","settings":{"secretKey":"key"}}
	]`))
	outbounds, err := decodeOutboundHTTPProbes(outboundHTTPProbeBatchPrefix + payload)
	if err != nil {
		t.Fatalf("decode batch probe: %v", err)
	}
	if len(outbounds) != 2 {
		t.Fatalf("expected two probes, got %d", len(outbounds))
	}
}

func TestDecodeOutboundHTTPProbeBatchRejectsDuplicatesAndOversize(t *testing.T) {
	duplicate := base64.RawURLEncoding.EncodeToString([]byte(`[
		{"tag":"nord-one","protocol":"wireguard","settings":{}},
		{"tag":"nord-one","protocol":"wireguard","settings":{}}
	]`))
	if _, err := decodeOutboundHTTPProbes(outboundHTTPProbeBatchPrefix + duplicate); err == nil {
		t.Fatal("expected duplicate tags to be rejected")
	}
	if _, err := decodeOutboundHTTPProbes(outboundHTTPProbeBatchPrefix + strings.Repeat("a", outboundHTTPProbeLimit+1)); err == nil {
		t.Fatal("expected oversized batch to be rejected")
	}
}

func TestDecodeOutboundHTTPProbeRejectsNonWireGuard(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"tag":"direct","protocol":"freedom","settings":{}}`))
	if _, err := decodeOutboundHTTPProbe(outboundHTTPProbePrefix + payload); err == nil {
		t.Fatal("expected non-WireGuard probe to be rejected")
	}
}
