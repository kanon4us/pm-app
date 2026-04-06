import { ConfigProvider, theme, Layout } from 'antd'
import { AppNav } from '@/components/AppNav'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = { title: 'Viscap PM App' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0d1117' }}>
        <ConfigProvider
          theme={{
            algorithm: theme.darkAlgorithm,
            token: { colorPrimary: '#388bfd', fontFamily: 'SF Mono, Fira Code, monospace' },
          }}
        >
          <Layout style={{ minHeight: '100vh' }}>
            <AppNav />
            <Layout.Content>{children}</Layout.Content>
          </Layout>
        </ConfigProvider>
      </body>
    </html>
  )
}
