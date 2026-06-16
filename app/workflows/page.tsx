'use client'
import { useEffect, useState } from 'react'
import { Layout, Typography, Table, Button, Modal, Form, Input, Switch, Space, message, Popconfirm, Tag } from 'antd'
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons'
import { apiFetch } from '@/lib/fetch'

const { Content } = Layout
const { Title } = Typography

const errMsg = (error: unknown) => (error instanceof Error ? error.message : String(error))

interface Workflow {
  id: string
  name: string
  description: string | null
  sop_impacted: boolean
  education_impacted: boolean
  scribehow_impacted: boolean
  is_deprecated: boolean
  created_at: string
  updated_at: string
}

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [loading, setLoading] = useState(true)
  const [modalVisible, setModalVisible] = useState(false)
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(null)
  const [form] = Form.useForm()

  const loadWorkflows = async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/workflows')
      const data = await res.json()
      setWorkflows(data.workflows)
    } catch (error) {
      message.error(`Failed to load workflows: ${errMsg(error)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadWorkflows()
  }, [])

  const handleCreate = () => {
    setEditingWorkflow(null)
    form.resetFields()
    setModalVisible(true)
  }

  const handleEdit = (workflow: Workflow) => {
    setEditingWorkflow(workflow)
    form.setFieldsValue(workflow)
    setModalVisible(true)
  }

  const handleSave = async () => {
    try {
      const values = await form.validateFields()

      if (editingWorkflow) {
        // Update
        await apiFetch(`/api/workflows/${editingWorkflow.id}`, {
          method: 'PUT',
          body: JSON.stringify(values)
        })
        message.success('Workflow updated successfully')
      } else {
        // Create
        await apiFetch('/api/workflows', {
          method: 'POST',
          body: JSON.stringify(values)
        })
        message.success('Workflow created successfully')
      }

      setModalVisible(false)
      loadWorkflows()
    } catch (error) {
      message.error(`Failed to save workflow: ${errMsg(error)}`)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/api/workflows/${id}`, {
        method: 'DELETE'
      })
      message.success('Workflow deleted successfully')
      loadWorkflows()
    } catch (error) {
      message.error(`Failed to delete workflow: ${errMsg(error)}`)
    }
  }

  const handleToggleDeprecated = async (workflow: Workflow) => {
    try {
      await apiFetch(`/api/workflows/${workflow.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_deprecated: !workflow.is_deprecated })
      })
      message.success(workflow.is_deprecated ? 'Workflow reactivated' : 'Workflow deprecated')
      loadWorkflows()
    } catch (error) {
      message.error(`Failed to update workflow: ${errMsg(error)}`)
    }
  }

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: Workflow) => (
        <Space>
          {name}
          {record.is_deprecated && <Tag color="default">Deprecated</Tag>}
        </Space>
      )
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true
    },
    {
      title: 'Impacts',
      key: 'impacts',
      render: (_: unknown, record: Workflow) => (
        <Space size={4}>
          {record.sop_impacted && <Tag color="blue">SOP</Tag>}
          {record.education_impacted && <Tag color="purple">Education</Tag>}
          {record.scribehow_impacted && <Tag color="cyan">ScribeHow</Tag>}
        </Space>
      )
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, record: Workflow) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            Edit
          </Button>
          <Button
            size="small"
            onClick={() => handleToggleDeprecated(record)}
          >
            {record.is_deprecated ? 'Reactivate' : 'Deprecate'}
          </Button>
          <Popconfirm
            title="Are you sure you want to delete this workflow?"
            onConfirm={() => handleDelete(record.id)}
            okText="Delete"
            okButtonProps={{ danger: true }}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Content style={{ padding: '24px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <Title level={2}>Workflow Registry</Title>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
              New Workflow
            </Button>
          </div>

          <Table
            dataSource={workflows}
            columns={columns}
            rowKey="id"
            loading={loading}
            pagination={{ pageSize: 20 }}
          />

          <Modal
            title={editingWorkflow ? 'Edit Workflow' : 'New Workflow'}
            open={modalVisible}
            onOk={handleSave}
            onCancel={() => setModalVisible(false)}
            okText="Save"
          >
            <Form form={form} layout="vertical">
              <Form.Item
                name="name"
                label="Workflow Name"
                rules={[{ required: true, message: 'Please enter a workflow name' }]}
              >
                <Input placeholder="e.g. Creative Version History Management" />
              </Form.Item>

              <Form.Item name="description" label="Description">
                <Input.TextArea rows={3} placeholder="Describe what this workflow does..." />
              </Form.Item>

              <Form.Item name="sop_impacted" label="SOP Impacted" valuePropName="checked">
                <Switch />
              </Form.Item>

              <Form.Item name="education_impacted" label="Education Impacted" valuePropName="checked">
                <Switch />
              </Form.Item>

              <Form.Item name="scribehow_impacted" label="ScribeHow Impacted" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Form>
          </Modal>
        </div>
      </Content>
    </Layout>
  )
}
