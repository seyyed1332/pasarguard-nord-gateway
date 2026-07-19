import { fetcher } from '@/service/http'

export interface NordOpenVPNServer {
  id: number
  name: string
  hostname: string
  station: string
  load: number
  city_id: number | null
  city_name: string | null
}

export interface NordOpenVPNStatus {
  node_id: number
  node_name: string
  connected: boolean
  hostname: string
  egress_ip: string
  delay: number
  proxy_address: string
  proxy_port: number
}

export const nordOpenVpnApi = {
  servers: (countryId: number) => fetcher<{ servers: NordOpenVPNServer[] }>('/api/nordvpn/openvpn/servers', { params: { country_id: countryId } }),
  connect: (coreId: number, hostname: string, username: string, password: string) =>
    fetcher<NordOpenVPNStatus>('/api/nordvpn/openvpn/connect', { method: 'POST', body: { core_id: coreId, hostname, username, password } }),
  status: (coreId: number) => fetcher<NordOpenVPNStatus>('/api/nordvpn/openvpn/status', { method: 'POST', body: { core_id: coreId } }),
  disconnect: (coreId: number) => fetcher<NordOpenVPNStatus>('/api/nordvpn/openvpn/disconnect', { method: 'POST', body: { core_id: coreId } }),
}
