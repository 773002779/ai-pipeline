import { useState, useEffect, useCallback } from 'react';
import {
  Typography, Card, Button, Space, Tag, Modal, Form, Input, Select,
  InputNumber, message, Empty, Popconfirm, Spin, Alert,
} from 'antd';
import {
  PlusOutlined, ApiOutlined, CheckCircleOutlined, ThunderboltOutlined,
  ImportOutlined, DeleteOutlined, EditOutlined,
} from '@ant-design/icons';
import { providerApi, type ProviderInput, type TestResult, type ContinueImportResult } from '../api/providers';
import type { LlmProvider, LlmProtocol } from '../types';

const PROTOCOL_OPTIONS = [
  { label: 'OpenAI 协议（DeepSeek/通义/GLM/one-api…）', value: 'openai' },
  { label: 'Anthropic 协议（官方 API/兼容端点）', value: 'anthropic' },
];

export default function ProviderManager() {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<LlmProvider | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProviders(await providerApi.list());
    } catch {
      message.error('加载供应商失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openEditor = (p?: LlmProvider) => {
    setEditing(p ?? null);
    form.setFieldsValue(p
      ? { name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, model: p.model, apiKey: '', temperature: p.temperature, maxTokens: p.maxTokens }
      : { protocol: 'openai' });
    setEditorOpen(true);
  };

  const handleSave = async () => {
    try {
      const values = (await form.validateFields()) as ProviderInput;
      if (editing) {
        await providerApi.update(editing.id, values);
        message.success('已保存');
      } else {
        await providerApi.create(values);
        message.success('已创建');
      }
      setEditorOpen(false);
      load();
    } catch (err: any) {
      if (err?.errorFields) return;
      message.error(err.message || '保存失败');
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const r: TestResult = await providerApi.test(id);
      if (r.ok) message.success(`连通正常 (${r.latencyMs}ms)`);
      else message.error(`连通失败: ${r.error}`);
    } catch (err: any) {
      message.error(err.message || '测试失败');
    } finally {
      setTestingId(null);
    }
  };

  const handleActivate = async (id: string) => {
    try {
      await providerApi.activate(id);
      message.success('已设为当前生效');
      load();
    } catch (err: any) {
      message.error(err.message || '激活失败');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await providerApi.remove(id);
      load();
    } catch (err: any) {
      message.error(err.message || '删除失败');
    }
  };

  const handleImport = async () => {
    try {
      const r: ContinueImportResult = await providerApi.importContinue(importPath.trim() || undefined);
      if (r.imported.length === 0 && r.skipped === 0) {
        message.warning(r.errors[0] || '没有可导入的模型');
      } else {
        message.success(`导入 ${r.imported.length} 个，跳过重复 ${r.skipped} 个`);
      }
      if (r.errors.length > 0) console.warn('[continue-import]', r.errors);
      setImportOpen(false);
      setImportPath('');
      load();
    } catch (err: any) {
      message.error(err.message || '导入失败');
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Space>
          <Typography.Title level={3} style={{ margin: 0 }}>模型配置</Typography.Title>
          <Typography.Text type="secondary">流水线执行时使用「当前生效」的供应商</Typography.Text>
        </Space>
        <Space>
          <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>从 Continue 导入</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor()}>新建供应商</Button>
        </Space>
      </div>

      {providers.length === 0 && !loading && (
        <Alert
          type="warning" showIcon
          message="还没有配置任何大模型供应商"
          description="流水线执行需要至少一个「当前生效」的供应商。点击右上角新建，或从 Continue 配置导入。"
        />
      )}

      {loading ? <Spin style={{ display: 'block', margin: '60px auto' }} /> : (
        providers.map(p => (
          <Card
            key={p.id} size="small" style={{ marginBottom: 12 }}
            title={(
              <Space>
                <span>{p.name}</span>
                <Tag color={p.protocol === 'openai' ? 'blue' : 'purple'}>
                  {p.protocol === 'openai' ? 'OpenAI 协议' : 'Anthropic 协议'}
                </Tag>
                {p.isActive && <Tag color="success" icon={<CheckCircleOutlined />}>当前生效</Tag>}
                {p.source === 'continue' && <Tag>来自 Continue</Tag>}
              </Space>
            )}
            extra={(
              <Space>
                <Button size="small" icon={<ThunderboltOutlined />} loading={testingId === p.id} onClick={() => handleTest(p.id)}>测试</Button>
                {!p.isActive && <Button size="small" type="primary" ghost onClick={() => handleActivate(p.id)}>设为生效</Button>}
                <Button size="small" icon={<EditOutlined />} onClick={() => openEditor(p)}>编辑</Button>
                <Popconfirm title="确定删除该供应商？" onConfirm={() => handleDelete(p.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            )}
          >
          <Space wrap>
            <Typography.Text type="secondary">BaseURL:</Typography.Text>
            <Typography.Text code>{p.baseUrl}</Typography.Text>
            <Typography.Text type="secondary">模型:</Typography.Text>
            <Typography.Text code>{p.model}</Typography.Text>
            <Typography.Text type="secondary">Key:</Typography.Text>
            <Typography.Text code>{p.apiKey}</Typography.Text>
          </Space>
          </Card>
        ))
      )}

      <Modal
        title={editing ? '编辑供应商' : '新建供应商'}
        open={editorOpen}
        onOk={handleSave}
        onCancel={() => setEditorOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：DeepSeek 官方" />
          </Form.Item>
          <Form.Item name="protocol" label="协议" rules={[{ required: true }]}>
            <Select options={PROTOCOL_OPTIONS} />
          </Form.Item>
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '如 https://api.deepseek.com' }]}>
            <Input placeholder="https://api.deepseek.com（不含 /v1 后缀路径）" />
          </Form.Item>
          <Form.Item
            name="apiKey" label="API Key"
            rules={editing ? [] : [{ required: true, message: '请输入 API Key' }]}
            extra={editing ? '留空表示不修改' : undefined}
          >
            <Input.Password placeholder={editing ? '留空不修改' : 'sk-...'} />
          </Form.Item>
          <Form.Item name="model" label="默认模型" rules={[{ required: true, message: '如 deepseek-chat' }]}>
            <Input placeholder="deepseek-chat" />
          </Form.Item>
          <Space>
            <Form.Item name="temperature" label="Temperature">
              <InputNumber min={0} max={2} step={0.1} placeholder="可选" />
            </Form.Item>
            <Form.Item name="maxTokens" label="Max Tokens">
              <InputNumber min={1} placeholder="可选" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="从 Continue.dev 导入"
        open={importOpen}
        onOk={handleImport}
        onCancel={() => setImportOpen(false)}
        okText="解析并导入"
      >
        <Typography.Paragraph type="secondary">
          读取 Continue 的 config.yaml（默认 %USERPROFILE%\.continue\config.yaml），将其中的 chat 模型导入为供应商。协议按 provider 字段自动推断。
        </Typography.Paragraph>
        <Input
          value={importPath}
          onChange={e => setImportPath(e.target.value)}
          placeholder="config.yaml 完整路径（留空使用默认位置）"
          prefix={<ApiOutlined />}
        />
      </Modal>
    </div>
  );
}
