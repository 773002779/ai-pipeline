import { useState, useEffect, useCallback } from 'react';
import {
  Typography, Table, Button, Space, Tag, Modal, Form, Input, Select,
  Switch, message, Popconfirm, Descriptions,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { stepApi } from '../api/steps';
import { resourceApi } from '../api/resources';
import type { StepTemplate, Resource } from '../types';

const CATEGORIES = ['需求', '分析', '实现', '测试', '评审', '工具'];
const MODE_COLORS: Record<string, string> = { auto: 'green', 'confirm-each': 'orange', 'auto-with-review': 'blue' };
const MODE_LABELS: Record<string, string> = { auto: '自动', 'confirm-each': '需确认', 'auto-with-review': '自动+收集' };

export default function StepManager() {
  const [steps, setSteps] = useState<StepTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editStep, setEditStep] = useState<StepTemplate | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [stepData, resourceData] = await Promise.all([
        stepApi.list(),
        resourceApi.list(),
      ]);
      setSteps(stepData);
      setResources(resourceData);
    } catch {
      message.error('加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      await stepApi.create(values);
      message.success('步骤创建成功');
      setCreateOpen(false); form.resetFields(); load();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error('创建失败: ' + err.message);
    }
  };

  const handleUpdate = async () => {
    if (!editStep) return;
    try {
      const values = await form.validateFields();
      await stepApi.update(editStep.id, values);
      message.success('步骤更新成功');
      setEditStep(null); form.resetFields(); load();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error('更新失败: ' + err.message);
    }
  };

  const handleDelete = async (id: string) => {
    await stepApi.delete(id);
    message.success('已删除');
    load();
  };

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '类别', dataIndex: 'category', key: 'category', width: 80,
      render: (c: string) => <Tag>{c}</Tag> },
    { title: '交互模式', dataIndex: 'interactionMode', key: 'mode', width: 120,
      render: (m: string) => <Tag color={MODE_COLORS[m]}>{MODE_LABELS[m] || m}</Tag> },
    { title: '自动推进', dataIndex: 'autoAdvance', key: 'adv', width: 90,
      render: (v: boolean) => v ? <Tag color="green">是</Tag> : <Tag>否</Tag> },
    { title: '循环', dataIndex: 'loopEnabled', key: 'loop', width: 70,
      render: (v: boolean) => v ? <Tag color="purple">🔄</Tag> : <Tag>-</Tag> },
    { title: '资源引用', key: 'refs', width: 200,
      render: (_: unknown, r: StepTemplate) => (
        <Space size={4} wrap>
          {r.agentId && <Tag color="purple">🤖 Agent</Tag>}
          {(r.skillIds?.length ?? 0) > 0 && <Tag color="blue">📦 {r.skillIds!.length} Skills</Tag>}
          {(r.mcpServerIds?.length ?? 0) > 0 && <Tag color="green">🔌 {r.mcpServerIds!.length} MCPs</Tag>}
        </Space>
      ),
    },
    { title: '操作', key: 'actions', width: 180,
      render: (_: unknown, record: StepTemplate) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => {
            setEditStep(record);
            form.setFieldsValue(record);
          }}>编辑</Button>
          <Popconfirm title="确认删除?" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const resourceOptions = {
    agents: resources.filter(r => r.type === 'agent' && r.enabled),
    skills: resources.filter(r => r.type === 'skill' && r.enabled),
    mcps: resources.filter(r => r.type === 'mcp' && r.enabled),
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>步骤管理</Typography.Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => {
            setCreateOpen(true); form.resetFields();
          }}>新建步骤</Button>
        </Space>
      </div>

      <Table dataSource={steps} columns={columns} rowKey="id" loading={loading}
        expandable={{
          expandedRowRender: (r: StepTemplate) => (
            <Descriptions size="small" column={2}>
              <Descriptions.Item label="描述">{r.description || '-'}</Descriptions.Item>
              <Descriptions.Item label="System Prompt" span={2}>
                <Typography.Paragraph ellipsis={{ rows: 3, expandable: true }} code style={{ maxWidth: 600 }}>
                  {r.systemPrompt}
                </Typography.Paragraph>
              </Descriptions.Item>
              {r.agentId && <Descriptions.Item label="Agent">{r.agentId}</Descriptions.Item>}
              {r.loopEnabled && r.defaultLoopConfig && (
                <Descriptions.Item label="循环配置">
                  最多 {r.defaultLoopConfig.maxIterations} 次 / {r.defaultLoopConfig.terminationMode}
                </Descriptions.Item>
              )}
            </Descriptions>
          ),
        }}
      />

      {/* Create/Edit Modal */}
      <Modal
        title={editStep ? '编辑步骤' : '新建步骤'}
        open={createOpen || !!editStep}
        onOk={editStep ? handleUpdate : handleCreate}
        onCancel={() => { setCreateOpen(false); setEditStep(null); form.resetFields(); }}
        width={720}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="如: Java后端代码实现" />
          </Form.Item>
          <Form.Item name="category" label="类别" initialValue="工具">
            <Select options={CATEGORIES.map(c => ({ label: c, value: c }))} />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="systemPrompt" label="System Prompt" rules={[{ required: true, message: '必填' }]}>
            <Input.TextArea rows={6} placeholder="定义此步骤发给 Claude 的 system prompt..." />
          </Form.Item>
          <Space style={{ width: '100%' }} size="middle">
            <Form.Item name="interactionMode" label="交互模式" initialValue="auto">
              <Select style={{ width: 160 }}>
                <Select.Option value="auto">自动执行</Select.Option>
                <Select.Option value="confirm-each">每步确认</Select.Option>
                <Select.Option value="auto-with-review">自动+收集问题</Select.Option>
              </Select>
            </Form.Item>
            <Form.Item name="autoAdvance" label="自动推进" valuePropName="checked" initialValue={true}>
              <Switch />
            </Form.Item>
            <Form.Item name="loopEnabled" label="启用循环" valuePropName="checked" initialValue={false}>
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item name="agentId" label="Agent (可选)">
            <Select allowClear placeholder="不选则用默认 Claude">
              {resourceOptions.agents.map(a => (
                <Select.Option key={a.id} value={a.id}>{a.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="skillIds" label="Skills">
            <Select mode="multiple" allowClear placeholder="选择可调用的 Skills">
              {resourceOptions.skills.map(s => (
                <Select.Option key={s.id} value={s.id}>{s.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="mcpServerIds" label="MCP 服务">
            <Select mode="multiple" allowClear placeholder="选择连接的 MCP 服务">
              {resourceOptions.mcps.map(m => (
                <Select.Option key={m.id} value={m.id}>{m.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
