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
	"sync"
	"time"

	"github.com/pasarguard/node/common"
)

const (
	outboundHTTPProbePrefix      = "pg-http-probe:v1:"
	outboundHTTPProbeBatchPrefix = "pg-http-probe:v2:"
	outboundHTTPProbeURL         = "https://www.gstatic.com/generate_204"
	outboundHTTPProbeLimit       = 256 * 1024
	outboundHTTPProbeMaxBatch    = 96
	outboundHTTPProbeConcurrency = 6
)

func validateOutboundHTTPProbe(outbound map[string]any) error {
	if strings.TrimSpace(fmt.Sprint(outbound["protocol"])) != "wireguard" {
		return errors.New("outbound probe only supports WireGuard")
	}
	tag := strings.TrimSpace(fmt.Sprint(outbound["tag"]))
	if tag == "" || len(tag) > 128 {
		return errors.New("outbound probe requires a valid tag")
	}
	if _, ok := outbound["settings"].(map[string]any); !ok {
		return errors.New("outbound probe requires settings")
	}
	return nil
}

func decodeOutboundHTTPProbes(value string) ([]map[string]any, error) {
	prefix := outboundHTTPProbePrefix
	batch := false
	if strings.HasPrefix(value, outboundHTTPProbeBatchPrefix) {
		prefix = outboundHTTPProbeBatchPrefix
		batch = true
	}
	encoded := strings.TrimPrefix(value, prefix)
	if encoded == value || encoded == "" || len(encoded) > outboundHTTPProbeLimit {
		return nil, errors.New("invalid outbound probe payload")
	}

	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("invalid outbound probe encoding")
	}

	var outbounds []map[string]any
	if batch {
		if err := json.Unmarshal(raw, &outbounds); err != nil {
			return nil, errors.New("invalid outbound probe JSON")
		}
	} else {
		var outbound map[string]any
		if err := json.Unmarshal(raw, &outbound); err != nil {
			return nil, errors.New("invalid outbound probe JSON")
		}
		outbounds = []map[string]any{outbound}
	}
	if len(outbounds) == 0 || len(outbounds) > outboundHTTPProbeMaxBatch {
		return nil, fmt.Errorf("outbound probe batch must contain 1-%d entries", outboundHTTPProbeMaxBatch)
	}
	tags := make(map[string]struct{}, len(outbounds))
	for _, outbound := range outbounds {
		if err := validateOutboundHTTPProbe(outbound); err != nil {
			return nil, err
		}
		tag := strings.TrimSpace(fmt.Sprint(outbound["tag"]))
		if _, exists := tags[tag]; exists {
			return nil, errors.New("outbound probe tags must be unique")
		}
		tags[tag] = struct{}{}
	}
	return outbounds, nil
}

func decodeOutboundHTTPProbe(value string) (map[string]any, error) {
	outbounds, err := decodeOutboundHTTPProbes(value)
	if err != nil {
		return nil, err
	}
	if len(outbounds) != 1 {
		return nil, errors.New("expected one outbound probe")
	}
	return outbounds[0], nil
}

func reserveLoopbackPorts(count int) ([]int, error) {
	listeners := make([]net.Listener, 0, count)
	defer func() {
		for _, listener := range listeners {
			listener.Close()
		}
	}()
	ports := make([]int, 0, count)
	for range count {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		listeners = append(listeners, listener)
		ports = append(ports, listener.Addr().(*net.TCPAddr).Port)
	}
	return ports, nil
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
	outbounds, err := decodeOutboundHTTPProbes(payload)
	if err != nil {
		return nil, err
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

	batchWaves := (len(outbounds) + outboundHTTPProbeConcurrency - 1) / outboundHTTPProbeConcurrency
	probeCtx, cancel := context.WithTimeout(ctx, time.Duration(15+batchWaves*6)*time.Second)
	defer cancel()
	latencies := make([]*common.Latency, len(outbounds))
	semaphore := make(chan struct{}, outboundHTTPProbeConcurrency)
	var waitGroup sync.WaitGroup
	for index, outbound := range outbounds {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			latency, processErr := probeOutboundHTTPProcess(probeCtx, executable, assets, outbound)
			if processErr != nil {
				tag := strings.TrimSpace(fmt.Sprint(outbound["tag"]))
				latency = &common.Latency{
					Name: tag, Link: outboundHTTPProbeURL, LastTryTime: time.Now().Unix(),
					Source: "xray-http-probe",
				}
			}
			latencies[index] = latency
		}()
	}
	waitGroup.Wait()
	return &common.LatencyResponse{Latencies: latencies}, nil
}

func probeOutboundHTTPProcess(
	ctx context.Context,
	executable string,
	assets string,
	outbound map[string]any,
) (*common.Latency, error) {
	ports, err := reserveLoopbackPorts(1)
	if err != nil {
		return nil, fmt.Errorf("reserve outbound probe port: %w", err)
	}
	port := ports[0]
	tag := strings.TrimSpace(fmt.Sprint(outbound["tag"]))
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

	processCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(processCtx, executable, "-c", "stdin:")
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
	if err := waitForProbeProxy(processCtx, proxyAddress); err != nil {
		message := strings.TrimSpace(output.String())
		if len(message) > 400 {
			message = message[len(message)-400:]
		}
		return nil, fmt.Errorf("%w: %s", err, message)
	}

	return probeHTTPProxy(processCtx, tag, port), nil
}

func probeHTTPProxy(ctx context.Context, tag string, port int) *common.Latency {
	proxyURL, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
	client := &http.Client{
		Timeout: 4 * time.Second,
		Transport: &http.Transport{
			Proxy:               http.ProxyURL(proxyURL),
			DisableKeepAlives:   true,
			ForceAttemptHTTP2:   false,
			TLSHandshakeTimeout: 10 * time.Second,
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, outboundHTTPProbeURL, nil)
	if err != nil {
		return &common.Latency{Name: tag, Link: outboundHTTPProbeURL, Source: "xray-http-probe"}
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
	return latency
}
