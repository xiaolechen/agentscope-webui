import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { apiClient } from '@/api/client'
import { sessionsApi } from '@/api/sessions'
import { agentsApi } from '@/api/agents'
import { webuiApi, ChatModelConfig, SkillDef } from '@/api/webui'
import { useAuthStore } from '@/store/auth'
import AgentPicker from './AgentPicker'
import AgentPickerModal from './AgentPickerModal'
import SkillPickerModal from './SkillPickerModal'
import MessageContent from './renderers/MessageContent'
import { fileToBlock, FILE_ACCEPT, type ContentBlock } from './attachments/fileToBlocks'
import { useSSEStream } from './useSSEStream'
import { Send, AlertTriangle, Bot, Plus, Loader2, Paperclip, Wand2, X } from 'lucide-react'

function uid() { return crypto.randomUUID() }
function buildUserMsg(text: string, blocks: ContentBlock[] = []) {
  const content = [{ type: 'text', text, id: uid() }, ...blocks]
  return { id: uid(), role: 'user' as const, name: 'user', content }
}
interface DisplayMsg { id: string; role: 'user' | 'assistant'; content: string; attachments?: ContentBlock[] }

export default function ChatPage() {
  const navigate = useNavigate()
  const role = useAuthStore(s => s.role)
  const boundAgentIds = useAuthStore(s => s.boundAgentIds)

  const [agentId, setAgentId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerDismissed, setPickerDismissed] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [modelConfig, setModelConfig] = useState<ChatModelConfig | null>(null)
  const [modelLoading, setModelLoading] = useState(false)
  const [noModelWarning, setNoModelWarning] = useState(false)
  const [messages, setMessages] = useState<DisplayMsg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [workspaceApplied, setWorkspaceApplied] = useState(false)
  const [mcpInjectErrors, setMcpInjectErrors] = useState<{ name: string; error: string }[]>([])
  const [attachments, setAttachments] = useState<ContentBlock[]>([])
  const [attachErrors, setAttachErrors] = useState<{ name: string; key: 'tooLarge' | 'unsupported' }[]>([])
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  const [pendingSkill, setPendingSkill] = useState<SkillDef | null>(null)
  const [skillError, setSkillError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const { state: sseState, start, reset } = useSSEStream()
  const { t } = useTranslation()

  const { data: allAgents = [] } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })
  const visibleAgents = role === 'admin'
    ? allAgents
    : allAgents.filter(a => boundAgentIds.includes(a.id))

  // Skills for the chat skill-picker (all enabled + this agent's bound paths)
  const { data: allSkills = [] } = useQuery({ queryKey: ['skill-lib'], queryFn: webuiApi.getSkillLib })
  const { data: agentSkillPaths = [] } = useQuery({
    queryKey: ['agent-skills', agentId],
    queryFn: () => webuiApi.getAgentSkills(agentId!),
    enabled: !!agentId,
  })
  const enabledSkills = (allSkills as SkillDef[]).filter(s => s.is_enabled)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, sseState.streaming])

  // Merge SSE text chunks into assistant message
  useEffect(() => {
    const combined = Object.values(sseState.textChunks).join('')
    if (!combined) return
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant') return [...prev.slice(0, -1), { ...last, content: combined }]
      return [...prev, { id: uid(), role: 'assistant' as const, content: combined }]
    })
  }, [sseState.textChunks])

  // Load model config for an agent, update loading/warning state
  const loadAgentModel = async (aid: string): Promise<ChatModelConfig | null> => {
    setModelLoading(true)
    setNoModelWarning(false)
    let found: ChatModelConfig | null = null
    try {
      const cfg = await webuiApi.getAgentModel(aid)
      if ((cfg as any)?.credential_id) found = cfg as ChatModelConfig
    } catch {}
    if (!found) {
      try {
        const def = await webuiApi.getDefaultModel()
        if ((def as any)?.credential_id) found = def as ChatModelConfig
      } catch {}
    }
    setModelConfig(found)
    setNoModelWarning(!found)
    setModelLoading(false)
    return found
  }

  // Auto-select when exactly one agent is visible
  useEffect(() => {
    if (agentId || visibleAgents.length !== 1) return
    const only = visibleAgents[0]
    setAgentId(only.id)
    loadAgentModel(only.id)
  }, [visibleAgents, agentId])

  const pickAgent = (id: string) => {
    setPickerOpen(false)
    handleAgentChange(id)
  }
  const dismissPicker = () => {
    setPickerOpen(false)
    setPickerDismissed(true)
  }

  // Navigate from Agents page: pre-select a specific agent
  useEffect(() => {
    const aid = sessionStorage.getItem('chatWithAgent')
    if (!aid) return
    sessionStorage.removeItem('chatWithAgent')
    setAgentId(aid)
    loadAgentModel(aid)
  }, [])

  // Resume session from Sessions page (sessionStorage handoff)
  useEffect(() => {
    const raw = sessionStorage.getItem('resumeSession')
    if (!raw) return
    sessionStorage.removeItem('resumeSession')
    try {
      const { sessionId: sid, agentId: aid } = JSON.parse(raw)
      setAgentId(aid); setSessionId(sid); setMessages([])
      loadAgentModel(aid)
      sessionsApi.messages(sid, aid, 0, 50).then((data: any) => {
        const msgs: DisplayMsg[] = (data.messages ?? [])
          .map((m: any) => ({
            id: m.id ?? uid(),
            role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
            content: (m.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''),
          }))
          .filter((m: DisplayMsg) => m.content)
        setMessages(msgs)
      }).catch(() => {})
    } catch {}
  }, [])

  // Run a schedule from SchedulesPage — auto-trigger send with the schedule's prompt.
  // Stash {agentId, prompt} now; the auto-send effect below fires once the model is loaded.
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  useEffect(() => {
    const raw = sessionStorage.getItem('runSchedule')
    if (!raw) return
    sessionStorage.removeItem('runSchedule')
    try {
      const { agentId: aid, prompt } = JSON.parse(raw)
      if (!aid || !prompt) return
      setAgentId(aid); setSessionId(null); setMessages([]); reset()
      setWorkspaceApplied(false)
      loadAgentModel(aid)
      setPendingPrompt(prompt)
    } catch {}
  }, [])

  // On entry with multiple agents and no pre-selected handoff, pop a picker modal.
  // Runs AFTER the handoff effects above so that a resume / "chat with" / schedule
  // run — which already determines the agent — has set agentId, and we don't pop.
  useEffect(() => {
    if (agentId) { setPickerOpen(false); return }
    if (visibleAgents.length > 1 && !pickerDismissed) {
      setPickerOpen(true)
    }
  }, [visibleAgents.length, agentId, pickerDismissed])

  const handleAgentChange = async (id: string) => {
    setAgentId(id); setSessionId(null); setMessages([]); reset()
    setWorkspaceApplied(false); setMcpInjectErrors([])
    if (id) await loadAgentModel(id)
  }

  const startSession = async (aid: string, cfg: ChatModelConfig) => {
    const sid = await sessionsApi.create(aid, `Chat ${new Date().toLocaleTimeString()}`, cfg)
    webuiApi.trackSession(sid, aid).catch(() => {})
    setSessionId(sid); setMessages([])
    return sid
  }

  // Inject agent's configured MCPs and Skills into the workspace whenever a
  // session becomes active (new or resumed). MCP failures (e.g. invalid name,
  // unreachable URL) get surfaced in a banner; skills failures stay quiet.
  useEffect(() => {
    if (sessionId && agentId && !workspaceApplied) {
      setMcpInjectErrors([])
      webuiApi.applyAgentWorkspace(agentId, sessionId)
        .then(res => { if (res?.mcp_errors?.length) setMcpInjectErrors(res.mcp_errors) })
        .catch(() => {})
      setWorkspaceApplied(true)
    }
  }, [sessionId, agentId, workspaceApplied])

  // Auto-confirm tool permission requests so skills can execute without blocking.
  // When the agent emits REQUIRE_USER_CONFIRM (e.g. for a skill call), we approve
  // all pending tool calls and POST the result back, resuming the agent.
  useEffect(() => {
    const confirm = sseState.pendingConfirm
    if (!confirm || !agentId || !sessionId) return

    const toolCalls = (confirm.tool_calls ?? []) as any[]
    const confirmResults = toolCalls.map(tc => ({ confirmed: true, tool_call: tc }))

    apiClient.post('/chat/', {
      agent_id: agentId,
      session_id: sessionId,
      input: {
        type: 'USER_CONFIRM_RESULT',
        reply_id: confirm.reply_id,
        confirm_results: confirmResults,
      },
    }).catch(err => console.warn('[confirm] auto-confirm failed:', err))
  }, [sseState.pendingConfirm])

  const addFiles = async (files: FileList | File[]) => {
    const errs: { name: string; key: 'tooLarge' | 'unsupported' }[] = []
    for (const f of Array.from(files)) {
      const { block, error } = await fileToBlock(f)
      if (block) setAttachments(prev => [...prev, block])
      else if (error) errs.push({ name: f.name, key: error })
    }
    if (errs.length) setAttachErrors(prev => [...prev, ...errs])
  }
  const removeAttachment = (id: string) =>
    setAttachments(prev => prev.filter(b => b.id !== id))

  const onPickSkill = (skill: SkillDef) => {
    setSkillPickerOpen(false)
    setPendingSkill(skill)
    setSkillError(null)
    // Pre-fill the input with a skill-use prompt; user appends their task then sends.
    setInput(prev => `${t('chat.skill.prompt', { name: skill.name })}：${prev}`)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const sendText = async (text: string) => {
    if (!text.trim() || !agentId || sending || sseState.streaming || noModelWarning || modelLoading) return
    const cfg = modelConfig
    if (!cfg) { setNoModelWarning(true); return }

    const blocks = attachments
    const skill = pendingSkill
    setSending(true)
    setAttachments([])
    setPendingSkill(null)
    try {
      let sid = sessionId

      if (!sid) {
        sid = await startSession(agentId, cfg)
      } else {
        // Existing session (resume case) — PATCH to ensure it has model config.
        await sessionsApi.update(sid, agentId, { chat_model_config: cfg } as any).catch(() => {})
      }

      // Inject the picked skill into this session before triggering, so the
      // model's toolkit includes it this turn. Idempotent (SHA-256 dedup),
      // so safe even for already-bound skills.
      const injectSkill = (targetSid: string) =>
        skill
          ? webuiApi.injectSessionSkill(agentId!, targetSid, skill.path)
              .catch(err => {
                const msg = err?.response?.data?.detail ?? err?.message ?? 'unknown'
                setSkillError(t('chat.skill.injectFailed', { error: String(msg) }))
              })
          : Promise.resolve()
      await injectSkill(sid)

      const userMsg = buildUserMsg(text, blocks)
      setMessages(prev => [...prev, { id: userMsg.id, role: 'user', content: text, attachments: blocks }])

      // Trigger chat FIRST — stream endpoint closes immediately if session is not running.
      // 500 = session in broken state (e.g. stuck on previous tool confirmation);
      // recover by creating a fresh session and retry once.
      try {
        await apiClient.post('/chat/', { agent_id: agentId, session_id: sid, input: userMsg })
      } catch (chatErr: any) {
        if (chatErr?.response?.status === 500) {
          sid = await startSession(agentId!, cfg)
          setWorkspaceApplied(false)
          await injectSkill(sid)
          await apiClient.post('/chat/', { agent_id: agentId, session_id: sid, input: userMsg })
        } else {
          throw chatErr
        }
      }

      // Connect to stream AFTER trigger — session is now active, events will flow
      start(`/api/sessions/${sid}/stream?agent_id=${agentId}`)
    } catch (err) {
      console.error('send error', err)
    } finally {
      setSending(false)
    }
  }

  const send = async () => {
    if (!input.trim()) return
    const text = input.trim()
    setInput('')
    await sendText(text)
  }

  // Auto-fire the schedule's prompt once everything is ready.
  // Conditions: pending prompt + agent set + model loaded + nothing in flight.
  useEffect(() => {
    if (!pendingPrompt) return
    if (!agentId || modelLoading || !modelConfig) return
    if (sending || sseState.streaming) return
    const prompt = pendingPrompt
    setPendingPrompt(null)
    sendText(prompt)
  }, [pendingPrompt, agentId, modelConfig, modelLoading, sending, sseState.streaming])

  const isDisabled = !agentId || noModelWarning || sending || sseState.streaming || modelLoading

  // Empty state: no agents
  if (!modelLoading && visibleAgents.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-5" style={{ color: 'var(--as-ink-48)' }}>
        <div className="w-16 h-16 rounded-[var(--as-r-lg)] flex items-center justify-center"
          style={{ background: 'var(--as-parchment)', border: '2px dashed var(--as-hairline)' }}>
          <Bot size={28} style={{ color: 'var(--as-ink-48)' }} />
        </div>
        <div className="text-center">
          <p className="text-base font-semibold mb-1" style={{ color: 'var(--as-ink)' }}>{t('chat.empty.noAgents')}</p>
          <p className="text-sm">{t('chat.empty.noAgentsHint')}</p>
        </div>
        {role === 'admin' ? (
          <button onClick={() => navigate('/agents')}
            className="flex items-center gap-2 px-4 py-2 text-white text-sm rounded-[var(--as-pill)]"
            style={{ background: 'var(--as-primary)' }}>
            <Plus size={14} /> {t('chat.button.createAgent')}
          </button>
        ) : (
          <p className="text-xs text-center max-w-xs">{t('chat.empty.noAgentsAdminHint')}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 border-b shrink-0"
        style={{ borderColor: 'var(--as-hairline)', background: 'var(--as-parchment)', height: 'var(--as-bar-h)' }}>
        <AgentPicker value={agentId} onChange={handleAgentChange} />
        {modelLoading
          ? <Loader2 size={13} className="animate-spin" style={{ color: 'var(--as-ink-48)' }} />
          : modelConfig?.model
            ? <span className="text-[11px] px-2 py-0.5 rounded" style={{ background: 'var(--as-hairline)', color: 'var(--as-ink-48)' }}>{modelConfig.model}</span>
            : null
        }
        <div className="flex-1" />
        {role === 'admin' && (
          <button onClick={() => navigate('/agents')}
            className="flex items-center gap-1 text-[12px] px-2 py-1 rounded-[var(--as-r-sm)]"
            style={{ color: 'var(--as-ink-48)', border: '1px solid var(--as-hairline)' }}>
            <Plus size={11} /> {t('chat.button.agent')}
          </button>
        )}
        {sessionId && (
          <span className="text-[11px] font-mono" style={{ color: 'var(--as-ink-48)' }}>
            {sessionId.slice(0, 8)}…
          </span>
        )}
      </div>

      {/* No-model warning */}
      {noModelWarning && (
        <div className="flex items-center gap-2 px-4 py-2 text-sm shrink-0"
          style={{ background: '#fff7ed', color: '#c2410c', borderBottom: '1px solid #fed7aa' }}>
          <AlertTriangle size={14} />
          {t('chat.warning.noModel')}{' '}
          <button onClick={() => navigate('/agents')} className="mx-1 underline font-medium">{t('chat.warning.goToAgentsEdit')}</button>
          {t('chat.warning.noModelTail')}
        </div>
      )}

      {/* MCP injection failures (e.g. invalid name, unreachable URL) */}
      {mcpInjectErrors.length > 0 && (
        <div className="flex items-start gap-2 px-4 py-2 text-xs shrink-0"
          style={{ background: '#fef2f2', color: '#b91c1c', borderBottom: '1px solid #fecaca' }}>
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="font-medium mb-0.5">{mcpInjectErrors.length} {t('chat.error.mcpFailedToLoad')}</p>
            {mcpInjectErrors.map(e => (
              <p key={e.name} className="truncate" title={e.error}>
                <span className="font-mono">{e.name}</span> — {e.error}
              </p>
            ))}
          </div>
          <button onClick={() => setMcpInjectErrors([])} className="text-[10px] underline shrink-0">{t('common.button.dismiss')}</button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {!messages.length && !sseState.streaming && (
          <div className="h-full flex items-center justify-center text-sm" style={{ color: 'var(--as-ink-48)' }}>
            {!agentId ? t('chat.empty.selectAgent')
              : modelLoading ? t('chat.status.loadingModelConfig')
              : noModelWarning ? t('chat.empty.configureModel')
              : t('chat.empty.sendMessage')}
          </div>
        )}
        {messages.map(m => (
          <div key={m.id} className={`flex mb-3 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className="max-w-[75%] rounded-[var(--as-r-md)] px-4 py-2.5 text-sm"
              style={m.role === 'user'
                ? { background: 'var(--as-primary)', color: '#fff' }
                : { background: 'var(--as-parchment)', color: 'var(--as-ink)', border: '1px solid var(--as-hairline)' }}>
              {m.attachments?.some(b => b.type === 'data') && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {m.attachments.filter(b => b.type === 'data').map(b => (
                    <img key={b.id} src={`data:${b.source!.media_type};base64,${b.source!.data}`}
                      alt={b.name ?? 'attachment'}
                      className="rounded-[var(--as-r-sm)] max-h-40" style={{ border: '1px solid rgba(255,255,255,0.3)' }} />
                  ))}
                </div>
              )}
              <MessageContent content={m.content} />
            </div>
          </div>
        ))}
        {sseState.streaming && (
          <div className="flex justify-start mb-3">
            <div className="rounded-[var(--as-r-md)] px-4 py-3 flex gap-1"
              style={{ background: 'var(--as-parchment)', border: '1px solid var(--as-hairline)' }}>
              {[0, 1, 2].map(i => (
                <div key={i} className="w-1.5 h-1.5 rounded-full animate-bounce"
                  style={{ background: 'var(--as-ink-48)', animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Attach / Skill errors */}
      {(attachErrors.length > 0 || skillError) && (
        <div className="flex items-start gap-2 px-4 py-2 text-xs shrink-0"
          style={{ background: '#fef2f2', color: '#b91c1c', borderBottom: '1px solid var(--as-hairline)' }}>
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-0.5">
            {attachErrors.map((e, i) => (
              <p key={i} className="truncate">{t(`chat.attach.${e.key}`, { name: e.name })}</p>
            ))}
            {skillError && <p className="truncate">{skillError}</p>}
          </div>
          <button onClick={() => { setAttachErrors([]); setSkillError(null) }}
            className="text-[10px] underline shrink-0">{t('common.button.dismiss')}</button>
        </div>
      )}

      {/* Pending attachments */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-2 shrink-0" style={{ background: 'var(--as-parchment)' }}>
          {attachments.map(b => (
            <span key={b.id} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-[var(--as-r-sm)]"
              style={{ background: '#fff', border: '1px solid var(--as-hairline)', color: 'var(--as-ink-80)' }}>
              <Paperclip size={11} /> {b.name ?? (b.type === 'text' ? 'text' : 'media')}
              <button onClick={() => removeAttachment(b.id)} className="ml-0.5" style={{ color: 'var(--as-ink-48)' }}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="border-t px-4 flex items-end gap-2 shrink-0"
        style={{ borderColor: 'var(--as-hairline)', background: 'var(--as-parchment)',
          minHeight: 'var(--as-footer-bar-h)', paddingTop: '0.75rem', paddingBottom: '0.75rem' }}
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
        onDrop={e => { e.preventDefault(); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files) }}>
          <input ref={fileInputRef} type="file" multiple accept={FILE_ACCEPT} className="hidden"
            onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = '' }} />
          <button onClick={() => fileInputRef.current?.click()} disabled={isDisabled}
            title={t('chat.attach.button')}
            className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '6px', color: 'var(--as-ink-80)' }}>
            <Paperclip size={15} />
          </button>
          <button onClick={() => { setSkillError(null); setSkillPickerOpen(true) }} disabled={!agentId || isDisabled}
            title={t('chat.skill.button')}
            className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '6px', color: 'var(--as-ink-80)' }}>
            <Wand2 size={15} />
          </button>
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder={
              modelLoading ? t('chat.placeholder.loadingModel')
              : !agentId ? t('chat.placeholder.selectAgent')
              : noModelWarning ? t('chat.placeholder.configureModel')
              : t('chat.placeholder.message')
            }
            disabled={isDisabled && !input} rows={1}
            className="flex-1 resize-none rounded-[var(--as-r-md)] px-3 py-2 text-sm outline-none transition-colors"
            style={{ border: '1px solid var(--as-hairline)', minHeight: 38, maxHeight: 128,
              background: (isDisabled && !input) ? 'var(--as-parchment)' : '#fff' }} />
          <button onClick={send} disabled={!input.trim() || isDisabled}
            className="flex items-center gap-1.5 px-4 py-2 text-white text-sm rounded-[var(--as-pill)] transition-colors disabled:opacity-40"
            style={{ background: 'var(--as-primary)' }}>
            <Send size={13} />{t('chat.button.send')}
          </button>
      </div>

      {pickerOpen && (
        <AgentPickerModal
          agents={visibleAgents}
          onPick={pickAgent}
          onClose={dismissPicker}
        />
      )}

      {skillPickerOpen && (
        <SkillPickerModal
          skills={enabledSkills}
          boundPaths={agentSkillPaths as string[]}
          onPick={onPickSkill}
          onClose={() => setSkillPickerOpen(false)}
        />
      )}
    </div>
  )
}
