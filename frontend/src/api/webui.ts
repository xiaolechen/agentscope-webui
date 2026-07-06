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

export type SecurityLevel = 'strict' | 'workspace' | 'standard' | 'open'

export interface AgentSecurityConfig {
  level: SecurityLevel
}

export interface McpTestResult {
  ok: boolean
  tool_count?: number
  tools?: { name: string; description?: string }[]
  error?: string
}

export interface KnowledgeBase {
  name: string
  display_name: string
  path: string
  auto_update: boolean
  cron_expression: string
  is_enabled: boolean
}

export interface KnowledgeBaseCreate {
  name: string
  display_name?: string
  path?: string
  auto_update?: boolean
  cron_expression?: string
}

export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileTreeNode[]
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

  // Per-agent preset questions — suggested prompts shown in the chat empty-state.
  getAgentQuestions: (agentId: string): Promise<string[]> =>
    apiClient.get(`/webui/agent-questions/${agentId}`).then(r => r.data),
  setAgentQuestions: (agentId: string, questions: string[]) =>
    apiClient.put(`/webui/agent-questions/${agentId}`, questions).then(r => r.data),

  // Per-agent security level (admin write, any authorized user read)
  getAgentSecurity: (agentId: string): Promise<AgentSecurityConfig> =>
    apiClient.get(`/webui/agent-security/${agentId}`).then(r => r.data),
  setAgentSecurity: (agentId: string, config: AgentSecurityConfig) =>
    apiClient.put(`/webui/agent-security/${agentId}`, config).then(r => r.data),

  // Inject a single skill into an active session (chat skill-picker, non-bound skill)
  injectSessionSkill: (agentId: string, sessionId: string, skillPath: string) =>
    apiClient.post('/webui/session-skill', { agent_id: agentId, session_id: sessionId, skill_path: skillPath }).then(r => r.data),

  // Remove a skill from an active session for this chat only (skill-chip "x").
  removeSessionSkill: (agentId: string, sessionId: string, skillName: string) =>
    apiClient.delete('/webui/session-skill', { data: { agent_id: agentId, session_id: sessionId, skill_name: skillName } }).then(r => r.data),

  // Apply agent's MCPs and Skills to a session workspace.
  // Returns { ok, mcps_added, mcp_errors: [{name, error}], skills_added }
  // `disabledSkillPaths` skips bound skills the user removed before the session
  // was created, so they never reach the workspace.
  applyAgentWorkspace: (agentId: string, sessionId: string, disabledSkillPaths: string[] = []): Promise<{
    ok: boolean
    mcps_added: number
    mcp_errors: { name: string; error: string }[]
    skills_added: number
  }> =>
    apiClient.post('/webui/session-workspace', { agent_id: agentId, session_id: sessionId, disabled_skill_paths: disabledSkillPaths }).then(r => r.data),

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

  // Skill content preview/edit — read or write a skill's SKILL.md
  getSkillContent: (path: string): Promise<{ path: string; name: string; content: string }> =>
    apiClient.get('/webui/skill-content', { params: { path } }).then(r => r.data),
  writeSkillContent: (path: string, content: string) =>
    apiClient.put('/webui/skill-content', { path, content }).then(r => r.data),
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

  // Schedule ownership scope (admin=all, others=own only)
  getMyScheduleIds: (): Promise<{ all?: boolean; schedule_ids?: string[] }> =>
    apiClient.get('/webui/my-schedule-ids').then(r => r.data),

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

  // Model connectivity test
  testModel: (credentialId: string, modelName: string): Promise<{ ok: boolean; latency_ms?: number; error?: string }> =>
    apiClient.post('/webui/test-model', { credential_id: credentialId, model_name: modelName }, { timeout: 20_000 }).then(r => r.data),

  // ── Knowledge Base ────────────────────────────────────────────────────────
  getKnowledgeBases: (): Promise<KnowledgeBase[]> =>
    apiClient.get('/webui/knowledge-base').then(r => r.data),
  addKnowledgeBase: (kb: KnowledgeBaseCreate): Promise<KnowledgeBase & { init?: { ok: boolean; error?: string; session_id?: string; agent_id?: string } }> =>
    apiClient.post('/webui/knowledge-base', kb, { timeout: 200_000 }).then(r => r.data),
  updateKnowledgeBase: (name: string, body: Partial<KnowledgeBase>): Promise<KnowledgeBase> =>
    apiClient.put(`/webui/knowledge-base/${encodeURIComponent(name)}`, body).then(r => r.data),
  toggleKnowledgeBase: (name: string, is_enabled: boolean): Promise<KnowledgeBase> =>
    apiClient.patch(`/webui/knowledge-base/${encodeURIComponent(name)}`, { is_enabled }).then(r => r.data),
  deleteKnowledgeBase: (name: string) =>
    apiClient.delete(`/webui/knowledge-base/${encodeURIComponent(name)}`),

  // KB file operations
  getFileTree: (name: string): Promise<FileTreeNode[]> =>
    apiClient.get(`/webui/knowledge-base/${encodeURIComponent(name)}/files`).then(r => r.data),
  readKBFile: (name: string, filePath: string): Promise<{ path: string; content: string }> =>
    apiClient.get(`/webui/knowledge-base/${encodeURIComponent(name)}/files/read`, { params: { file: filePath } }).then(r => r.data),
  writeKBFile: (name: string, filePath: string, content: string) =>
    apiClient.put(`/webui/knowledge-base/${encodeURIComponent(name)}/files/write`, { path: filePath, content }).then(r => r.data),
  deleteKBFile: (name: string, filePath: string) =>
    apiClient.delete(`/webui/knowledge-base/${encodeURIComponent(name)}/files/delete`, { params: { file: filePath } }),
  uploadKBFile: (name: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return apiClient.post(`/webui/knowledge-base/${encodeURIComponent(name)}/files/upload`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data)
  },

  // KB chat (llm-wiki-agent)
  createKBSession: (name: string): Promise<{ session_id: string; agent_id: string; kb_path: string }> =>
    apiClient.post(`/webui/knowledge-base/${encodeURIComponent(name)}/session`).then(r => r.data),
  chatWithKB: (name: string, session_id: string, message: string): Promise<{ ok: boolean }> =>
    apiClient.post(`/webui/knowledge-base/${encodeURIComponent(name)}/chat`, { session_id, message }).then(r => r.data),
  buildKnowledgeBase: (name: string): Promise<{ ok: boolean; error?: string }> =>
    apiClient.post(`/webui/knowledge-base/${encodeURIComponent(name)}/build`, {}, { timeout: 300_000 }).then(r => r.data),
  // Find the llm-wiki-agent's agent_id (for handing off to the main ChatPage).
  // 404 if the user hasn't created the agent yet.
  getKBAgentId: (): Promise<{ agent_id: string; agent_name: string }> =>
    apiClient.get('/webui/knowledge-base/agent-id').then(r => r.data),
}
