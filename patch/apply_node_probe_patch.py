#!/usr/bin/env python3
from __future__ import annotations

import shutil
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: apply_node_probe_patch.py NODE_SOURCE_DIR NODE_PAYLOAD_DIR")

    source = Path(sys.argv[1]).resolve()
    payload = Path(sys.argv[2]).resolve()
    latency_path = source / "backend/xray/latency.go"
    if not (source / "go.mod").is_file() or not latency_path.is_file():
        raise RuntimeError(f"Not a PasarGuard node source tree: {source}")

    text = latency_path.read_text(encoding="utf-8")
    old_hook = """\tif strings.HasPrefix(request.GetName(), outboundHTTPProbePrefix) {
\t\treturn x.probeOutboundHTTP(ctx, request.GetName())
\t}

"""
    probe_hook = """\tif strings.HasPrefix(request.GetName(), outboundHTTPProbePrefix) || strings.HasPrefix(request.GetName(), outboundHTTPProbeBatchPrefix) {
\t\treturn x.probeOutboundHTTP(ctx, request.GetName())
\t}

"""
    hook = """\tif strings.HasPrefix(request.GetName(), openVPNControlPrefix) {
\t\treturn x.controlOpenVPN(ctx, request.GetName())
\t}
""" + probe_hook
    if old_hook in text:
        text = text.replace(old_hook, hook, 1)
    elif hook not in text:
        if probe_hook in text:
            text = text.replace(probe_hook, hook, 1)
        else:
            function_marker = "func (x *Xray) GetOutboundsLatency(ctx context.Context, request *common.LatencyRequest) (*common.LatencyResponse, error) {\n"
            if text.count(function_marker) != 1:
                raise RuntimeError("PasarGuard node latency handler changed; no files were modified")
            if '"strings"' not in text:
                import_marker = '\t"sort"\n'
                if text.count(import_marker) != 1:
                    raise RuntimeError("PasarGuard node latency imports changed; no files were modified")
                text = text.replace(import_marker, import_marker + '\t"strings"\n', 1)
            text = text.replace(function_marker, function_marker + hook, 1)

    payload_files = ["outbound_probe.go", "outbound_probe_test.go", "openvpn_control.go", "openvpn_control_test.go"]
    for name in payload_files:
        if not (payload / name).is_file():
            raise RuntimeError(f"Missing node probe payload: {name}")

    latency_path.write_text(text, encoding="utf-8")
    for name in payload_files:
        shutil.copy2(payload / name, source / "backend/xray" / name)
    print(f"NordVPN HTTP probe patch applied to {source}")


if __name__ == "__main__":
    main()
