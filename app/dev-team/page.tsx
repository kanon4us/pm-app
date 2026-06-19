'use client'
import { useEffect, useState } from 'react'
import { Layout, Typography, Table, Button, Modal, Form, Input, Switch, Space, message, Popconfirm, Tag } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/fetch'

const { Content } = Layout
const { Title, Paragraph } = Typography

const errMsg = (error: unknown) => (error instanceof Error ? error.message : String(error))

interface Member {
  id: string
  name: string
  slack_id: string
  clickup_email: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export default function DevTeamPage() {
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [modalVisible, setModalVisible] = useState(false)
  const [editing, setEditing] = useState<Member | null>(null)
  const [form] = Form.useForm()

  const load = async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/dev-team')
      const data = await res.json()
      setMembers(data.members)
    } catch (error) {
      message.error(`Failed to load dev team: ${errMsg(error)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ active: true })
    setModalVisible(true)
  }

  const handleEdit = (member: Member) => {
    setEditing(member)
    form.setFieldsValue(member)
    setModalVisible(true)
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      if (editing) {
        await apiFetch(`/api/dev-team/${editing.id}`, { method: 'PUT', body: JSON.stringify(values) })
        message.success('Member updated')
      } else {
        await apiFetch('/api/dev-team', { method: 'POST', body: JSON.stringify(values) })
        message.success('Member added')
      }
      setModalVisible(false)
      load()
    } catch (error) {
      message.error(`Failed to save member: ${errMsg(error)}`)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/api/dev-team/${id}`, { method: 'DELETE' })
      message.success('Member removed')
      load()
    } catch (error) {
      message.error(`Failed to remove member: ${errMsg(error)}`)
    }
  }

  const handleToggleActive = async (member: Member) => {
    try {
      await apiFetch(`/api/dev-team/${member.id}`, { method: 'PUT', body: JSON.stringify({ active: !member.active }) })
      message.success(member.active ? 'Member deactivated' : 'Member reactivated')
      load()
    } catch (error) {
      message.error(`Failed to update member: ${errMsg(error)}`)
    }
  }

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: Member) => (
        <Space>
          {name}
          {!record.active && <Tag color="default">Inactive</Tag>}
        </Space>
      ),
    },
    { title: 'Slack ID', dataIndex: 'slack_id', key: 'slack_id', render: (v: string) => <code>{v}</code> },
    { title: 'ClickUp Email', dataIndex: 'clickup_email', key: 'clickup_email', render: (v: string | null) => v ?? <Tag color="orange">missing</Tag> },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, record: Member) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>Edit</Button>
          <Button size="small" onClick={() => handleToggleActive(record)}>{record.active ? 'Deactivate' : 'Reactivate'}</Button>
          <Popconfirm
            title="Remove this member?"
            onConfirm={() => handleDelete(record.id)}
            okText="Remove"
            okButtonProps={{ danger: true }}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>Remove</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Content style={{ padding: '24px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Title level={2}>Dev Team</Title>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>Add Member</Button>
          </div>
          <Paragraph type="secondary">
            The support bot uses this list to decide who is a dev (silent handoff, @dev nudges) and to map a
            Slack user to their ClickUp account when assigning tickets. The ClickUp email must match the
            person&apos;s ClickUp login for &quot;Assign to me&quot; to work.
          </Paragraph>

          <Table dataSource={members} columns={columns} rowKey="id" loading={loading} pagination={{ pageSize: 20 }} />

          <Modal
            title={editing ? 'Edit Member' : 'Add Member'}
            open={modalVisible}
            onOk={handleSave}
            onCancel={() => setModalVisible(false)}
            okText="Save"
          >
            <Form form={form} layout="vertical">
              <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
                <Input placeholder="e.g. Cameron Almazan" />
              </Form.Item>
              <Form.Item name="slack_id" label="Slack User ID" rules={[{ required: true, message: 'Slack ID is required' }]}>
                <Input placeholder="U0XXXXXXX" />
              </Form.Item>
              <Form.Item name="clickup_email" label="ClickUp Email">
                <Input placeholder="name@viscapmedia.com" />
              </Form.Item>
              <Form.Item name="active" label="Active" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Form>
          </Modal>
        </div>
      </Content>
    </Layout>
  )
}
