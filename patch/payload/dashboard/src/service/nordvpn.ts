import { fetcher } from '@/service/http'

export interface NordCountry {
  id: number
  name: string
  code: string
}

export interface NordServer {
  id: number
  name: string
  hostname: string
  station: string
  load: number
  city_id: number | null
  city_name: string | null
  public_key: string
}

export interface NordImpactNode {
  id: number
  name: string
  address: string
  status: string
}

export interface NordCoreImpact {
  core_id: number
  nodes: NordImpactNode[]
  projected_direct_connections: number
  single_session_safe: boolean
}

export interface NordGateway {
  core_id: number
  core_name: string
  node_id: number
  node_name: string
  address: string
  port: number
  method: string
  password: string
  inbound_tag: string
  nord_outbound_tag: string
}

export interface NordProbeResult {
  node_id: number
  node_name: string
  alive: boolean
  delay: number
  link: string
  source: string
}

export interface NordBulkProbeResult extends NordProbeResult {
  server_id: number
  hostname: string
  load: number
}

export interface NordBulkProbeResponse {
  scanned: number
  working: number
  results: NordBulkProbeResult[]
}

export const nordApi = {
  credentials: (token: string) => fetcher<{ private_key: string }>('/api/nordvpn/credentials', { method: 'POST', body: { token } }),
  countries: () => fetcher<NordCountry[]>('/api/nordvpn/countries'),
  servers: (countryId: number) => fetcher<{ servers: NordServer[] }>('/api/nordvpn/servers', { params: { country_id: countryId } }),
  probe: (coreId: number, privateKey: string, server: NordServer) =>
    fetcher<NordProbeResult>('/api/nordvpn/probe', { method: 'POST', body: { core_id: coreId, private_key: privateKey, server } }),
  probeBulk: (coreId: number, privateKey: string, servers: NordServer[]) =>
    fetcher<NordBulkProbeResponse>('/api/nordvpn/probe/bulk', { method: 'POST', body: { core_id: coreId, private_key: privateKey, servers } }),
  impact: (coreId: number) => fetcher<NordCoreImpact>(`/api/nordvpn/core/${coreId}/impact`),
  gateways: () => fetcher<{ gateways: NordGateway[] }>('/api/nordvpn/gateways'),
}
