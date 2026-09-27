import { API_PREFIX, type Channel, type Preferences, type Profile } from './contracts'

/** Keith can supply DeepSpace getAuthToken here; legacy murmur.session tokens
 * are intentionally not accepted by the new API. Never ship the bridge secret.
 */
export function createWorkspaceClient(baseUrl: string, getToken: () => Promise<string | null>) {
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const token = await getToken()
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${API_PREFIX}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data: unknown = await response.json()
    if (!response.ok) {
      const error = data && typeof data === 'object' && 'error' in data ? String(data.error) : `HTTP ${response.status}`
      throw new Error(error)
    }
    return data as T
  }
  return {
    stats: () => request<{ spotsTaken: number; spotsTotal: number }>('/stats'),
    join: (inviteCode: string) => request<Profile>('/beta/join', 'POST', { inviteCode }),
    me: () => request<Profile>('/me'),
    savePreferences: (value: Preferences) => request<Profile>('/me/preferences', 'PUT', value),
    linkChannel: (channel: Channel) => request<{ code: string; expiresAt: string }>('/me/channel-links', 'POST', { channel }),
  }
}
