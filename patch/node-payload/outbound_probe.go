package xray

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/pasarguard/node/common"
)

const (
	outboundHTTPProbePrefix = "pg-http-probe:v1:"
	outboundHTTPProbeURL    = "https://www.gstatic.com/generate_204"
	outboundHTTPProbeLimit  = 64 * 1024
)

func decodeOutboundHTTPProbe(value string) (map[string]any, error) {
	encoded := strings.TrimPrefix(value, outboundHTTPProbePrefix)
	if encoded == value || encoded == "" || len(encoded) > outboundHTTPProbeLimit {
		return nil, errors.New("invalid outbound probe payload")
	}

	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("invalid outbound probe encoding")
	}

	var outbound map[string]any
	if err := json.Unmarshal(raw, &outbound); err != nil {
		return nil, errors.New("invalid outbound probe JSON")
	}
	if strings.TrimSpace(fmt.Sprint(outbound["protocol"])) != "wireguard" {
		return nil, errors.New("outbound probe only supports WireGuard")
	}
	tag := strings.TrimSpace(fmt.Sprint(outbound["tag"]))
	if tag == "" || len(tag) > 128 {
		return nil, errors.New("outbound probe requires a valid tag")
	}
	if _, ok := outbound["settings"].(map[string]any); !ok {
		return nil, errors.New("outbound probe requires settings")
	}
	return outbound, nil
}

func reserveLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func waitForProbeProxy(ctx context.Context, address string) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(4 * time.Second)
	defer timeout.Stop()

	for {
		conn, err := net.DialTimeout("tcp", address, 100*time.Millisecond)
		if err == nil {
			conn.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timeout.C:
			return errors.New("temporary Xray probe did not start")
		case <-ticker.C:
		}
	}
}

func (x *Xray) probeOutboundHTTP(ctx context.Context, payload string) (*common.LatencyResponse, error) {
	outbound, err := decodeOutboundHTTPProbe(payload)
	if err != nil {
		return nil, err
	}
	tag := strings.TrimSpace(fmt.Sprint(outbound["tag"]))
	port, err := reserveLoopbackPort()
	if err != nil {
		return nil, fmt.Errorf("reserve outbound probe port: %w", err)
	}

	config := map[string]any{
		"log": map[string]any{"loglevel": "warning"},
		"inbounds": []any{map[string]any{
			"tag": "pg-http-probe-in", "listen": "127.0.0.1", "port": port,
			"protocol": "http", "settings": map[string]any{},
		}},
		"outbounds": []any{outbound},
		"routing": map[string]any{"rules": []any{map[string]any{
			"type": "field", "inboundTag": []string{"pg-http-probe-in"}, "outboundTag": tag,
		}}},
	}
	configJSON, err := json.Marshal(config)
	if err != nil {
		return nil, fmt.Errorf("encode outbound probe config: %w", err)
	}

	x.mu.RLock()
	executable := x.cfg.XrayExecutablePath
	assets := x.cfg.XrayAssetsPath
	x.mu.RUnlock()
	executable, err = filepath.Abs(executable)
	if err != nil {
		return nil, err
	}
	assets, err = filepath.Abs(assets)
	if err != nil {
		return nil, err
	}

	probeCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, executable, "-c", "stdin:")
	cmd.Env = append(os.Environ(), "XRAY_LOCATION_ASSET="+assets)
	setProcAttributes(cmd)
	cmd.Stdin = bytes.NewReader(configJSON)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start temporary Xray probe: %w", err)
	}
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_ = killProcessTree(cmd.Process.Pid)
		}
		_ = cmd.Wait()
	}()

	proxyAddress := fmt.Sprintf("127.0.0.1:%d", port)
	if err := waitForProbeProxy(probeCtx, proxyAddress); err != nil {
		message := strings.TrimSpace(output.String())
		if len(message) > 400 {
			message = message[len(message)-400:]
		}
		return nil, fmt.Errorf("%w: %s", err, message)
	}

	proxyURL, _ := url.Parse("http://" + proxyAddress)
	client := &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			Proxy:               http.ProxyURL(proxyURL),
			DisableKeepAlives:   true,
			ForceAttemptHTTP2:   false,
			TLSHandshakeTimeout: 10 * time.Second,
		},
	}
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, outboundHTTPProbeURL, nil)
	if err != nil {
		return nil, err
	}
	startedAt := time.Now()
	resp, requestErr := client.Do(req)
	delay := time.Since(startedAt).Milliseconds()
	now := time.Now().Unix()
	alive := requestErr == nil && resp != nil && resp.StatusCode >= 200 && resp.StatusCode < 400
	if resp != nil && resp.Body != nil {
		resp.Body.Close()
	}

	latency := &common.Latency{
		Name: tag, Alive: alive, Delay: delay, Link: outboundHTTPProbeURL,
		LastTryTime: now, Source: "xray-http-probe",
	}
	if alive {
		latency.LastSeenTime = now
	}
	return &common.LatencyResponse{Latencies: []*common.Latency{latency}}, nil
}
