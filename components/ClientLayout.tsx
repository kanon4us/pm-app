'use client'

import { ConfigProvider, theme, Layout } from 'antd'
import { AppNav } from '@/components/AppNav'
import type { ReactNode } from 'react'

const { Content } = Layout

export function ClientLayout({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: { colorPrimary: '#388bfd', fontFamily: 'SF Mono, Fira Code, monospace' },
      }}
    >
      <Layout style={{ minHeight: '100vh' }}>
        <AppNav />
        <Content>{children}</Content>
      </Layout>
    </ConfigProvider>
  )
}
