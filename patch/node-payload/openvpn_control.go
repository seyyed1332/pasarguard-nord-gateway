package xray

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/pasarguard/node/common"
)

const (
	openVPNControlPrefix = "pg-openvpn:v1:"
	openVPNControlURL    = "http://127.0.0.1:61990"
	openVPNMaxPayload    = 4096
)

type openVPNControlRequest struct {
	Action   string `json:"action"`
	Hostname string `json:"hostname,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

type openVPNControlResponse struct {
	Connected bool   `json:"connected"`
	Hostname  string `json:"hostname"`
	EgressIP  string `json:"egress_ip"`
	Delay     int64  `json:"delay"`
	ProxyPort int    `json:"proxy_port"`
	Error     string `json:"error"`
}

func decodeOpenVPNControl(name string) (openVPNControlRequest, error) {
	if !strings.HasPrefix(name, openVPNControlPrefix) {
		return openVPNControlRequest{}, errors.New("invalid OpenVPN control prefix")
	}
	encoded := strings.TrimPrefix(name, openVPNControlPrefix)
	if len(encoded) == 0 || len(encoded) > openVPNMaxPayload*2 {
		return openVPNControlRequest{}, errors.New("invalid OpenVPN control payload size")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(decoded) > openVPNMaxPayload {
		return openVPNControlRequest{}, errors.New("invalid OpenVPN control encoding")
	}
	var request openVPNControlRequest
	if err := json.Unmarshal(decoded, &request); err != nil {
		return openVPNControlRequest{}, errors.New("invalid OpenVPN control JSON")
	}
	switch request.Action {
	case "connect":
		if request.Hostname == "" || request.Username == "" || request.Password == "" {
			return openVPNControlRequest{}, errors.New("OpenVPN connect requires hostname and service credentials")
		}
	case "status", "disconnect":
	default:
		return openVPNControlRequest{}, errors.New("unsupported OpenVPN control action")
	}
	return request, nil
}

func (x *Xray) controlOpenVPN(ctx context.Context, name string) (*common.LatencyResponse, error) {
	request, err := decodeOpenVPNControl(name)
	if err != nil {
		return nil, err
	}
	token := os.Getenv("PG_NORD_OPENVPN_CONTROL_TOKEN")
	if len(token) < 32 {
		return nil, errors.New("Nord OpenVPN sidecar is not installed on this node")
	}

	method := http.MethodGet
	path := "/status"
	var body io.Reader
	if request.Action != "status" {
		method = http.MethodPost
		path = "/" + request.Action
		payload, marshalErr := json.Marshal(request)
		if marshalErr != nil {
			return nil, marshalErr
		}
		body = bytes.NewReader(payload)
	}

	httpRequest, err := http.NewRequestWithContext(ctx, method, openVPNControlURL+path, body)
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Authorization", "Bearer "+token)
	httpRequest.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 70 * time.Second}
	response, err := client.Do(httpRequest)
	if err != nil {
		return nil, fmt.Errorf("contact Nord OpenVPN sidecar: %w", err)
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, 32*1024)
	var result openVPNControlResponse
	if err := json.NewDecoder(limited).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode Nord OpenVPN sidecar response: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		if result.Error == "" {
			result.Error = fmt.Sprintf("sidecar returned HTTP %d", response.StatusCode)
		}
		return nil, errors.New(result.Error)
	}

	now := time.Now().UnixMilli()
	link := result.EgressIP
	if result.Error != "" {
		link = result.Error
	}
	return &common.LatencyResponse{Latencies: []*common.Latency{{
		Name:         result.Hostname,
		Alive:        result.Connected,
		Delay:        result.Delay,
		Link:         link,
		LastSeenTime: now,
		LastTryTime:  now,
		Source:       "nord-openvpn-control",
	}}}, nil
}
