import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { credentialsApi } from '@/api/credentials'
import { webuiApi } from '@/api/webui'
import { Trash2, Star, Plus, ChevronDown, ChevronRight } from 'lucide-react'

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

function credProvider(credType: string) {
  return PROVIDERS.find(p => p.type === credType)
}

function CredentialCard({ cred, onDelete }: { cred: any; onDelete: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [newModel, setNewModel] = useState('')

  const credType = String(cred.data?.type ?? '')
  const provider = credProvider(credType)

  const { data: defaultModel } = useQuery({ queryKey: ['default-model'], queryFn: webuiApi.getDefaultModel })
  const { data: backendModels = [] } = useQuery({
    queryKey: ['models', provider?.key],
    queryFn: () => credentialsApi.models(provider!.key),
    enabled: expanded && !!provider,
  })
  const { data: customModels = [] } = useQuery({
    queryKey: ['cred-models', cred.id],
    queryFn: () => webuiApi.getCredModels(cred.id),
    enabled: expanded,
  })

  const allModels = [
    ...(backendModels as any[]).map((m: any) => ({ name: m.name, label: m.label ?? m.name, custom: false })),
    ...(customModels as string[]).map(n => ({ name: n, label: n, custom: true })),
  ]

  const setDefaultMut = useMutation({
    mutationFn: (modelName: string) => webuiApi.setDefaultModel({
      type: provider?.modelType ?? 'openai_chat',
      credential_id: cred.id,
      model: modelName,
      parameters: {},
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['default-model'] }),
  })

  const addModelMut = useMutation({
    mutationFn: (model: string) => webuiApi.addCredModel(cred.id, model),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cred-models', cred.id] }); setNewModel('') },
  })

  const deleteModelMut = useMutation({
    mutationFn: (model: string) => webuiApi.deleteCredModel(cred.id, model),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cred-models', cred.id] }),
  })

  const isDefault = (modelName: string) =>
    (defaultModel as any)?.credential_id === cred.id && (defaultModel as any)?.model === modelName

  return (
    <div className="bg-white rounded-[var(--as-r-md)]" style={{ border: '1px solid var(--as-hairline)' }}>
      <div className="flex items-center gap-3 p-4">
        <button onClick={() => setExpanded(e => !e)} className="p-0.5" style={{ color: 'var(--as-ink-48)' }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: 'var(--as-ink)' }}>{credType}</p>
          <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--as-ink-48)' }}>{cred.id.slice(0, 8)}…</p>
        </div>
        {(defaultModel as any)?.credential_id === cred.id && (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: '#dbeafe', color: '#1d4ed8' }}>
            {(defaultModel as any).model}
          </span>
        )}
        <button onClick={onDelete} className="as-btn as-btn-danger"><Trash2 size={13} /></button>
      </div>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-1.5" style={{ borderColor: 'var(--as-hairline)', background: 'var(--as-parchment)' }}>
          <p className="text-xs font-medium mb-2" style={{ color: 'var(--as-ink-80)' }}>{t('credentials.card.models')}</p>
          {allModels.map(m => (
            <div key={m.name} className="flex items-center gap-2 rounded-[var(--as-r-sm)] px-2 py-1.5"
              style={{ background: isDefault(m.name) ? '#eff6ff' : 'var(--as-parchment)' }}>
              <span className="flex-1 text-xs" style={{ color: 'var(--as-ink-80)' }}>{m.label}{m.custom ? t('credentials.card.customSuffix') : ''}</span>
              {isDefault(m.name)
                ? <span className="text-[10px]" style={{ color: 'var(--as-primary)' }}><Star size={11} className="inline" /> {t('credentials.card.badge.default')}</span>
                : <button onClick={() => setDefaultMut.mutate(m.name)} className="text-[10px] hover:underline" style={{ color: 'var(--as-primary)' }}>{t('credentials.card.setDefault')}</button>
              }
              {m.custom && (
                <button onClick={() => deleteModelMut.mutate(m.name)} className="p-0.5" style={{ color: '#ef4444' }}><Trash2 size={11} /></button>
              )}
            </div>
          ))}
          {allModels.length === 0 && <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('credentials.card.emptyModels')}</p>}
          <div className="flex items-center gap-2 pt-1">
            <input value={newModel} onChange={e => setNewModel(e.target.value)} placeholder={t('credentials.card.customModelPlaceholder')}
              autoComplete="off"
              className="as-input"
              onKeyDown={e => e.key === 'Enter' && newModel.trim() && addModelMut.mutate(newModel.trim())} />
            <button onClick={() => newModel.trim() && addModelMut.mutate(newModel.trim())}
              disabled={!newModel.trim() || addModelMut.isPending}
              className="flex items-center gap-1 px-2 py-1 text-white text-xs rounded-[var(--as-pill)] disabled:opacity-40"
              style={{ background: 'var(--as-primary)' }}>
              <Plus size={11} /> {t('common.button.add')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function CredentialsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>(PROVIDERS[0])
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [page, setPage] = useState(0)

  const { data: credentials = [] } = useQuery({ queryKey: ['credentials'], queryFn: credentialsApi.list })
  const createMut = useMutation({
    mutationFn: () => credentialsApi.create({ type: provider.type, api_key: apiKey, ...(baseUrl ? { base_url: baseUrl } : {}) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['credentials'] }); setShowAdd(false); setApiKey(''); setBaseUrl('') },
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => credentialsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  })

  const PAGE = 6
  const list = credentials as any[]
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE))
  const paged = list.slice(page * PAGE, (page + 1) * PAGE)

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>{t('credentials.title')}</h2>
        <button onClick={() => setShowAdd(true)} className="as-btn as-btn-primary as-btn-sm">{t('credentials.button.add')}</button>
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {paged.map((cred: any) => (
          <CredentialCard key={cred.id} cred={cred} onDelete={() => { if (confirm(t('credentials.confirm.delete'))) deleteMut.mutate(cred.id) }} />
        ))}
        {list.length === 0 && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('credentials.empty.noCredentials')}</p>}
      </div>
      {list.length > PAGE && (
        <div className="px-6 border-t flex items-center gap-3 shrink-0"
          style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-footer-bar-h)', background: 'var(--as-parchment)' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.prev')}</button>
          <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.next')}</button>
          <span className="text-xs ml-auto" style={{ color: 'var(--as-ink-48)' }}>{t('common.pagination.total', { count: list.length })}</span>
        </div>
      )}
      {showAdd && (
        <div className="as-overlay">
          <div className="as-dialog">
            <h3 className="text-base font-semibold">{t('credentials.dialog.add')}</h3>
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--as-ink-80)' }}>{t('credentials.form.provider')}</label>
              <select value={provider.key} onChange={e => setProvider(PROVIDERS.find(p => p.key === e.target.value)!)}
                className="as-input">
                {PROVIDERS.map(p => <option key={p.key} value={p.key}>{t(p.labelKey)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--as-ink-80)' }}>{t('credentials.form.apiKey')}</label>
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={t('credentials.form.apiKeyPlaceholder')}
                autoComplete="new-password"
                className="as-input" />
            </div>
            {provider.key === 'ollama' && (
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--as-ink-80)' }}>{t('credentials.form.baseUrl')}</label>
                <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder={t('credentials.form.baseUrlPlaceholder')}
                  className="as-input" />
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm" style={{ color: 'var(--as-ink-80)' }}>{t('common.button.cancel')}</button>
              <button onClick={() => createMut.mutate()} disabled={!apiKey || createMut.isPending}
                className="as-btn as-btn-primary">
                {createMut.isPending ? t('common.status.saving') : t('common.button.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
