'use client'
import { useEffect, useState } from 'react'
import { Layout, Menu } from 'antd'
import {
  ThunderboltOutlined, CalendarOutlined, PartitionOutlined, ControlOutlined,
  ExperimentOutlined, TeamOutlined, ToolOutlined, SettingOutlined,
} from '@ant-design/icons'
import { usePathname } from 'next/navigation'
import Link from 'next/link'

const COLLAPSE_KEY = 'appnav-collapsed'

export function AppNav() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1')
  }, [])

  function onCollapse(next: boolean) {
    setCollapsed(next)
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
  }

  return (
    <Layout.Sider
      width={200}
      collapsible
      collapsed={collapsed}
      onCollapse={onCollapse}
      collapsedWidth={56}
      style={{ background: '#0d1117', borderRight: '1px solid #21262d', minHeight: '100vh' }}
    >
      <div style={{ padding: '16px', color: '#58a6ff', fontWeight: 'bold', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden' }}>
        {collapsed ? 'V' : 'Viscap PM'}
      </div>
      <Menu
        theme="dark"
        mode="inline"
        selectedKeys={[pathname]}
        style={{ background: '#0d1117', borderRight: 'none' }}
        items={[
          { key: '/', icon: <ThunderboltOutlined />, label: <Link href="/">Trigger Queue</Link> },
          { key: '/sprint', icon: <CalendarOutlined />, label: <Link href="/sprint">Sprint Planner</Link> },
          { key: '/workflows', icon: <PartitionOutlined />, label: <Link href="/workflows">Workflows</Link> },
          { key: '/triggers/config', icon: <ControlOutlined />, label: <Link href="/triggers/config">Trigger Config</Link> },
          { key: '/experiments', icon: <ExperimentOutlined />, label: <Link href="/experiments">Experiments</Link> },
          { key: '/dev-team', icon: <TeamOutlined />, label: <Link href="/dev-team">Dev Team</Link> },
          { key: '/setup', icon: <ToolOutlined />, label: <Link href="/setup">Setup</Link> },
          { key: '/settings', icon: <SettingOutlined />, label: <Link href="/settings">Settings</Link> },
        ]}
      />
    </Layout.Sider>
  )
}
