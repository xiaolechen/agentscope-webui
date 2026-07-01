import { apiClient } from './client'

export interface ChatModelConfig {
  type: string
  credential_id: string
  model: string
  parameters: Record<string, unknown>
}

export type McpTransport = 'stdio' | 'sse' | 'streamable-http'
export type McpAuthType = 'none' | 'bearer' | 'api_key' | 'oauth'

export interface McpDef {
  name: string
  transport: McpTransport
  command: string
  args: string[]
  url: string
  is_stateful: boolean
  is_enabled: boolean
  auth_type: McpAuthType
  auth_token: string
  auth_header_name: string
}

export interface SkillDef {
  name: string
  path: string
  is_enabled: boolean
}

export interface McpTestResult {
  ok: boolean
  tool_count?: number
  tools?: { name: string; description?: string }[]
  error?: string
}

export const webuiApi = {
  // Default model (per-user)
  getDefaultModel: (): Promise<ChatModelConfig> =>
    apiClient.get('/webui/me/default-model').then(r => r.data),
  setDefaultModel: (config: ChatModelConfig) =>
    apiClient.put('/webui/me/default-model', config).then(r => r.data),
  deleteDefaultModel: () =>
    apiClient.delete('/webui/me/default-model'),

  // Per-agent model
  getAgentModel: (agentId: string): Promise<ChatModelConfig> =>
    apiClient.get(`/webui/agent-model/${agentId}`).then(r => r.data),
  setAgentModel: (agentId: string, config: ChatModelConfig) =>
    apiClient.put(`/webui/agent-model/${agentId}`, config).then(r => r.data),
  deleteAgentModel: (agentId: string) =>
    apiClient.delete(`/webui/agent-model/${agentId}`),

  // Per-agent MCP & Skill preferences
  getAgentMcps: (agentId: string): Promise<string[]> =>
    apiClient.get(`/webui/agent-mcps/${agentId}`).then(r => r.data),
  setAgentMcps: (agentId: string, names: string[]) =>
    apiClient.put(`/webui/agent-mcps/${agentId}`, names).then(r => r.data),
  getAgentSkills: (agentId: string): Promise<string[]> =>
    apiClient.get(`/webui/agent-skills/${agentId}`).then(r => r.data),
  // Bound skills resolved as full objects {name, path, is_enabled} — works for
  // non-admin users too (doesn't depend on the caller's registered skill-dirs).
  getAgentSkillsFull: (agentId: string): Promise<SkillDef[]> =>
    apiClient.get(`/webui/agent-skills-full/${agentId}`).then(r => r.data),
  setAgentSkills: (agentId: string, paths: string[]) =>
    apiClient.put(`/webui/agent-skills/${agentId}`, paths).then(r => r.data),

  // Inject a single skill into an active session (chat skill-picker, non-bound skill)
  injectSessionSkill: (agentId: string, sessionId: string, skillPath: string) =>
    apiClient.post('/webui/session-skill', { agent_id: agentId, session_id: sessionId, skill_path: skillPath }).then(r => r.data),

  // Apply agent's MCPs and Skills to a session workspace.
  // Returns { ok, mcps_added, mcp_errors: [{name, error}], skills_added }
  applyAgentWorkspace: (agentId: string, sessionId: string): Promise<{
    ok: boolean
    mcps_added: number
    mcp_errors: { name: string; error: string }[]
    skills_added: number
  }> =>
    apiClient.post('/webui/session-workspace', { agent_id: agentId, session_id: sessionId }).then(r => r.data),

  // Credential custom models
  getCredModels: (credId: string): Promise<string[]> =>
    apiClient.get(`/webui/cred-models/${credId}`).then(r => r.data),
  addCredModel: (credId: string, model: string) =>
    apiClient.post(`/webui/cred-models/${credId}`, { model }).then(r => r.data),
  deleteCredModel: (credId: string, model: string) =>
    apiClient.delete(`/webui/cred-models/${credId}/${encodeURIComponent(model)}`),

  // Session ownership
  trackSession: (sessionId: string, agentId: string) =>
    apiClient.post('/webui/session-track', { session_id: sessionId, agent_id: agentId }),
  getMySessionIds: (agentId: string): Promise<{ all?: boolean; session_ids?: string[] }> =>
    apiClient.get(`/webui/my-session-ids/${agentId}`).then(r => r.data),

  // MCP library
  getMcpLib: (): Promise<McpDef[]> =>
    apiClient.get('/webui/mcp-lib').then(r => r.data),
  addMcp: (mcp: McpDef) =>
    apiClient.post('/webui/mcp-lib', mcp).then(r => r.data),
  updateMcp: (name: string, mcp: McpDef) =>
    apiClient.put(`/webui/mcp-lib/${encodeURIComponent(name)}`, mcp).then(r => r.data),
  toggleMcp: (name: string, is_enabled: boolean) =>
    apiClient.patch(`/webui/mcp-lib/${encodeURIComponent(name)}`, { is_enabled }).then(r => r.data),
  deleteMcp: (name: string) =>
    apiClient.delete(`/webui/mcp-lib/${encodeURIComponent(name)}`),
  testMcp: (mcp: McpDef): Promise<McpTestResult> =>
    apiClient.post('/webui/mcp-lib/test', mcp, { timeout: 35_000 }).then(r => r.data),
  // Re-test a saved MCP by name (loads the server-side auth_token — which GET
  // strips — so the browser never needs to round-trip the secret).
  testSavedMcp: (name: string): Promise<McpTestResult> =>
    apiClient.post(`/webui/mcp-lib/test/${encodeURIComponent(name)}`, {}, { timeout: 35_000 }).then(r => r.data),

  // Skill directories (Settings)
  getSkillDirs: (): Promise<string[]> =>
    apiClient.get('/webui/skill-dirs').then(r => r.data),
  addSkillDir: (path: string) =>
    apiClient.post('/webui/skill-dirs', { path }).then(r => r.data),
  deleteSkillDir: (path: string) =>
    apiClient.delete('/webui/skill-dirs', { data: { path } }).then(r => r.data),

  // Skill library — scanned from configured directories
  getSkillLib: (): Promise<SkillDef[]> =>
    apiClient.get('/webui/skill-lib').then(r => r.data),
  toggleSkill: (path: string, is_enabled: boolean) =>
    apiClient.post('/webui/skill-lib/toggle', { path, is_enabled }).then(r => r.data),
  // Install a skill via `npx skills add` into a registered skill-dir (admin-only).
  // Returns { ok, stdout, stderr, skills: [{name, path}], error? }
  installSkill: (command: string, target_dir: string, opts?: { timeout?: number }) =>
    apiClient.post('/webui/skill-lib/install', { command, target_dir }, { timeout: opts?.timeout ?? 130_000 }).then(r => r.data),

  // Schedule proxy (auto-injects model config server-side)
  createSchedule: (body: {
    name: string
    description?: string
    cron_expression: string
    timezone?: string
    agent_id: string
    enabled?: boolean
    stateful?: boolean
    permission_mode?: string
  }) => apiClient.post('/webui/schedule', body).then(r => r.data),

  // Backend restart (Admin only)
  restart: () =>
    apiClient.post('/webui/restart').then(r => r.data),

  // Redis data browser (Admin only, read-only)
  getRedisKeys: (cursor = 0, pattern = '*', count = 200): Promise<{
    cursor: number
    done: boolean
    keys: { key: string; type: string; ttl: number }[]
  }> => apiClient.get('/webui/redis/keys', { params: { cursor, pattern, count } }).then(r => r.data),
  getRedisKey: (key: string, offset = 0, limit = 20): Promise<{
    key: string
    type: string
    ttl: number
    size: number | null
    rows: { field: string; value: string; truncated?: boolean }[]
  }> => apiClient.get('/webui/redis/key', { params: { key, offset, limit } }).then(r => r.data),
}
