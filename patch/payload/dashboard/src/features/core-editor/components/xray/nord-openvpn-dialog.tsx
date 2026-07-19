import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/ui/password-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { appendRawXrayConfig } from '@/features/core-editor/kit/xray-adapter'
import { useCoreEditorStore } from '@/features/core-editor/state/core-editor-store'
import useDirDetection from '@/hooks/use-dir-detection'
import { nordOpenVpnApi, type NordOpenVPNServer, type NordOpenVPNStatus } from '@/service/nord-openvpn'
import { nordApi, type NordCountry } from '@/service/nordvpn'
import type { Profile } from '@pasarguard/xray-config-kit'
import { Check, CircleAlert, Network, Search, Unplug, Waves } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

function apiErrorMessage(error: unknown): string {
  const detail = (error as { data?: { detail?: unknown } })?.data?.detail
  if (typeof detail === 'string' && detail) return detail
  return error instanceof Error ? error.message : 'The request failed.'
}

function uniqueTag(base: string, profile: Profile): string {
  const tags = new Set([...(profile.inbounds ?? []), ...(profile.outbounds ?? [])].map(item => String(item.tag ?? '')))
  if (!tags.has(base)) return base
  let suffix = 2
  while (tags.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

interface NordOpenVpnDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NordOpenVpnDialog({ open, onOpenChange }: NordOpenVpnDialogProps) {
  const dir = useDirDetection()
  const coreId = useCoreEditorStore(state => state.coreId)
  const profile = useCoreEditorStore(state => state.xrayProfile)
  const updateXrayProfile = useCoreEditorStore(state => state.updateXrayProfile)
  const [countries, setCountries] = useState<NordCountry[]>([])
  const [countryId, setCountryId] = useState('')
  const [servers, setServers] = useState<NordOpenVPNServer[]>([])
  const [serverId, setServerId] = useState('')
  const [search, setSearch] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [connection, setConnection] = useState<NordOpenVPNStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingServers, setLoadingServers] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const selectedServer = useMemo(() => servers.find(server => String(server.id) === serverId), [serverId, servers])
  const filteredServers = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return servers
    return servers.filter(server => [server.hostname, server.city_name, server.station].some(value => value?.toLowerCase().includes(query)))
  }, [search, servers])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    const requests: Promise<unknown>[] = [nordApi.countries().then(setCountries)]
    if (coreId) {
      requests.push(nordOpenVpnApi.status(coreId).then(setConnection).catch(() => setConnection(null)))
    }
    Promise.all(requests)
      .catch(error => toast.error(apiErrorMessage(error)))
      .finally(() => setLoading(false))
  }, [coreId, open])

  useEffect(() => {
    if (open) return
    setCountryId('')
    setServers([])
    setServerId('')
    setSearch('')
    setUsername('')
    setPassword('')
    setConnection(null)
  }, [open])

  async function selectCountry(value: string) {
    setCountryId(value)
    setServers([])
    setServerId('')
    setSearch('')
    setLoadingServers(true)
    try {
      const result = await nordOpenVpnApi.servers(Number(value))
      setServers(result.servers)
      setServerId(result.servers[0] ? String(result.servers[0].id) : '')
    } catch (error) {
      toast.error(apiErrorMessage(error))
    } finally {
      setLoadingServers(false)
    }
  }

  async function connectAndTest() {
    if (!coreId || !selectedServer || !username.trim() || !password) return
    setConnecting(true)
    try {
      const result = await nordOpenVpnApi.connect(coreId, selectedServer.hostname, username.trim(), password)
      setConnection(result)
      setUsername('')
      setPassword('')
      toast.success(`${result.hostname} connected through OpenVPN TCP. Exit IP: ${result.egress_ip}`)
    } catch (error) {
      setConnection(null)
      toast.error(apiErrorMessage(error))
    } finally {
      setConnecting(false)
    }
  }

  async function disconnect() {
    if (!coreId) return
    setDisconnecting(true)
    try {
      await nordOpenVpnApi.disconnect(coreId)
      setConnection(null)
      toast.success('Nord OpenVPN disconnected on the gateway node.')
    } catch (error) {
      toast.error(apiErrorMessage(error))
    } finally {
      setDisconnecting(false)
    }
  }

  function addOutbound() {
    if (!profile || !connection?.connected) return
    const tag = uniqueTag(`nord-openvpn-${connection.hostname}`, profile)
    updateXrayProfile(current =>
      appendRawXrayConfig(current, {
        outbounds: [{
          tag,
          protocol: 'socks',
          settings: { servers: [{ address: connection.proxy_address, port: connection.proxy_port }] },
        }],
      }),
    )
    toast.success(`OpenVPN SOCKS outbound "${tag}" added. Add routing rules, then save and restart this core.`)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[94dvh] w-[96vw] max-w-3xl flex-col overflow-hidden p-0" dir={dir}>
        <DialogHeader className="border-b px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2"><Waves className="size-5 text-sky-600" />Nord OpenVPN TCP gateway</DialogTitle>
          <DialogDescription>Runs OpenVPN in an isolated node container and exposes a localhost-only SOCKS proxy to this Xray core.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-6">
          <Alert className="mt-5 border-sky-500/40 bg-sky-500/5">
            <CircleAlert className="size-4" />
            <AlertTitle>Isolated from the existing NordLynx gateway</AlertTitle>
            <AlertDescription>The sidecar has its own network namespace and cannot replace the node default route. Use Nord service credentials, not your account password or access token.</AlertDescription>
          </Alert>

          {!coreId ? <Alert variant="destructive"><CircleAlert className="size-4" /><AlertTitle>Save this core first</AlertTitle><AlertDescription>Assign this core to exactly one gateway node before connecting OpenVPN.</AlertDescription></Alert> : null}

          {connection?.connected ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
              <Badge variant="green">Connected</Badge>
              <span className="font-medium">{connection.hostname}</span>
              <span className="text-muted-foreground">Exit {connection.egress_ip}</span>
              <span className="text-muted-foreground">{connection.delay} ms</span>
              <span className="text-muted-foreground">Node {connection.node_name}</span>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="nord-openvpn-username">Service username</Label>
              <Input id="nord-openvpn-username" value={username} onChange={event => setUsername(event.target.value)} autoComplete="off" placeholder="Manual setup service username" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="nord-openvpn-password">Service password</Label>
              <PasswordInput id="nord-openvpn-password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder="Manual setup service password" />
            </div>
          </div>

          <div className="space-y-2 sm:max-w-xs">
            <Label>Exit country</Label>
            <Select value={countryId} onValueChange={selectCountry} disabled={loading || connecting}>
              <SelectTrigger><SelectValue placeholder="Choose country" /></SelectTrigger>
              <SelectContent>{countries.map(country => <SelectItem key={country.id} value={String(country.id)}>{country.name} ({country.code})</SelectItem>)}</SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-end justify-between gap-3">
              <Label htmlFor="nord-openvpn-search">OpenVPN TCP servers</Label>
              <span className="text-muted-foreground text-xs">{filteredServers.length} of {servers.length}</span>
            </div>
            <div className="relative">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input id="nord-openvpn-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search city, hostname, or IP" className="pl-9" disabled={!countryId || loadingServers} />
            </div>
            <div className="max-h-60 overflow-auto rounded-lg border">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="bg-muted/95 text-muted-foreground sticky top-0 z-10 text-xs uppercase">
                  <tr><th className="w-10 px-3 py-2" /><th className="px-3 py-2">Server</th><th className="px-3 py-2">City</th><th className="px-3 py-2">Endpoint</th><th className="px-3 py-2 text-right">Load</th></tr>
                </thead>
                <tbody className="divide-y">
                  {filteredServers.map(server => {
                    const selected = serverId === String(server.id)
                    return (
                      <tr key={server.id} className={`cursor-pointer hover:bg-sky-500/10 ${selected ? 'bg-sky-500/15' : ''}`} onClick={() => !connecting && setServerId(String(server.id))}>
                        <td className="px-3 py-2">{selected ? <Check className="size-4 text-sky-600" /> : null}</td>
                        <td className="px-3 py-2 font-medium">{server.hostname}</td>
                        <td className="px-3 py-2">{server.city_name ?? 'Unknown'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{server.station} · TCP</td>
                        <td className="px-3 py-2 text-right">{server.load}%</td>
                      </tr>
                    )
                  })}
                  {!loadingServers && filteredServers.length === 0 ? <tr><td colSpan={5} className="text-muted-foreground px-3 py-8 text-center">No matching OpenVPN TCP servers.</td></tr> : null}
                  {loadingServers ? <tr><td colSpan={5} className="text-muted-foreground px-3 py-8 text-center">Loading servers...</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!coreId || !selectedServer || !username.trim() || !password || connecting || disconnecting} isLoading={connecting} onClick={connectAndTest}>
              <Network className="size-4" />Connect & test
            </Button>
            {connection?.connected ? <Button type="button" variant="outline" disabled={disconnecting} isLoading={disconnecting} onClick={disconnect}><Unplug className="size-4" />Disconnect</Button> : null}
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={!connection?.connected || !profile} onClick={addOutbound}>Add OpenVPN SOCKS outbound</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
