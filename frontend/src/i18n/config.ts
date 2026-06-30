import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhResources from './locales/zh.json'
import {
  supportedLanguages,
  defaultLanguage,
  languageStorageKey,
  isSupportedLanguage,
} from './supported'

const stored = localStorage.getItem(languageStorageKey)
const initialLanguage = isSupportedLanguage(stored) ? stored : defaultLanguage

void i18n.use(initReactI18next).init({
  resources: { [defaultLanguage]: { translation: zhResources } },
  lng: initialLanguage,
  fallbackLng: defaultLanguage,
  supportedLngs: supportedLanguages.map((l) => l.code),
  returnNull: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
  saveMissing: true,
  missingKeyHandler: (lngs, _ns, key) => {
    if (import.meta.env.DEV) {
      console.warn(`[i18n] missing key: ${key} (lng=${lngs.join(',')})`)
    }
  },
})

/** 懒加载某语言资源（默认语言已同步加载，直接跳过）。失败则回退默认语言。 */
export async function ensureLocaleLoaded(lng: string): Promise<void> {
  if (lng === defaultLanguage) return
  if (i18n.hasResourceBundle(lng, 'translation')) return
  const meta = supportedLanguages.find((l) => l.code === lng)
  if (!meta) return
  try {
    const mod = await meta.load()
    i18n.addResourceBundle(lng, 'translation', mod.default, true, true)
  } catch (e) {
    console.warn(`[i18n] failed to load locale ${lng}, falling back to ${defaultLanguage}`, e)
  }
}

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng
  localStorage.setItem(languageStorageKey, lng)
})

// 若初始语言为非默认（如用户上次选过 en），预加载后再切换，避免首屏 fallback 闪烁。
if (initialLanguage !== defaultLanguage) {
  void ensureLocaleLoaded(initialLanguage).then(() => {
    void i18n.changeLanguage(initialLanguage)
  })
}

document.documentElement.lang = i18n.language

export default i18n
