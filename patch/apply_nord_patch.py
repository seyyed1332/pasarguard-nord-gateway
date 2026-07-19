#!/usr/bin/env python3
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path


def require_once(text: str, marker: str, file_name: str) -> None:
    count = text.count(marker)
    if count != 1:
        raise RuntimeError(f"Expected one marker in {file_name}, found {count}: {marker!r}")


def patch_router(source: Path) -> str:
    path = source / "app/routers/__init__.py"
    text = path.read_text(encoding="utf-8")
    if "nordvpn.router" in text:
        return text

    require_once(text, "    node,\n", str(path))
    require_once(text, "    core.router,\n", str(path))
    text = text.replace("    node,\n", "    node,\n    nordvpn,\n", 1)
    return text.replace("    core.router,\n", "    nordvpn.router,\n    core.router,\n", 1)


def add_nord_icon_imports(text: str, file_name: str) -> str:
    pattern = re.compile(r"import \{ ([^\n]+) \} from 'lucide-react'")
    match = pattern.search(text)
    if not match:
        raise RuntimeError(f"Could not find lucide-react import in {file_name}")
    names = [name.strip() for name in match.group(1).split(",")]
    for icon in ("ShieldCheck", "Waves"):
        if icon not in names:
            names.append(icon)
    names.sort()
    return text[: match.start()] + f"import {{ {', '.join(names)} }} from 'lucide-react'" + text[match.end() :]


def patch_outbounds(source: Path) -> str:
    path = source / "dashboard/src/features/core-editor/components/xray/xray-outbounds-section.tsx"
    text = path.read_text(encoding="utf-8")
    if "<NordVpnOutboundDialog" in text and "<NordOpenVpnDialog" in text:
        return text

    import_marker = "import { OutboundLatencyTestDialog } from '@/features/core-editor/components/xray/outbound-latency-test-dialog'\n"
    require_once(text, import_marker, str(path))
    text = text.replace(
        import_marker,
        import_marker
        + "import { NordVpnOutboundDialog } from '@/features/core-editor/components/xray/nordvpn-outbound-dialog'\n"
        + "import { NordOpenVpnDialog } from '@/features/core-editor/components/xray/nord-openvpn-dialog'\n",
        1,
    )
    text = add_nord_icon_imports(text, str(path))

    state_marker = "  const [latencyTestScope, setLatencyTestScope] = useState<LatencyTestScope | null>(null)\n"
    require_once(text, state_marker, str(path))
    text = text.replace(
        state_marker,
        state_marker
        + "  const [nordDialogOpen, setNordDialogOpen] = useState(false)\n"
        + "  const [nordOpenVpnDialogOpen, setNordOpenVpnDialogOpen] = useState(false)\n",
        1,
    )

    toolbar_start = "        toolbarActions={\n"
    toolbar_end = "        getSearchableText={outboundSearchHaystack}"
    require_once(text, toolbar_start, str(path))
    require_once(text, toolbar_end, str(path))
    start = text.index(toolbar_start)
    end = text.index(toolbar_end, start)
    current = text[start + len(toolbar_start) : end]
    if not current.rstrip().endswith("}"):
        raise RuntimeError(f"Unexpected toolbar shape in {path}")
    current_body = current.rstrip()[:-1].rstrip()
    nord_button = """          <div className=\"flex items-center gap-2\">
            <Button type=\"button\" variant=\"outline\" size=\"sm\" className=\"h-9 border-cyan-500/40 px-2 text-cyan-700 sm:px-3 dark:text-cyan-300\" onClick={() => setNordDialogOpen(true)}>
              <ShieldCheck className=\"h-4 w-4\" />
              <span className=\"hidden sm:inline\">NordLynx</span>
            </Button>
            <Button type=\"button\" variant=\"outline\" size=\"sm\" className=\"h-9 border-sky-500/40 px-2 text-sky-700 sm:px-3 dark:text-sky-300\" onClick={() => setNordOpenVpnDialogOpen(true)}>
              <Waves className=\"h-4 w-4\" />
              <span className=\"hidden sm:inline\">Nord OpenVPN</span>
            </Button>
"""
    indented_current = "\n".join("  " + line if line else line for line in current_body.splitlines())
    replacement = toolbar_start + nord_button + indented_current + "\n          </div>\n        }\n"
    text = text[:start] + replacement + text[end:]

    dialog_marker = "      <CoreEditorFormDialog\n"
    require_once(text, dialog_marker, str(path))
    text = text.replace(
        dialog_marker,
        "      <NordVpnOutboundDialog open={nordDialogOpen} onOpenChange={setNordDialogOpen} />\n"
        + "      <NordOpenVpnDialog open={nordOpenVpnDialogOpen} onOpenChange={setNordOpenVpnDialogOpen} />\n\n"
        + dialog_marker,
        1,
    )
    return text


def patch_xray_adapter(source: Path) -> str:
    path = source / "dashboard/src/features/core-editor/kit/xray-adapter.ts"
    text = path.read_text(encoding="utf-8")
    if "export function appendRawXrayConfig" in text:
        return text

    marker = "export function validateProfileForSave(profile: Profile) {\n"
    require_once(text, marker, str(path))
    helper = """interface RawXrayConfigAdditions {
  inbounds?: Record<string, unknown>[]
  outbounds?: Record<string, unknown>[]
  routingRules?: Record<string, unknown>[]
}

/** Merge raw Xray entries through the kit importer so editor state stays normalized. */
export function appendRawXrayConfig(profile: Profile, additions: RawXrayConfigAdditions): Profile {
  const current = profileToPersistedConfig(profile)
  const currentInbounds = Array.isArray(current.inbounds) ? current.inbounds : []
  const currentOutbounds = Array.isArray(current.outbounds) ? current.outbounds : []
  const currentRouting = asRecord(current.routing) ?? {}
  const currentRules = Array.isArray(currentRouting.rules) ? currentRouting.rules : []

  return importRawToProfile({
    ...current,
    inbounds: [...currentInbounds, ...(additions.inbounds ?? [])],
    outbounds: [...currentOutbounds, ...(additions.outbounds ?? [])],
    routing: {
      ...currentRouting,
      rules: [...currentRules, ...(additions.routingRules ?? [])],
    },
  }).profile
}

"""
    return text.replace(marker, helper + marker, 1)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: apply_nord_patch.py SOURCE_DIR PAYLOAD_DIR")

    source = Path(sys.argv[1]).resolve()
    payload = Path(sys.argv[2]).resolve()
    if not (source / "app/version.py").is_file():
        raise RuntimeError(f"Not a PasarGuard source tree: {source}")

    router_text = patch_router(source)
    outbounds_text = patch_outbounds(source)
    xray_adapter_text = patch_xray_adapter(source)

    payload_files = [
        "app/models/nordvpn.py",
        "app/routers/nordvpn.py",
        "app/utils/nordvpn.py",
        "dashboard/src/service/nordvpn.ts",
        "dashboard/src/service/nord-openvpn.ts",
        "dashboard/src/features/core-editor/components/xray/nordvpn-outbound-dialog.tsx",
        "dashboard/src/features/core-editor/components/xray/nord-openvpn-dialog.tsx",
    ]
    for relative in payload_files:
        if not (payload / relative).is_file():
            raise RuntimeError(f"Missing patch payload: {relative}")

    (source / "app/routers/__init__.py").write_text(router_text, encoding="utf-8")
    outbounds_path = source / "dashboard/src/features/core-editor/components/xray/xray-outbounds-section.tsx"
    outbounds_path.write_text(outbounds_text, encoding="utf-8")
    xray_adapter_path = source / "dashboard/src/features/core-editor/kit/xray-adapter.ts"
    xray_adapter_path.write_text(xray_adapter_text, encoding="utf-8")
    for relative in payload_files:
        destination = source / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(payload / relative, destination)

    print(f"NordVPN patch applied to {source}")


if __name__ == "__main__":
    main()
