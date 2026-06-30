import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SkillDef } from '@/api/webui'
import { Wand2, X, ChevronLeft, ChevronRight, Search } from 'lucide-react'

const PAGE = 10

interface Props {
  skills: SkillDef[]
  boundPaths: string[]
  onPick: (skill: SkillDef) => void
  onClose: () => void
}

export default function SkillPickerModal({ skills, boundPaths, onPick, onClose }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  const boundSet = useMemo(() => new Set(boundPaths), [boundPaths])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? skills.filter(s => s.name.toLowerCase().includes(q)) : [...skills]
    // Bound skills first (stable within each group)
    return list.sort((a, b) => {
      const ab = boundSet.has(a.path) ? 0 : 1
      const bb = boundSet.has(b.path) ? 0 : 1
      return ab - bb
    })
  }, [skills, query, boundSet])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const safePage = Math.min(page, totalPages - 1)
  const paged = filtered.slice(safePage * PAGE, (safePage + 1) * PAGE)

  const onQueryChange = (v: string) => { setQuery(v); setPage(0) }

  return (
    <div className="as-overlay" onClick={onClose}>
      <div className="as-dialog" onClick={e => e.stopPropagation()} style={{ maxWidth: 480, width: '90vw' }}>
        <div className="flex items-center mb-3">
          <h3 className="text-base font-semibold flex-1" style={{ color: 'var(--as-ink)' }}>
            {t('chat.skill.picker.title')}
          </h3>
          <button onClick={onClose} className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }}>
            <X size={15} />
          </button>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--as-ink-48)' }}>{t('chat.skill.picker.subtitle')}</p>

        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--as-r-sm)] mb-3"
          style={{ border: '1px solid var(--as-hairline)', background: '#fff' }}>
          <Search size={13} style={{ color: 'var(--as-ink-48)' }} />
          <input
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            placeholder={t('chat.skill.picker.searchPlaceholder')}
            autoFocus
            className="flex-1 text-sm outline-none bg-transparent"
            style={{ color: 'var(--as-ink)' }}
          />
        </div>

        <div className="space-y-1 max-h-80 overflow-y-auto">
          {paged.map(s => {
            const bound = boundSet.has(s.path)
            return (
              <button
                key={s.path}
                onClick={() => onPick(s)}
                className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-[var(--as-r-sm)] transition-colors hover:bg-[var(--as-parchment)]"
                style={{ border: '1px solid var(--as-hairline)' }}
              >
                <Wand2 size={15} style={{ color: 'var(--as-primary)' }} />
                <span className="text-sm font-medium truncate" style={{ color: 'var(--as-ink)' }}>{s.name}</span>
                {bound && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
                    style={{ background: 'var(--as-divider)', color: 'var(--as-ink-80)' }}>
                    {t('chat.skill.picker.bound')}
                  </span>
                )}
              </button>
            )
          })}
          {filtered.length === 0 && (
            <p className="text-sm text-center py-6" style={{ color: 'var(--as-ink-48)' }}>
              {t('chat.skill.picker.noMatch')}
            </p>
          )}
        </div>

        {filtered.length > PAGE && (
          <div className="flex items-center gap-2 pt-3 mt-2 border-t" style={{ borderColor: 'var(--as-hairline)' }}>
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}
              className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }}>
              <ChevronLeft size={13} />
            </button>
            <span className="text-xs flex-1 text-center" style={{ color: 'var(--as-ink-48)' }}>
              {safePage + 1} / {totalPages} · {t('common.pagination.total', { count: filtered.length })}
            </span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}
              className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }}>
              <ChevronRight size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
