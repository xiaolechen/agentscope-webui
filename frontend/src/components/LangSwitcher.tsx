import { useEffect, useRef, useState } from 'react'
import { Languages, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ensureLocaleLoaded } from '@/i18n/config'
import { supportedLanguages } from '@/i18n/supported'

export default function LangSwitcher({ placement = 'down' }: { placement?: 'up' | 'down' }) {
  const { i18n: i18nInstance } = useTranslation()
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const current =
    supportedLanguages.find((l) => l.code === i18nInstance.language) ?? supportedLanguages[0]

  const choose = async (code: string) => {
    if (code === i18nInstance.language) {
      setOpen(false)
      return
    }
    setSwitching(true)
    try {
      await ensureLocaleLoaded(code)
      await i18nInstance.changeLanguage(code)
    } finally {
      setSwitching(false)
      setOpen(false)
    }
  }

  // 向上展开（sidebar 底部）：bottom:100% + marginBottom；向下展开（登录页顶部）：top:100% + marginTop
  const dropStyle =
    placement === 'up'
      ? { bottom: '100%', right: 0, marginBottom: '4px' }
      : { top: '100%', right: 0, marginTop: '4px' }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="as-btn as-btn-ghost"
        onClick={() => setOpen((o) => !o)}
        disabled={switching}
        title={current.label}
        style={{ padding: '5px' }}
      >
        <span className="flex items-center gap-1">
          <Languages size={14} />
          <span style={{ fontSize: '12px' }}>{current.flag}</span>
        </span>
      </button>
      {open && (
        <div
          className="as-card"
          style={{
            position: 'absolute',
            ...dropStyle,
            padding: '4px',
            minWidth: '140px',
            zIndex: 50,
          }}
        >
          {supportedLanguages.map((l) => (
            <button
              key={l.code}
              type="button"
              className="as-nav-item"
              style={{ width: '100%', justifyContent: 'space-between' }}
              onClick={() => choose(l.code)}
            >
              <span className="flex items-center gap-2">
                <span>{l.flag}</span>
                <span>{l.label}</span>
              </span>
              {l.code === current.code && <Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}