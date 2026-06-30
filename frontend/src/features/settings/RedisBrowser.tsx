import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { webuiApi } from '@/api/webui'
import { RefreshCw, Search, ChevronLeft, ChevronRight } from 'lucide-react'

const PAGE_SIZES = [20, 50, 100] as const
const DEFAULT_PAGE_SIZE = 20

interface KeyItem { key: string; type: string; ttl: number }
interface Row { field: string; value: string; truncated?: boolean }
interface KeyDetail {
  key: string
  type: string
  ttl: number
  size: number | null
  rows: Row[]
}

/** Render a value cell: pretty-print JSON, else plain text. */
function ValueCell({ value, truncated }: { value: string; truncated?: boolean }) {
  const { t } = useTranslation()
  let pretty: string | null = null
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === 'object' && parsed !== null) {
      pretty = JSON.stringify(parsed, null, 2)
    }
  } catch { /* not JSON — show raw */ }
  return (
    <div className="min-w-0">
      {pretty !== null ? (
        <pre className="text-xs font-mono whitespace-pre-wrap break-all" style={{ color: 'var(--as-ink)' }}>{pretty}</pre>
      ) : (
        <p className="text-xs font-mono break-all" style={{ color: 'var(--as-ink)' }}>{value || '(empty)'}</p>
      )}
      {truncated && (
        <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}> {t('redis.detail.truncated')}</span>
      )}
    </div>
  )
}

export default function RedisBrowser() {
  const { t } = useTranslation()

  // ── Key list (cursor-based paging) ──────────────────────────────────────────
  const [patternInput, setPatternInput] = useState('*')
  const [appliedPattern, setAppliedPattern] = useState('*')
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [keyPage, setKeyPage] = useState(1)
  const [cursors, setCursors] = useState<number[]>([0])
  const [keys, setKeys] = useState<KeyItem[]>([])
  const [done, setDone] = useState(false)
  const [loadingKeys, setLoadingKeys] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const applyPattern = () => {
    setAppliedPattern(patternInput.trim() || '*')
    setKeyPage(1)
    setCursors([0])
    setSelectedKey(null)
  }

  // Reset cursor chain when pattern or page size changes (page resets above handle the rest).
  useEffect(() => {
    let cancelled = false
    const cursor = cursors[keyPage - 1] ?? 0
    setLoadingKeys(true)
    webuiApi.getRedisKeys(cursor, appliedPattern, pageSize)
      .then(res => {
        if (cancelled) return
        setKeys(res.keys)
        setDone(res.done)
        setCursors(prev => {
          const next = [...prev]
          next[keyPage] = res.cursor
          return next
        })
      })
      .finally(() => { if (!cancelled) setLoadingKeys(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedPattern, keyPage, pageSize])

  const goKeyPage = (delta: number) => {
    const next = keyPage + delta
    if (next < 1) return
    if (delta > 0 && done) return
    setKeyPage(next)
  }

  // ── Detail (offset-based true paging) ───────────────────────────────────────
  const [detailPage, setDetailPage] = useState(1)
  useEffect(() => { setDetailPage(1) }, [selectedKey])

  const { data: detail, isFetching: loadingDetail, refetch: refetchDetail } = useQuery<KeyDetail>({
    queryKey: ['redis-key', selectedKey, detailPage, pageSize],
    queryFn: () => webuiApi.getRedisKey(selectedKey!, (detailPage - 1) * pageSize, pageSize),
    enabled: !!selectedKey,
  })

  const detailPages = (detail && detail.size != null)
    ? Math.max(1, Math.ceil(detail.size / pageSize))
    : null

  // Column model by type
  const showFieldCol = detail && !['string', 'set'].includes(detail.type)

  const inputCls = 'as-input text-xs font-mono'
  const badgeCls = (type: string) =>
    `text-[10px] px-1.5 py-0.5 rounded font-medium ${type === 'string' ? 'bg-emerald-100 text-emerald-700'
      : type === 'list' ? 'bg-amber-100 text-amber-700'
      : type === 'set' ? 'bg-blue-100 text-blue-700'
      : type === 'hash' ? 'bg-purple-100 text-purple-700'
      : type === 'zset' ? 'bg-pink-100 text-pink-700'
      : 'bg-gray-100 text-gray-600'}`

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="px-4 py-2 border-b flex items-center gap-2 shrink-0" style={{ borderColor: 'var(--as-hairline)', background: 'var(--as-parchment)' }}>
        <Search size={13} style={{ color: 'var(--as-ink-48)' }} />
        <input
          value={patternInput}
          onChange={e => setPatternInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && applyPattern()}
          placeholder={t('redis.searchPlaceholder')}
          className={`${inputCls} flex-1`}
          autoComplete="off"
        />
        <button onClick={applyPattern} className="as-btn as-btn-primary as-btn-sm">{t('redis.refresh')}</button>
        <select
          value={pageSize}
          onChange={e => { setPageSize(Number(e.target.value)); setKeyPage(1); setCursors([0]); setSelectedKey(null) }}
          className="as-input text-xs"
        >
          {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: key list */}
        <div className="w-72 shrink-0 border-r flex flex-col overflow-hidden" style={{ borderColor: 'var(--as-hairline)' }}>
          <div className="flex-1 overflow-y-auto">
            {loadingKeys && keys.length === 0 ? (
              <p className="p-3 text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('common.status.loading')}</p>
            ) : keys.length === 0 ? (
              <p className="p-3 text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('redis.empty.keys')}</p>
            ) : (
              keys.map(item => (
                <button
                  key={item.key}
                  onClick={() => setSelectedKey(item.key)}
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2 transition-colors"
                  style={{
                    background: selectedKey === item.key ? 'var(--as-primary-light, rgba(59,130,246,0.08))' : 'transparent',
                    borderBottom: '1px solid var(--as-hairline)',
                  }}
                >
                  <span className={`shrink-0 ${badgeCls(item.type)}`}>{t(`redis.type.${item.type}` as any)}</span>
                  <span className="flex-1 min-w-0 text-xs font-mono truncate" style={{ color: 'var(--as-ink)' }}>{item.key}</span>
                </button>
              ))
            )}
          </div>
          {/* Key list pager */}
          <div className="px-3 py-2 border-t flex items-center gap-2 shrink-0" style={{ borderColor: 'var(--as-hairline)', background: 'var(--as-parchment)' }}>
            <button onClick={() => goKeyPage(-1)} disabled={keyPage === 1} className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }}>
              <ChevronLeft size={13} />
            </button>
            <span className="text-xs flex-1 text-center" style={{ color: 'var(--as-ink-48)' }}>
              {t('redis.page.pageOnly', { page: keyPage })}{done ? ` · ${t('redis.page.noMore')}` : ''}
            </span>
            <button onClick={() => goKeyPage(1)} disabled={done || loadingKeys} className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }}>
              <ChevronRight size={13} />
            </button>
          </div>
        </div>

        {/* Right: detail */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!detail ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('redis.empty.noSelection')}</p>
            </div>
          ) : (
            <>
              <div className="px-4 py-2 border-b flex items-center gap-4 shrink-0" style={{ borderColor: 'var(--as-hairline)', background: 'var(--as-parchment)' }}>
                <span className="text-xs font-mono truncate" style={{ color: 'var(--as-ink)' }}>{detail.key}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badgeCls(detail.type)}`}>{t(`redis.type.${detail.type}` as any)}</span>
                <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>
                  {t('redis.detail.size')}: <b style={{ color: 'var(--as-ink)' }}>{detail.size ?? '—'}</b>
                </span>
                <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>
                  {t('redis.detail.ttl')}: <b style={{ color: 'var(--as-ink)' }}>{detail.ttl === -1 ? t('redis.detail.ttlPermanent') : `${detail.ttl}s`}</b>
                </span>
                <button
                  onClick={() => refetchDetail()}
                  className="ml-auto as-btn as-btn-ghost as-btn-sm"
                  title={t('redis.refresh')}
                  style={{ padding: '4px' }}
                >
                  <RefreshCw size={13} className={loadingDetail ? 'animate-spin' : ''} />
                </button>
              </div>

              <div className="flex-1 overflow-auto p-2">
                <table className="w-full text-left border-collapse" style={{ borderColor: 'var(--as-hairline)' }}>
                  <thead>
                    <tr style={{ background: 'var(--as-parchment)' }}>
                      {showFieldCol && (
                        <th className="text-xs font-semibold px-3 py-2 border-b w-40" style={{ borderColor: 'var(--as-hairline)', color: 'var(--as-ink-80)' }}>
                          {detail.type === 'list' ? '#' : detail.type === 'zset' ? 'score' : detail.type === 'stream' ? 'id' : 'field'}
                        </th>
                      )}
                      <th className="text-xs font-semibold px-3 py-2 border-b" style={{ borderColor: 'var(--as-hairline)', color: 'var(--as-ink-80)' }}>value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.rows.map((row, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid var(--as-hairline)' }}>
                        {showFieldCol && (
                          <td className="px-3 py-2 align-top text-xs font-mono" style={{ color: 'var(--as-ink-80)' }}>{row.field}</td>
                        )}
                        <td className="px-3 py-2 align-top"><ValueCell value={row.value} truncated={row.truncated} /></td>
                      </tr>
                    ))}
                    {detail.rows.length === 0 && (
                      <tr><td className="px-3 py-3 text-xs" style={{ color: 'var(--as-ink-48)' }}>(empty)</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Detail pager */}
              {detailPages && (
                <div className="px-4 py-2 border-t flex items-center gap-2 shrink-0" style={{ borderColor: 'var(--as-hairline)', background: 'var(--as-parchment)' }}>
                  <button onClick={() => setDetailPage(p => Math.max(1, p - 1))} disabled={detailPage === 1} className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }}>
                    <ChevronLeft size={13} />
                  </button>
                  <span className="text-xs flex-1 text-center" style={{ color: 'var(--as-ink-48)' }}>
                    {t('redis.page.pageOf', { page: detailPage, pages: detailPages })}
                  </span>
                  <button onClick={() => setDetailPage(p => Math.min(detailPages, p + 1))} disabled={detailPage >= detailPages} className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }}>
                    <ChevronRight size={13} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
