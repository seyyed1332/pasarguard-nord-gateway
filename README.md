# PasarGuard NordVPN Gateway

Adds a one-session NordVPN gateway workflow to PasarGuard:

- Nord token to WireGuard credentials and server selection
- isolated **Check HTTP** test before adding a Nord outbound
- safe country scanning that checks one endpoint at a time, stops after three
  working results, and automatically selects the fastest endpoint
- searchable server table with city, endpoint IP, load, and check status
- inbound-to-Nord routing without replacing the production Xray config
- gateway topology so other nodes relay through one Nord-connected node
- version-matched builds, backups, health checks, and automatic rollback

## One-command install

Run this as root on the **panel server**:

```bash
curl -fsSL https://raw.githubusercontent.com/seyyed1332/pasarguard-nord-gateway/main/install.sh | bash
```

Run the same command on every **PasarGuard node** that needs the pre-add HTTP
check. The installer detects panel versus node automatically.

You can force a role if automatic detection is not possible:

```bash
curl -fsSL https://raw.githubusercontent.com/seyyed1332/pasarguard-nord-gateway/main/install.sh | bash -s -- panel
curl -fsSL https://raw.githubusercontent.com/seyyed1332/pasarguard-nord-gateway/main/install.sh | bash -s -- node
```

The node installer uses the latest official PasarGuard node release by default.
Pin a matching version when needed:

```bash
curl -fsSL https://raw.githubusercontent.com/seyyed1332/pasarguard-nord-gateway/main/install.sh | NODE_REF=v0.5.3 bash -s -- node
```

## Session-safe topology

Assign a Nord-enabled core to exactly one dedicated gateway node. Put all Nord
locations on that gateway and route other nodes through its relay inbounds.
Assigning the same Nord core directly to several nodes can create several
WireGuard handshakes and consume additional Nord sessions.

Never commit a Nord access token or private key to this repository. Rotate any
credential that has been shared in logs, screenshots, or chat.

## Compatibility

The panel patch supports PasarGuard 5.0.3 and newer while its source markers
remain compatible. The installers stop before changing Compose when an upstream
source layout no longer matches. Node probe tests run before its image is built.

Nord allows only one reliable WireGuard handshake at a time for the same private
key. The scanner intentionally runs sequential isolated probes; parallel or
batched key use produces false failures because the Nord identity roams between
peers.

This project contains modifications for GPL-3.0 projects and is distributed
under GPL-3.0. It is not affiliated with PasarGuard, 3x-ui, or Nord Security.
