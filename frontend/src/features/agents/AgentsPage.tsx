import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { agentsApi, AgentRecord } from '@/api/agents'
import { credentialsApi } from '@/api/credentials'
import { webuiApi, SecurityLevel } from '@/api/webui'
import { useAuthStore } from '@/store/auth'
import { useScopedResources } from '@/hooks/useScopedResources'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { Pencil, Trash2, MessageSquare, Settings2, ChevronRight, X, Search, Network, Wand2, Lock } from 'lucide-react'

const schema = z.object({
  name: z.string().min(1, 'REQUIRED'),
  system_prompt: z.string(),
})
type Fields = z.infer<typeof schema>

const PROVIDERS = [
  { labelKey: 'term.provider.dashscope', key: 'dashscope', type: 'dashscope_credential', modelType: 'dashscope_chat' },
  { labelKey: 'term.provider.anthropic', key: 'anthropic', type: 'anthropic_credential', modelType: 'anthropic_chat' },
  { labelKey: 'term.provider.openai',    key: 'openai',    type: 'openai_credential',    modelType: 'openai_chat' },
  { labelKey: 'term.provider.deepseek',  key: 'deepseek',  type: 'deepseek_credential',  modelType: 'deepseek_chat' },
  { labelKey: 'term.provider.gemini',    key: 'gemini',    type: 'gemini_credential',    modelType: 'gemini_chat' },
  { labelKey: 'term.provider.xai',       key: 'xai',       type: 'xai_credential',       modelType: 'xai_chat' },
  { labelKey: 'term.provider.moonshot',  key: 'moonshot',  type: 'moonshot_credential',  modelType: 'moonshot_chat' },
  { labelKey: 'term.provider.ollama',    key: 'ollama',    type: 'ollama_credential',    modelType: 'ollama_chat' },
] as const

const SECURITY_LEVELS: SecurityLevel[] = ['strict', 'workspace', 'standard', 'open']

const LEVEL_COLORS: Record<SecurityLevel, string> = {
  strict:    '#dc2626',  // red
  workspace: '#ea580c',  // orange
  standard:  '#ca8a04',  // yellow
  open:      '#16a34a',  // green
}

function AgentDialog({ agent, onClose, onSaved }: { agent: AgentRecord | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()

  function credLabel(cred: any): string {
    const credType = String(cred.data?.type ?? '')
    if (cred.data?.base_url && credType !== 'ollama_credential') {
      const name = String(cred.data?.name ?? '')
      return name || t('term.provider.custom')
    }
    const provider = PROVIDERS.find(p => p.type === credType)
    return provider ? t(provider.labelKey) : credType || cred.id
  }

  const role = useAuthStore(s => s.role)
  const isAdmin = role === 'admin'
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Fields>({
    resolver: zodResolver(schema),
    defaultValues: { name: agent?.data.name ?? '', system_prompt: (agent?.data.system_prompt as string) ?? '' },
  })

  const [selectedCredId, setSelectedCredId] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [questions, setQuestions] = useState<string[]>([])
  const [securityLevel, setSecurityLevel] = useState<SecurityLevel>('workspace')

  const { data: credentials = [] } = useQuery({ queryKey: ['credentials'], queryFn: credentialsApi.list })
  const { data: existingModel } = useQuery({
    queryKey: ['agent-model', agent?.id],
    queryFn: () => webuiApi.getAgentModel(agent!.id),
    enabled: !!agent,
  })
  const { data: existingQuestions } = useQuery({
    queryKey: ['agent-questions', agent?.id],
    queryFn: () => webuiApi.getAgentQuestions(agent!.id),
    enabled: !!agent,
  })
  const { data: existingSecurity } = useQuery({
    queryKey: ['agent-security', agent?.id],
    queryFn: () => webuiApi.getAgentSecurity(agent!.id),
    enabled: !!agent,
  })

  useEffect(() => {
    if (Array.isArray(existingQuestions)) setQuestions(existingQuestions as string[])
  }, [existingQuestions])

  useEffect(() => {
    if (existingSecurity?.level) setSecurityLevel(existingSecurity.level)
  }, [existingSecurity])

  useEffect(() => {
    if ((existingModel as any)?.credential_id) {
      setSelectedCredId((existingModel as any).credential_id)
      setSelectedModel((existingModel as any).model ?? '')
    }
  }, [existingModel])

  const selectedCred = (credentials as any[]).find((c: any) => c.id === selectedCredId)
  const credType = selectedCred?.data?.type ?? ''
  const provider = PROVIDERS.find(p => p.type === credType)

  const { data: backendModels = [] } = useQuery({
    queryKey: ['models', provider?.key],
    queryFn: () => credentialsApi.models(provider!.key),
    enabled: !!provider,
  })
  const { data: customModels = [] } = useQuery({
    queryKey: ['cred-models', selectedCredId],
    queryFn: () => webuiApi.getCredModels(selectedCredId),
    enabled: !!selectedCredId,
  })
  const allModels = [
    ...(backendModels as any[]).map((m: any) => ({ name: m.name, label: m.label ?? m.name })),
    ...(customModels as string[]).map(n => ({ name: n, label: n })),
  ]

  const onSubmit = async (data: Fields) => {
    let savedId = agent?.id
    if (agent) {
      await agentsApi.update(agent.id, data)
    } else {
      savedId = await agentsApi.create(data.name, data.system_prompt)
    }
    if (savedId && selectedCredId && selectedModel && provider) {
      await webuiApi.setAgentModel(savedId, {
        type: provider.modelType,
        credential_id: selectedCredId,
        model: selectedModel,
        parameters: {},
      })
    }
    if (savedId) {
      await webuiApi.setAgentQuestions(savedId, questions)
    }
    if (savedId && isAdmin) {
      await webuiApi.setAgentSecurity(savedId, { level: securityLevel })
    }
    onSaved()
  }

  const inp = (label: string, name: keyof Fields, textarea?: boolean) => (
    <div>
      <label className="block text-sm font-medium mb-1" style={{ color: 'var(--as-ink-80)' }}>{label}</label>
      {textarea
        ? <textarea {...register(name)} rows={6} className="w-full rounded-[var(--as-r-sm)] px-3 py-2 text-sm outline-none resize-none" style={{ border: '1px solid var(--as-hairline)' }} />
        : <input {...register(name)} className="as-input" />
      }
      {errors[name] && <p className="text-xs text-red-500 mt-1">{errors[name]?.message === 'REQUIRED' ? t('common.validation.required') : errors[name]?.message}</p>}
    </div>
  )

  return (
    <div className="as-overlay">
      <div className="as-dialog" style={{ maxWidth: "460px", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <h3 className="text-base font-semibold mb-4" style={{ flexShrink: 0 }}>{agent ? t('agents.dialog.edit') : t('agents.dialog.new')}</h3>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" style={{ overflowY: "auto", flex: 1, paddingRight: "2px" }}>
          {inp(t('agents.form.name'), 'name')}
          {inp(t('agents.form.systemPrompt'), 'system_prompt', true)}

          <div className="border-t pt-3" style={{ borderColor: 'var(--as-hairline)' }}>
            <p className="text-sm font-medium mb-1" style={{ color: 'var(--as-ink-80)' }}>{t('agents.form.presetQuestions')}</p>
            <p className="text-xs mb-2" style={{ color: 'var(--as-ink-48)' }}>{t('agents.form.presetQuestionsHint')}</p>
            <div className="space-y-2">
              {questions.map((q, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={q}
                    onChange={e => setQuestions(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                    placeholder={t('agents.form.questionPlaceholder')}
                    className="as-input flex-1"
                  />
                  <button type="button" onClick={() => setQuestions(prev => prev.filter((_, j) => j !== i))}
                    className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }}>
                    <X size={13} />
                  </button>
                </div>
              ))}
              {questions.length < 5 && (
                <button type="button" onClick={() => setQuestions(prev => [...prev, ''])}
                  className="text-xs px-2 py-1 border rounded"
                  style={{ borderColor: 'var(--as-hairline)', color: 'var(--as-ink-80)' }}>
                  {t('agents.form.addQuestion')}
                </button>
              )}
            </div>
          </div>

          <div className="border-t pt-3" style={{ borderColor: 'var(--as-hairline)' }}>
            <p className="text-sm font-medium mb-2" style={{ color: 'var(--as-ink-80)' }}>{t('agents.form.modelConfig')}</p>
            <div className="space-y-2">
              <div>
                <label className="block text-xs mb-1" style={{ color: 'var(--as-ink-48)' }}>{t('agents.form.credential')}</label>
                <select value={selectedCredId} onChange={e => { setSelectedCredId(e.target.value); setSelectedModel('') }}
                  className="as-input">
                  <option value="">{t('agents.form.noModel')}</option>
                  {(credentials as any[]).map((c: any) => (
                    <option key={c.id} value={c.id}>{credLabel(c)}</option>
                  ))}
                </select>
              </div>
              {selectedCredId && (
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--as-ink-48)' }}>{t('agents.form.model')}</label>
                  <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)}
                    className="as-input">
                    <option value="">{t('agents.form.selectModel')}</option>
                    {allModels.map(m => <option key={m.name} value={m.name}>{m.label}</option>)}
                  </select>
                </div>
              )}
            </div>
          </div>

          <div className="border-t pt-3" style={{ borderColor: 'var(--as-hairline)' }}>
            <div className="flex items-center gap-1.5 mb-2">
              <Lock size={13} style={{ color: 'var(--as-ink-48)' }} />
              <p className="text-sm font-medium" style={{ color: 'var(--as-ink-80)' }}>{t('agents.form.securityLevel')}</p>
              {!isAdmin && (
                <span className="text-xs ml-auto" style={{ color: 'var(--as-ink-48)' }}>{t('agents.form.securityLevelAdminOnly')}</span>
              )}
            </div>
            <div className={`space-y-1.5 ${!isAdmin ? 'opacity-60 pointer-events-none' : ''}`}>
              {SECURITY_LEVELS.map(level => {
                const cfg = (t(`agents.form.securityLevels.${level}`, { returnObjects: true }) as { name: string; desc: string; chips: string[] })
                const isSelected = securityLevel === level
                return (
                  <button
                    key={level}
                    type="button"
                    disabled={!isAdmin}
                    onClick={() => setSecurityLevel(level)}
                    className="w-full text-left px-3 py-2 rounded-[var(--as-r-sm)] transition-colors"
                    style={{
                      border: `1px solid ${isSelected ? LEVEL_COLORS[level] : 'var(--as-hairline)'}`,
                      background: isSelected ? `${LEVEL_COLORS[level]}10` : 'transparent',
                    }}
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: LEVEL_COLORS[level] }} />
                      <span className="text-xs font-medium" style={{ color: 'var(--as-ink-80)' }}>{cfg.name}</span>
                    </div>
                    <p className="text-xs ml-4" style={{ color: 'var(--as-ink-48)' }}>{cfg.desc}</p>
                    <div className="flex flex-wrap gap-1 mt-1 ml-4">
                      {cfg.chips.map(chip => (
                        <span key={chip} className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--as-hairline)', color: 'var(--as-ink-64)' }}>
                          {chip}
                        </span>
                      ))}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 pb-1" style={{ position: 'sticky', bottom: 0, background: 'var(--as-bg-primary)' }}>
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm" style={{ color: 'var(--as-ink-80)' }}>{t('common.button.cancel')}</button>
            <button type="submit" disabled={isSubmitting}
              className="as-btn as-btn-primary">
              {isSubmitting ? t('common.status.saving') : t('common.button.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── DualListSection ───────────────────────────────────────────────────────────

interface DualItem { key: string; label: string; sub?: string }

function MiniPagination({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-2 pt-1">
      <button onClick={() => onChange(Math.max(0, page - 1))} disabled={page === 0}
        className="p-0.5 rounded disabled:opacity-30" style={{ color: 'var(--as-ink-48)' }}>
        <ChevronRight size={10} className="rotate-180" />
      </button>
      <span className="text-[10px] tabular-nums" style={{ color: 'var(--as-ink-48)' }}>{page + 1}/{total}</span>
      <button onClick={() => onChange(Math.min(total - 1, page + 1))} disabled={page >= total - 1}
        className="p-0.5 rounded disabled:opacity-30" style={{ color: 'var(--as-ink-48)' }}>
        <ChevronRight size={10} />
      </button>
    </div>
  )
}

function DualListSection({
  title, icon, available, selected, onAdd, onRemove, emptyHint,
}: {
  title: string
  icon: React.ReactNode
  available: DualItem[]
  selected: string[]   // keys
  onAdd: (key: string) => void
  onRemove: (key: string) => void
  emptyHint: string
}) {
  const [search, setSearch] = useState('')
  const [leftPage, setLeftPage] = useState(0)
  const [rightPage, setRightPage] = useState(0)
  const { t } = useTranslation()
  const PAGE = 6

  const unselected = available.filter(item =>
    !selected.includes(item.key) &&
    (item.label.toLowerCase().includes(search.toLowerCase()) ||
     (item.sub ?? '').toLowerCase().includes(search.toLowerCase()))
  )
  const selectedItems = available.filter(item => selected.includes(item.key))

  const leftPages = Math.max(1, Math.ceil(unselected.length / PAGE))
  const rightPages = Math.max(1, Math.ceil(selectedItems.length / PAGE))

  useEffect(() => { if (leftPage >= leftPages) setLeftPage(Math.max(0, leftPages - 1)) }, [unselected.length])
  useEffect(() => { if (rightPage >= rightPages) setRightPage(Math.max(0, rightPages - 1)) }, [selectedItems.length])

  const pagedLeft = unselected.slice(leftPage * PAGE, (leftPage + 1) * PAGE)
  const pagedRight = selectedItems.slice(rightPage * PAGE, (rightPage + 1) * PAGE)

  const ListBox = ({ items, emptyText, action, actionIcon }: {
    items: DualItem[]
    emptyText: string
    action: (key: string) => void
    actionIcon: (key: string) => React.ReactNode
  }) => (
    <div className="overflow-hidden rounded-[var(--as-r-sm)]" style={{ border: '1px solid var(--as-hairline)', height: 168 }}>
      {items.length === 0 ? (
        <div className="h-full flex items-center justify-center">
          <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{emptyText}</span>
        </div>
      ) : (
        <div className="overflow-y-auto h-full">
          {items.map(item => (
            <div key={item.key} className="flex items-center gap-2 px-2 py-1.5 border-b hover:bg-[var(--as-parchment)] transition-colors"
              style={{ borderColor: 'var(--as-hairline)' }}>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate" style={{ color: 'var(--as-ink)' }}>{item.label}</p>
                {item.sub && <p className="text-[10px] font-mono truncate" style={{ color: 'var(--as-ink-48)' }}>{item.sub}</p>}
              </div>
              <button onClick={() => action(item.key)}
                className="shrink-0 p-0.5 rounded transition-colors hover:bg-opacity-10">
                {actionIcon(item.key)}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span style={{ color: 'var(--as-ink-48)' }}>{icon}</span>
        <span className="text-sm font-semibold" style={{ color: 'var(--as-ink)' }}>{title}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
          style={{ background: selected.length > 0 ? '#dbeafe' : 'var(--as-hairline)', color: selected.length > 0 ? '#1d4ed8' : 'var(--as-ink-48)' }}>
          {selected.length}/{available.length}
        </span>
      </div>

      {available.length === 0 ? (
        <p className="text-xs py-2" style={{ color: 'var(--as-ink-48)' }}>{emptyHint}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {/* Left — available */}
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-[10px] font-medium" style={{ color: 'var(--as-ink-48)' }}>{t('agents.dualList.available')}</span>
              <div className="flex-1 flex items-center gap-1 rounded px-1.5 py-0.5" style={{ background: 'var(--as-parchment)' }}>
                <Search size={9} style={{ color: 'var(--as-ink-48)' }} />
                <input value={search} onChange={e => { setSearch(e.target.value); setLeftPage(0) }}
                  className="flex-1 outline-none bg-transparent text-[10px]" style={{ color: 'var(--as-ink)' }} />
                {search && (
                  <button onClick={() => setSearch('')} style={{ color: 'var(--as-ink-48)' }}>
                    <X size={9} />
                  </button>
                )}
              </div>
            </div>
            <ListBox
              items={pagedLeft}
              emptyText={unselected.length === 0 ? t('agents.dualList.allSelected') : t('agents.dualList.noMatch')}
              action={onAdd}
              actionIcon={() => <ChevronRight size={13} style={{ color: 'var(--as-primary)' }} />}
            />
            {leftPages > 1 && <MiniPagination page={leftPage} total={leftPages} onChange={setLeftPage} />}
          </div>

          {/* Right — selected */}
          <div>
            <div className="mb-1.5">
              <span className="text-[10px] font-medium" style={{ color: 'var(--as-ink-48)' }}>{t('agents.dualList.selected')}</span>
            </div>
            <ListBox
              items={pagedRight}
              emptyText={t('agents.dualList.none')}
              action={onRemove}
              actionIcon={() => <X size={13} style={{ color: '#ef4444' }} />}
            />
            {rightPages > 1 && <MiniPagination page={rightPage} total={rightPages} onChange={setRightPage} />}
          </div>
        </div>
      )}
    </div>
  )
}

// ── AgentConfigDialog ─────────────────────────────────────────────────────────

function AgentConfigDialog({ agent, onClose }: { agent: AgentRecord; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const { data: allMcps = [] } = useQuery({ queryKey: ['mcp-lib'], queryFn: webuiApi.getMcpLib })
  const { data: allSkills = [] } = useQuery({ queryKey: ['skill-lib'], queryFn: webuiApi.getSkillLib })
  const { data: agentMcps = [] } = useQuery({ queryKey: ['agent-mcps', agent.id], queryFn: () => webuiApi.getAgentMcps(agent.id) })
  const { data: agentSkills = [] } = useQuery({ queryKey: ['agent-skills', agent.id], queryFn: () => webuiApi.getAgentSkills(agent.id) })

  const [selectedMcps, setSelectedMcps] = useState<string[]>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])

  useEffect(() => { setSelectedMcps(agentMcps) }, [agentMcps])
  useEffect(() => { setSelectedSkills(agentSkills) }, [agentSkills])

  const enabledSkills = (allSkills as any[]).filter((s: any) => s.is_enabled)

  const mcpItems: DualItem[] = (allMcps as any[]).map((m: any) => ({ key: m.name, label: m.name, sub: m.transport }))
  const skillItems: DualItem[] = enabledSkills.map((s: any) => ({ key: s.path, label: s.name, sub: s.path }))

  const saveMut = useMutation({
    mutationFn: () => Promise.all([
      webuiApi.setAgentMcps(agent.id, selectedMcps),
      webuiApi.setAgentSkills(agent.id, selectedSkills),
    ]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-mcps', agent.id] })
      qc.invalidateQueries({ queryKey: ['agent-skills', agent.id] })
      onClose()
    },
  })

  return (
    <div className="as-overlay">
      <div className="as-dialog" style={{ maxWidth: 640, width: '90vw', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1">
            <h3 className="text-base font-semibold" style={{ color: 'var(--as-ink)' }}>{t('agents.config.title')}</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--as-ink-48)' }}>{agent.data.name}</p>
          </div>
          <button onClick={onClose} className="as-btn as-btn-sm"
            style={{ color: 'var(--as-ink-80)', border: '1px solid var(--as-hairline)' }}>{t('common.button.cancel')}</button>
          <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
            className="as-btn as-btn-primary as-btn-sm">
            {saveMut.isPending ? t('common.status.saving') : t('common.button.save')}
          </button>
        </div>

        <div className="border-t" style={{ borderColor: 'var(--as-hairline)' }} />

        <div className="overflow-y-auto space-y-6 py-4" style={{ maxHeight: '65vh' }}>
          <DualListSection
            title={t('agents.config.mcpServers')}
            icon={<Network size={14} />}
            available={mcpItems}
            selected={selectedMcps}
            onAdd={name => setSelectedMcps(prev => [...prev, name])}
            onRemove={name => setSelectedMcps(prev => prev.filter(n => n !== name))}
            emptyHint={t('agents.config.emptyMcp')}
          />

          <div className="border-t" style={{ borderColor: 'var(--as-hairline)' }} />

          <DualListSection
            title={t('agents.config.skills')}
            icon={<Wand2 size={14} />}
            available={skillItems}
            selected={selectedSkills}
            onAdd={path => setSelectedSkills(prev => [...prev, path])}
            onRemove={path => setSelectedSkills(prev => prev.filter(p => p !== path))}
            emptyHint={
              (allSkills as any[]).length === 0
                ? t('agents.config.emptySkillsNoPaths')
                : t('agents.config.emptySkillsAllDisabled')
            }
          />
        </div>
      </div>
    </div>
  )
}

export default function AgentsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<'create' | AgentRecord | null>(null)
  const [configAgent, setConfigAgent] = useState<AgentRecord | null>(null)
  const [page, setPage] = useState(0)
  const { data: agents = [], isLoading } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })
  const { allowsAgent } = useScopedResources()
  const deleteMut = useMutation({
    mutationFn: (id: string) => agentsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  })

  const PAGE = 10
  const visible = agents.filter(a => allowsAgent(a.id))
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE))
  const paged = visible.slice(page * PAGE, (page + 1) * PAGE)

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>{t('agents.title')}</h2>
        <button onClick={() => setDialog('create')} className="as-btn as-btn-primary as-btn-sm">{t('agents.button.new')}</button>
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {isLoading && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('common.status.loading')}</p>}
        {paged.map(agent => (
          <div key={agent.id} className="flex items-center gap-3 p-4 bg-white rounded-[var(--as-r-md)] transition-colors"
            style={{ border: '1px solid var(--as-hairline)' }}>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" style={{ color: 'var(--as-ink)' }}>{agent.data.name}</p>
              <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--as-ink-48)' }}>{agent.id.slice(0, 8)}…</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => { sessionStorage.setItem('chatWithAgent', agent.id); navigate('/chat') }}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded-[var(--as-r-sm)]"
                style={{ color: 'var(--as-primary)', border: '1px solid var(--as-primary)' }}
                title={t('agents.button.startChatTitle')}>
                <MessageSquare size={11} /> {t('agents.button.chat')}
              </button>
              <button onClick={() => setConfigAgent(agent)} className="as-btn as-btn-ghost" title={t('agents.button.configTitle')}>
                <Settings2 size={13} />
              </button>
              <button onClick={() => setDialog(agent)} className="as-btn as-btn-ghost"><Pencil size={13} /></button>
              <button onClick={() => { if (confirm(t('agents.confirm.delete', { name: agent.data.name }))) deleteMut.mutate(agent.id) }} className="as-btn as-btn-danger"><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
        {!isLoading && agents.length === 0 && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('agents.empty.noAgents')}</p>}
      </div>
      {agents.length > PAGE && (
        <div className="px-6 border-t flex items-center gap-3 shrink-0"
          style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-footer-bar-h)', background: 'var(--as-parchment)' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.prev')}</button>
          <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.next')}</button>
          <span className="text-xs ml-auto" style={{ color: 'var(--as-ink-48)' }}>{t('common.pagination.total', { count: agents.length })}</span>
        </div>
      )}
      {dialog && (
        <AgentDialog
          agent={dialog === 'create' ? null : dialog}
          onClose={() => setDialog(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['agents'] }); setDialog(null) }}
        />
      )}
      {configAgent && (
        <AgentConfigDialog agent={configAgent} onClose={() => setConfigAgent(null)} />
      )}
    </div>
  )
}
