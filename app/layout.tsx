import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { ClientLayout } from '@/components/ClientLayout'

export const metadata: Metadata = { title: 'Viscap PM App' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0d1117' }}>
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  )
}
