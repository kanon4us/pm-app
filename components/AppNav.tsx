'use client'
import { Layout, Menu } from 'antd'
import { usePathname } from 'next/navigation'
import Link from 'next/link'

export function AppNav() {
  const pathname = usePathname()
  return (
    <Layout.Sider width={200} style={{ background: '#0d1117', borderRight: '1px solid #21262d', minHeight: '100vh' }}>
      <div style={{ padding: '16px', color: '#58a6ff', fontWeight: 'bold', fontFamily: 'monospace' }}>Viscap PM</div>
      <Menu
        theme="dark"
        mode="inline"
        selectedKeys={[pathname]}
        style={{ background: '#0d1117', borderRight: 'none' }}
        items={[
          { key: '/', label: <Link href="/">Trigger Queue</Link> },
          { key: '/sprint', label: <Link href="/sprint">Sprint Planner</Link> },
          { key: '/workflows', label: <Link href="/workflows">Workflows</Link> },
          { key: '/triggers/config', label: <Link href="/triggers/config">Trigger Config</Link> },
          { key: '/experiments', label: <Link href="/experiments">Experiments</Link> },
          { key: '/setup', label: <Link href="/setup">Setup</Link> },
          { key: '/settings', label: <Link href="/settings">Settings</Link> },
        ]}
      />
    </Layout.Sider>
  )
}
