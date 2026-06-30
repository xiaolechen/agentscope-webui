import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentRecord } from '@/api/agents'
import { Bot, X, ChevronLeft, ChevronRight, Search } from 'lucide-react'

const PAGE = 10

interface Props {
  agents: AgentRecord[]
  onPick: (id: string) => void
  onClose: () => void
}

export default function AgentPickerModal({ agents, onPick, onClose }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return agents
    return agents.filter(a => (a.data.name ?? '').toLowerCase().includes(q))
  }, [agents, query])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const safePage = Math.min(page, totalPages - 1)
  const paged = filtered.slice(safePage * PAGE, (safePage + 1) * PAGE)

  const onQueryChange = (v: string) => {
    setQuery(v)
    setPage(0)
  }

  return (
    <div className="as-overlay" onClick={onClose}>
      <div
        className="as-dialog"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 480, width: '90vw' }}
      >
        <div className="flex items-center mb-3">
          <h3 className="text-base font-semibold flex-1" style={{ color: 'var(--as-ink)' }}>
            {t('chat.picker.title')}
          </h3>
          <button onClick={onClose} className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }}>
            <X size={15} />
          </button>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--as-ink-48)' }}>{t('chat.picker.subtitle')}</p>

        {/* Search */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--as-r-sm)] mb-3"
          style={{ border: '1px solid var(--as-hairline)', background: '#fff' }}>
          <Search size={13} style={{ color: 'var(--as-ink-48)' }} />
          <input
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            placeholder={t('chat.picker.searchPlaceholder')}
            autoFocus
            className="flex-1 text-sm outline-none bg-transparent"
            style={{ color: 'var(--as-ink)' }}
          />
        </div>

        {/* List */}
        <div className="space-y-1 max-h-80 overflow-y-auto">
          {paged.map(a => (
            <button
              key={a.id}
              onClick={() => onPick(a.id)}
              className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-[var(--as-r-sm)] transition-colors hover:bg-[var(--as-parchment)]"
              style={{ border: '1px solid var(--as-hairline)' }}
            >
              <Bot size={15} style={{ color: 'var(--as-primary)' }} />
              <span className="text-sm font-medium truncate" style={{ color: 'var(--as-ink)' }}>
                {a.data.name}
              </span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-center py-6" style={{ color: 'var(--as-ink-48)' }}>
              {t('chat.picker.noMatch')}
            </p>
          )}
        </div>

        {/* Pagination */}
        {filtered.length > PAGE && (
          <div className="flex items-center gap-2 pt-3 mt-2 border-t"
            style={{ borderColor: 'var(--as-hairline)' }}>
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="as-btn as-btn-ghost as-btn-sm"
              style={{ padding: '4px' }}
            >
              <ChevronLeft size={13} />
            </button>
            <span className="text-xs flex-1 text-center" style={{ color: 'var(--as-ink-48)' }}>
              {safePage + 1} / {totalPages} · {t('common.pagination.total', { count: filtered.length })}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              className="as-btn as-btn-ghost as-btn-sm"
              style={{ padding: '4px' }}
            >
              <ChevronRight size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
