import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCoreEditorStore } from '@/features/core-editor/state/core-editor-store'
import { appendRawXrayConfig } from '@/features/core-editor/kit/xray-adapter'
import useDirDetection from '@/hooks/use-dir-detection'
import { nordApi, type NordBulkProbeResult, type NordCoreImpact, type NordCountry, type NordGateway, type NordProbeResult, type NordServer } from '@/service/nordvpn'
import type { Outbound, Profile } from '@pasarguard/xray-config-kit'
import { Activity, CircleAlert, KeyRound, Network, Router, ShieldCheck, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

const RELAY_METHOD = '2022-blake3-aes-256-gcm'
const DEFAULT_RELAY_PORT = 51830
const BULK_PROBE_BATCH_SIZE = 96

function apiErrorMessage(error: unknown): string {
  const detail = (error as { data?: { detail?: unknown } })?.data?.detail
  if (typeof detail === 'string' && detail) return detail
  return error instanceof Error ? error.message : 'The request failed.'
}

function randomRelayKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function uniqueTag(base: string, profile: Profile): string {
  const tags = new Set([...(profile.inbounds ?? []), ...(profile.outbounds ?? [])].map(item => String(item.tag ?? '')))
  if (!tags.has(base)) return base
  let suffix = 2
  while (tags.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

interface NordVpnOutboundDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NordVpnOutboundDialog({ open, onOpenChange }: NordVpnOutboundDialogProps) {
  const dir = useDirDetection()
  const profile = useCoreEditorStore(state => state.xrayProfile)
  const coreId = useCoreEditorStore(state => state.coreId)
  const updateXrayProfile = useCoreEditorStore(state => state.updateXrayProfile)
  const excludeInboundTags = useCoreEditorStore(state => state.excludeInboundTags)
  const setExcludeInboundTags = useCoreEditorStore(state => state.setExcludeInboundTags)

  const [tab, setTab] = useState<'create' | 'connect'>('create')
  const [token, setToken] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [countries, setCountries] = useState<NordCountry[]>([])
  const [countryId, setCountryId] = useState('')
  const [servers, setServers] = useState<NordServer[]>([])
  const [serverId, setServerId] = useState('')
  const [impact, setImpact] = useState<NordCoreImpact | null>(null)
  const [gateways, setGateways] = useState<NordGateway[]>([])
  const [gatewayId, setGatewayId] = useState('')
  const [relayPort, setRelayPort] = useState(String(DEFAULT_RELAY_PORT))
  const [loading, setLoading] = useState(false)
  const [loadingServers, setLoadingServers] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<NordProbeResult | null>(null)
  const [bulkProbing, setBulkProbing] = useState(false)
  const [scanResults, setScanResults] = useState<NordBulkProbeResult[]>([])
  const [scanProgress, setScanProgress] = useState('')

  const selectedServer = useMemo(() => servers.find(server => String(server.id) === serverId), [serverId, servers])
  const selectedGateway = useMemo(() => gateways.find(gateway => String(gateway.core_id) === gatewayId), [gatewayId, gateways])
  const scanResultByServerId = useMemo(() => new Map(scanResults.map(result => [result.server_id, result])), [scanResults])
  const workingScanResults = useMemo(() => scanResults.filter(result => result.alive).sort((a, b) => a.delay - b.delay), [scanResults])
  const relayPortNumber = Number(relayPort)
  const assignedNodeCount = impact?.nodes.length ?? (coreId ? null : 0)
  const gatewayCoreSafe = !coreId || assignedNodeCount === 1
  const probeRequired = Boolean(coreId && impact?.nodes.length === 1)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    const requests: Promise<unknown>[] = [
      nordApi.countries().then(setCountries),
      nordApi.gateways().then(result => {
        setGateways(result.gateways)
        setGatewayId(result.gateways[0] ? String(result.gateways[0].core_id) : '')
      }),
    ]
    if (coreId) requests.push(nordApi.impact(coreId).then(setImpact))
    else setImpact(null)
    Promise.all(requests)
      .catch(error => toast.error(apiErrorMessage(error)))
      .finally(() => setLoading(false))
  }, [coreId, open])

  useEffect(() => {
    if (open) return
    setToken('')
    setPrivateKey('')
    setCountryId('')
    setServers([])
    setServerId('')
    setRelayPort(String(DEFAULT_RELAY_PORT))
    setProbeResult(null)
    setScanResults([])
    setScanProgress('')
  }, [open])

  async function retrievePrivateKey() {
    if (!token.trim()) return
    setLoading(true)
    try {
      const result = await nordApi.credentials(token.trim())
      setPrivateKey(result.private_key)
      setProbeResult(null)
      setScanResults([])
      setToken('')
      toast.success('NordLynx credentials loaded. The access token was not stored.')
    } catch (error) {
      toast.error(apiErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  async function selectCountry(value: string) {
    setCountryId(value)
    setServerId('')
    setServers([])
    setProbeResult(null)
    setScanResults([])
    setScanProgress('')
    setLoadingServers(true)
    try {
      const result = await nordApi.servers(Number(value))
      setServers(result.servers)
      setServerId(result.servers[0] ? String(result.servers[0].id) : '')
    } catch (error) {
      toast.error(apiErrorMessage(error))
    } finally {
      setLoadingServers(false)
    }
  }

  function selectServer(value: string) {
    setServerId(value)
    const scanned = scanResultByServerId.get(Number(value))
    setProbeResult(scanned ?? null)
  }

  async function scanAllServers() {
    if (!coreId || !privateKey.trim() || !gatewayCoreSafe || servers.length === 0) return
    setBulkProbing(true)
    setProbeResult(null)
    setScanResults([])
    const collected: NordBulkProbeResult[] = []
    try {
      for (let start = 0; start < servers.length; start += BULK_PROBE_BATCH_SIZE) {
        const batch = servers.slice(start, start + BULK_PROBE_BATCH_SIZE)
        setScanProgress(`Testing ${start + 1}-${Math.min(start + batch.length, servers.length)} of ${servers.length}`)
        const response = await nordApi.probeBulk(coreId, privateKey.trim(), batch)
        collected.push(...response.results)
        setScanResults([...collected])
      }
      const working = collected.filter(result => result.alive).sort((a, b) => a.delay - b.delay)
      if (working[0]) {
        setServerId(String(working[0].server_id))
        setProbeResult(working[0])
        toast.success(`${working.length} of ${collected.length} servers work. Selected ${working[0].hostname} at ${working[0].delay} ms.`)
      } else {
        toast.error(`No working server was found among ${collected.length} endpoints.`)
      }
    } catch (error) {
      toast.error(apiErrorMessage(error))
    } finally {
      setBulkProbing(false)
      setScanProgress('')
    }
  }

  async function checkServer() {
    if (!coreId || !selectedServer || !privateKey.trim() || !gatewayCoreSafe) return
    setProbing(true)
    setProbeResult(null)
    try {
      const result = await nordApi.probe(coreId, privateKey.trim(), selectedServer)
      setProbeResult(result)
      if (result.alive) toast.success(`${selectedServer.hostname} passed HTTP check in ${result.delay} ms.`)
      else toast.error(`${selectedServer.hostname} did not pass the HTTP check.`)
    } catch (error) {
      toast.error(apiErrorMessage(error))
    } finally {
      setProbing(false)
    }
  }

  function createGateway() {
    if (!profile || !selectedServer || !privateKey.trim() || !gatewayCoreSafe) return
    if (!Number.isInteger(relayPortNumber) || relayPortNumber < 1 || relayPortNumber > 65535) {
      toast.error('Relay port must be between 1 and 65535.')
      return
    }

    const nordTag = uniqueTag(`nord-${selectedServer.hostname}`, profile)
    const inboundTag = uniqueTag('nord-gateway-in', profile)
    const relayKey = randomRelayKey()
    const nordOutbound = {
      tag: nordTag,
      protocol: 'wireguard',
      settings: {
        secretKey: privateKey.trim(),
        address: ['10.5.0.2/32'],
        peers: [
          {
            publicKey: selectedServer.public_key,
            endpoint: `${selectedServer.station}:51820`,
          },
        ],
        noKernelTun: true,
      },
    }
    const relayInbound = {
      tag: inboundTag,
      listen: '0.0.0.0',
      port: relayPortNumber,
      protocol: 'shadowsocks',
      settings: { network: 'tcp,udp', method: RELAY_METHOD, password: relayKey },
    }
    const relayRule = { type: 'field', inboundTag: [inboundTag], outboundTag: nordTag }

    updateXrayProfile(current =>
      appendRawXrayConfig(current, {
        inbounds: [relayInbound],
        outbounds: [nordOutbound],
        routingRules: [relayRule],
      }),
    )
    if (!excludeInboundTags.includes(inboundTag)) setExcludeInboundTags([...excludeInboundTags, inboundTag])
    toast.success('One-session Nord gateway added. Save and restart this core, then connect other cores from this dialog.')
    onOpenChange(false)
  }

  function connectGateway() {
    if (!profile || !selectedGateway) return
    const tag = uniqueTag(`nord-via-${selectedGateway.node_name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, profile)
    const outbound = {
      tag,
      protocol: 'shadowsocks',
      settings: {
        address: selectedGateway.address,
        port: selectedGateway.port,
        method: selectedGateway.method,
        password: selectedGateway.password,
      },
    } as Outbound
    updateXrayProfile(current => appendRawXrayConfig(current, { outbounds: [outbound as unknown as Record<string, unknown>] }))
    toast.success(`Shared Nord gateway outbound "${tag}" added. Add a routing rule for the traffic that should use it.`)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[94dvh] w-[96vw] max-w-2xl flex-col overflow-hidden p-0" dir={dir}>
        <DialogHeader className="border-b px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2"><ShieldCheck className="size-5 text-cyan-600" />NordVPN one-session egress</DialogTitle>
          <DialogDescription>Create one NordLynx tunnel on a gateway node, then safely share it with every other node.</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={value => setTab(value as 'create' | 'connect')} className="min-h-0 overflow-y-auto px-6 pb-6">
          <TabsList className="mt-5 grid w-full grid-cols-2">
            <TabsTrigger value="create"><Router className="mr-2 size-4" />Create gateway</TabsTrigger>
            <TabsTrigger value="connect"><Network className="mr-2 size-4" />Use gateway</TabsTrigger>
          </TabsList>

          <TabsContent value="create" className="mt-5 space-y-5">
            <Alert className={gatewayCoreSafe ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/50 bg-amber-500/5'}>
              <CircleAlert className="size-4" />
              <AlertTitle>{gatewayCoreSafe ? 'Single-session topology is safe' : 'This core is shared by multiple nodes'}</AlertTitle>
              <AlertDescription>
                {coreId
                  ? gatewayCoreSafe
                    ? `This core is assigned to ${impact?.nodes[0]?.name ?? 'one node'}, so it will create one Nord connection.`
                    : `This core is assigned to ${assignedNodeCount ?? 'multiple'} nodes. Create or clone a dedicated core and assign exactly one gateway node before adding Nord.`
                  : 'This new core can become a gateway. Assign it to exactly one node after saving.'}
              </AlertDescription>
            </Alert>

            {impact?.nodes.length ? (
              <div className="flex flex-wrap gap-2">
                {impact.nodes.map(node => <Badge key={node.id} variant={node.status === 'connected' ? 'green' : 'outline'}>{node.name} · {node.status}</Badge>)}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="nord-token">Nord access token</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <PasswordInput id="nord-token" value={token} onChange={event => setToken(event.target.value)} placeholder="Paste temporary or non-expiring access token" className="h-10" />
                <Button type="button" variant="secondary" disabled={!token.trim() || loading} isLoading={loading} onClick={retrievePrivateKey}>
                  <KeyRound className="size-4" />Retrieve key
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">The token is sent once to NordVPN and is never written to the panel database or browser storage.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="nord-private-key">NordLynx private key</Label>
              <PasswordInput id="nord-private-key" value={privateKey} onChange={event => { setPrivateKey(event.target.value); setProbeResult(null); setScanResults([]) }} placeholder="Loaded from token, or paste manually" className="h-10 font-mono" />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Exit country</Label>
                <Select value={countryId} onValueChange={selectCountry} disabled={!privateKey.trim() || loading}>
                  <SelectTrigger><SelectValue placeholder="Choose country" /></SelectTrigger>
                  <SelectContent>{countries.map(country => <SelectItem key={country.id} value={String(country.id)}>{country.name} ({country.code})</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>NordLynx server</Label>
                <Select value={serverId} onValueChange={selectServer} disabled={!countryId || loadingServers || bulkProbing}>
                  <SelectTrigger><SelectValue placeholder={loadingServers ? 'Loading servers...' : 'Choose server'} /></SelectTrigger>
                  <SelectContent>{servers.map(server => {
                    const result = scanResultByServerId.get(server.id)
                    return <SelectItem key={server.id} value={String(server.id)}>{result ? result.alive ? `✓ ${result.delay}ms · ` : '✕ ' : ''}{server.hostname} · {server.city_name ?? 'Unknown city'} · {server.load}%</SelectItem>
                  })}</SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm font-medium"><Activity className="size-4 text-cyan-600" />Fast country scan</div>
                  <p className="text-muted-foreground text-xs">
                    Tests all {servers.length || 0} endpoints in parallel batches and automatically selects the fastest working server.
                    Only 6 isolated checks run at once to protect node memory and the Nord session.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!coreId || !gatewayCoreSafe || !privateKey.trim() || servers.length === 0 || loadingServers || probing || bulkProbing}
                  isLoading={bulkProbing}
                  onClick={scanAllServers}
                >
                  <Activity className="size-4" />{bulkProbing ? scanProgress : `Scan all (${servers.length})`}
                </Button>
              </div>
              {scanResults.length ? (
                <div className="space-y-2 border-t border-cyan-500/20 pt-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="green">{workingScanResults.length} working</Badge>
                    <Badge variant="outline">{scanResults.length - workingScanResults.length} failed</Badge>
                    <span className="text-muted-foreground">Best results:</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {workingScanResults.slice(0, 6).map(result => (
                      <Button key={result.server_id} type="button" size="sm" variant={serverId === String(result.server_id) ? 'default' : 'outline'} className="h-7 px-2 text-xs" onClick={() => selectServer(String(result.server_id))}>
                        {result.hostname} · {result.delay}ms
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  Pre-add HTTP check
                  {probeResult ? <Badge variant={probeResult.alive ? 'green' : 'destructive'}>{probeResult.alive ? `${probeResult.delay} ms` : 'Failed'}</Badge> : null}
                </div>
                <p className="text-muted-foreground text-xs">
                  {coreId
                    ? 'Runs an isolated Xray probe on the assigned gateway node without changing its active core.'
                    : 'Save and assign this new core to one gateway node before running the HTTP check.'}
                </p>
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={!coreId || !gatewayCoreSafe || !privateKey.trim() || !selectedServer || loading || loadingServers || probing || bulkProbing}
                isLoading={probing}
                onClick={checkServer}
              >
                <Zap className="size-4" />Check HTTP
              </Button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="nord-relay-port">Encrypted relay port</Label>
              <Input id="nord-relay-port" type="number" min={1} max={65535} value={relayPort} onChange={event => setRelayPort(event.target.value)} className="h-10 sm:max-w-48" />
              <p className="text-muted-foreground text-xs">Allow this TCP and UDP port in the gateway server firewall. PasarGuard generates a random 256-bit Shadowsocks 2022 key.</p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="button" disabled={!gatewayCoreSafe || !privateKey.trim() || !selectedServer || loading || loadingServers || probing || bulkProbing || (probeRequired && !probeResult?.alive)} onClick={createGateway}>Add one-session gateway</Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="connect" className="mt-5 space-y-5">
            <Alert className="border-cyan-500/40 bg-cyan-500/5">
              <Network className="size-4" />
              <AlertTitle>One Nord slot, any number of PasarGuard nodes</AlertTitle>
              <AlertDescription>Each edge node connects to the encrypted relay. Only the gateway establishes NordLynx, like a VPN router protecting many devices.</AlertDescription>
            </Alert>

            <div className="space-y-2">
              <Label>Saved Nord gateway</Label>
              <Select value={gatewayId} onValueChange={setGatewayId} disabled={loading || gateways.length === 0}>
                <SelectTrigger><SelectValue placeholder={gateways.length ? 'Choose gateway' : 'No saved gateway found'} /></SelectTrigger>
                <SelectContent>{gateways.map(gateway => <SelectItem key={gateway.core_id} value={String(gateway.core_id)}>{gateway.node_name} · {gateway.address}:{gateway.port} · {gateway.core_name}</SelectItem>)}</SelectContent>
              </Select>
            </div>

            {selectedGateway ? (
              <div className="bg-muted/40 grid gap-2 rounded-lg border p-4 text-sm sm:grid-cols-2">
                <div><span className="text-muted-foreground">Gateway node:</span> {selectedGateway.node_name}</div>
                <div><span className="text-muted-foreground">Address:</span> {selectedGateway.address}:{selectedGateway.port}</div>
                <div><span className="text-muted-foreground">Encryption:</span> Shadowsocks 2022</div>
                <div><span className="text-muted-foreground">Nord outbound:</span> {selectedGateway.nord_outbound_tag}</div>
              </div>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="button" disabled={!selectedGateway || loading} onClick={connectGateway}>Add shared gateway outbound</Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
