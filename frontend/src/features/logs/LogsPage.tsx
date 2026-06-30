import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiClient } from '@/api/client'
import { RefreshCw } from 'lucide-react'

type Level = 'All' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'
const LEVELS: Level[] = ['All', 'ERROR', 'WARN', 'INFO', 'DEBUG']
const LEVEL_COLOR: Record<Level, string> = {
  All: 'var(--as-ink)', ERROR: '#ef4444', WARN: '#f97316', INFO: '#3b82f6', DEBUG: 'var(--as-ink-48)',
}

const SOURCE_LABEL_KEY = {
  app: 'term.source.app',
  service: 'term.source.service',
} as const

const LEVEL_LABEL_KEY = {
  All: 'term.logLevel.all',
  ERROR: 'term.logLevel.error',
  WARN: 'term.logLevel.warn',
  INFO: 'term.logLevel.info',
  DEBUG: 'term.logLevel.debug',
} as const

function lineLevel(line: string): Level {
  const u = line.toUpperCase()
  if (u.includes('ERROR')) return 'ERROR'
  if (u.includes('WARN')) return 'WARN'
  if (u.includes('INFO')) return 'INFO'
  if (u.includes('DEBUG')) return 'DEBUG'
  return 'All'
}

export default function LogsPage() {
  const { t } = useTranslation()
  const [lines, setLines] = useState<string[]>([])
  const [source, setSource] = useState<'app' | 'service'>('app')
  const [level, setLevel] = useState<Level>('All')
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get(`/logs/${source}`)
      setLines(Array.isArray(data) ? data : (data.lines ?? []))
    } catch { setLines([t('logs.error.failedToLoad')]) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [source])

  const filtered = level === 'All' ? lines : lines.filter(l => lineLevel(l) === level)
  const counts: Record<Level, number> = {
    All: lines.length,
    ERROR: lines.filter(l => lineLevel(l) === 'ERROR').length,
    WARN: lines.filter(l => lineLevel(l) === 'WARN').length,
    INFO: lines.filter(l => lineLevel(l) === 'INFO').length,
    DEBUG: lines.filter(l => lineLevel(l) === 'DEBUG').length,
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center gap-3 flex-wrap shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight" style={{ color: 'var(--as-ink)' }}>{t('logs.title')}</h2>
        <div className="flex rounded-[var(--as-r-sm)] overflow-hidden" style={{ border: '1px solid var(--as-hairline)' }}>
          {(['app', 'service'] as const).map(s => (
            <button key={s} onClick={() => setSource(s)}
              className="px-3 py-1 text-xs transition-colors"
              style={{ background: source === s ? 'var(--as-primary)' : 'transparent', color: source === s ? '#fff' : 'var(--as-ink-80)' }}>
              {t(SOURCE_LABEL_KEY[s])}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 ml-auto flex-wrap">
          {LEVELS.map(l => (
            <button key={l} onClick={() => setLevel(l)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors"
              style={{ background: level === l ? 'var(--as-parchment)' : 'transparent', color: l === 'All' ? 'var(--as-ink-80)' : LEVEL_COLOR[l], fontWeight: level === l ? 600 : 400 }}>
              {l !== 'All' && <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: LEVEL_COLOR[l] }} />}
              {t(LEVEL_LABEL_KEY[l])} <span style={{ color: 'var(--as-ink-48)' }}>{counts[l]}</span>
            </button>
          ))}
          <button onClick={load} className="p-1 rounded" style={{ color: 'var(--as-ink-48)' }}><RefreshCw size={13} /></button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 font-mono" style={{ background: 'var(--as-canvas)' }}>
        {loading && <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('common.status.loading')}</p>}
        {filtered.slice().reverse().map((line, i) => (
          <div key={i} className="text-xs leading-5 select-text" style={{ color: LEVEL_COLOR[lineLevel(line)] }}>{line}</div>
        ))}
        {!loading && !filtered.length && <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('logs.empty.noMatch')}</p>}
      </div>
    </div>
  )
}
