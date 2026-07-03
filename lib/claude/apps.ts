// lib/claude/apps.ts
// App-identity routing: maps a feature's target app to its product repo, base
// branch, and stack. This is the single source of truth for which codebase the
// chat's research tools read — deliberately a typed constant (PR-reviewed, no
// silent drift) rather than env/DB config. Verified against the GitHub org
// 2026-07-03; default branches differ per repo, so never assume 'develop'.

export type AppSlug = 'web' | 'cms' | 'mobile' | 'desktop'

export interface AppTarget {
  slug: AppSlug
  label: string
  repo: string // owner/name
  baseBranch: string
  stack: string // one-line stack description injected into the system prompt
}

export const APP_REGISTRY: Record<AppSlug, AppTarget> = {
  web: {
    slug: 'web',
    label: 'Viscap Web App',
    repo: 'Viscap-Media/app.viscap.ai',
    baseBranch: 'develop',
    stack: 'Next.js pages-router, React, Ant Design (wrapped in components/Admin/utils/Antd*.tsx), CSS modules, Firebase',
  },
  cms: {
    slug: 'cms',
    label: 'Education CMS',
    repo: 'Viscap-Media/education-cms',
    baseBranch: 'develop',
    stack: 'TypeScript web app (React)',
  },
  mobile: {
    slug: 'mobile',
    label: 'Media Sync Mobile',
    repo: 'Viscap-Media/media-sync-mobile',
    baseBranch: 'main',
    stack: 'React Native (TypeScript, Kotlin/Swift native shells)',
  },
  desktop: {
    slug: 'desktop',
    label: 'Media Sync Desktop',
    repo: 'Viscap-Media/media-sync-desktop',
    baseBranch: 'main',
    stack: 'TypeScript desktop app (HTML/SCSS)',
  },
}

export const APP_SLUGS = Object.keys(APP_REGISTRY) as AppSlug[]

/** Resolves a feature's app to its target; unknown/legacy values fall back to web. */
export function getAppTarget(slug: string | null | undefined): AppTarget {
  return APP_REGISTRY[(slug ?? 'web') as AppSlug] ?? APP_REGISTRY.web
}
