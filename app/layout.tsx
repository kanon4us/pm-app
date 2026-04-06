import { ConfigProvider, theme } from 'antd'
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
          {children}
        </ConfigProvider>
      </body>
    </html>
  )
}
