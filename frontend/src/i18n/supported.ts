export interface LanguageMeta {
  code: string
  label: string
  flag: string
  load: () => Promise<{ default: Record<string, unknown> }>
}

/** 语言注册表 —— 开闭核心：新增语言在此追加一项，不改动已有语言文件。 */
export const supportedLanguages: LanguageMeta[] = [
  {
    code: 'zh',
    label: '中文',
    flag: '🇨🇳',
    load: () => import('./locales/zh.json'),
  },
  {
    code: 'en',
    label: 'English',
    flag: '🇺🇸',
    load: () => import('./locales/en.json'),
  },
]

export const defaultLanguage = 'zh'
export const languageStorageKey = 'as_lang'

export const isSupportedLanguage = (code: string | null | undefined): code is string =>
  !!code && supportedLanguages.some((l) => l.code === code)
