import { useState, useEffect, useCallback } from 'react';
import {
  Typography, Table, Button, Space, Tag, Modal, Form, Input, Select,
  Switch, message, Popconfirm, Tabs, Descriptions, List, Spin, Card, Alert,
} from 'antd';
import {
  PlusOutlined, ImportOutlined, EditOutlined,
  DeleteOutlined, PoweroffOutlined, ReloadOutlined,
  DownloadOutlined, GithubOutlined, SearchOutlined,
  FolderOpenOutlined, AppstoreOutlined,
} from '@ant-design/icons';
import { resourceApi, type DiscoveredResource } from '../api/resources';
import type { Resource, ResourceType } from '../types';

const TYPE_COLORS: Record<ResourceType, string> = {
  skill: 'blue',
  agent: 'purple',
  mcp: 'green',
};

const TYPE_LABELS: Record<ResourceType, string> = {
  skill: 'Skill',
  agent: 'Agent',
  mcp: 'MCP',
};

const SOURCE_LABELS: Record<string, string> = {
  builtin: '内置',
  'claude-code': 'Claude Code',
  manual: '手动',
  import: '导入',
  git: 'Git',
};

export default function ResourceManager() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [editResource, setEditResource] = useState<Resource | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importTab, setImportTab] = useState<string>('claude-code');
  const [scanning, setScanning] = useState(false);
  const [scanData, setScanData] = useState<{ skills: DiscoveredResource[]; mcps: DiscoveredResource[] } | null>(null);
  const [marketData, setMarketData] = useState<DiscoveredResource[] | null>(null);
  const [gitUrl, setGitUrl] = useState('');
  const [gitFetching, setGitFetching] = useState(false);
  const [gitResult, setGitResult] = useState<DiscoveredResource | null>(null);
  const [dirPath, setDirPath] = useState('');
  const [dirScanning, setDirScanning] = useState(false);
  const [dirResults, setDirResults] = useState<DiscoveredResource[] | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const type = activeTab !== 'all' ? (activeTab as ResourceType) : undefined;
      const data = await resourceApi.list(type);
      setResources(data);
    } catch {
      message.error('加载资源列表失败');
    } finally {
      setLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      const payload = {
        ...values,
        config: typeof values.config === 'string' ? JSON.parse(values.config) : values.config,
      };
      await resourceApi.create(payload);
      message.success('资源创建成功');
      setCreateOpen(false);
      form.resetFields();
      load();
    } catch (err) {
      if ((err as any)?.errorFields) return; // form validation
      message.error('创建失败: ' + (err as Error).message);
    }
  };

  const handleUpdate = async () => {
    if (!editResource) return;
    try {
      const values = await form.validateFields();
      const payload: Record<string, unknown> = { ...values };
      if (typeof payload.config === 'string') {
        payload.config = JSON.parse(payload.config as string);
      }
      await resourceApi.update(editResource.id, payload);
      message.success('资源更新成功');
      setEditResource(null);
      form.resetFields();
      load();
    } catch (err) {
      if ((err as any)?.errorFields) return;
      message.error('更新失败: ' + (err as Error).message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await resourceApi.delete(id);
      message.success('已删除');
      load();
    } catch {
      message.error('删除失败');
    }
  };

  const handleToggle = async (id: string) => {
    try {
      const updated = await resourceApi.toggle(id);
      message.success(updated.enabled ? '已启用' : '已禁用');
      load();
    } catch {
      message.error('操作失败');
    }
  };

  const openEdit = (resource: Resource) => {
    setEditResource(resource);
    form.setFieldsValue({
      name: resource.name,
      description: resource.description,
      version: resource.version,
      type: resource.type,
      source: resource.source,
      config: JSON.stringify(resource.config, null, 2),
    });
  };

  const openCreate = () => {
    setCreateOpen(true);
    form.resetFields();
  };

  // ---- Import handlers ----

  const openImport = () => {
    setImportOpen(true);
    setImportTab('claude-code');
    setScanData(null);
    setMarketData(null);
    setGitUrl('');
    setGitResult(null);
    setDirPath('');
    setDirResults(null);
  };

  const handleScanClaudeCode = async () => {
    setScanning(true);
    try {
      const data = await resourceApi.scanClaudeCode();
      setScanData(data);
    } catch (err: any) {
      message.error('扫描失败: ' + (err.message || '未知错误'));
    } finally {
      setScanning(false);
    }
  };

  const handleLoadMarketplace = async () => {
    setScanning(true);
    try {
      const data = await resourceApi.getMarketplace();
      setMarketData(data);
    } catch (err: any) {
      message.error('加载 Marketplace 失败: ' + (err.message || '未知错误'));
    } finally {
      setScanning(false);
    }
  };

  const handleFetchGit = async () => {
    if (!gitUrl.trim()) return;
    setGitFetching(true);
    setGitResult(null);
    try {
      const data = await resourceApi.fetchGit(gitUrl.trim());
      setGitResult(data);
    } catch (err: any) {
      message.error('获取失败: ' + (err.message || '未知错误'));
    } finally {
      setGitFetching(false);
    }
  };

  const handleScanDirectory = async () => {
    if (!dirPath.trim()) return;
    setDirScanning(true);
    setDirResults(null);
    try {
      const data = await resourceApi.scanDirectory(dirPath.trim());
      setDirResults(data);
      if (data.length === 0) {
        message.info('该目录中未发现资源文件');
      }
    } catch (err: any) {
      message.error('扫描失败: ' + (err.message || '未知错误'));
    } finally {
      setDirScanning(false);
    }
  };

  const handleImportResource = async (item: DiscoveredResource) => {
    setImporting(item.name);
    try {
      await resourceApi.importResource({
        name: item.name,
        type: item.type,
        description: item.description,
        version: item.version,
        source: item.source,
        sourcePath: item.sourcePath,
        config: item.config,
      });
      message.success(`已导入: ${item.name}`);
      // Update local data to mark as imported
      if (scanData) {
        setScanData({
          skills: scanData.skills.map(s => s.name === item.name ? { ...s, alreadyImported: true } : s),
          mcps: scanData.mcps.map(m => m.name === item.name ? { ...m, alreadyImported: true } : m),
        });
      }
      if (marketData) {
        setMarketData(marketData.map(p => p.name === item.name ? { ...p, alreadyImported: true } : p));
      }
      if (gitResult && gitResult.name === item.name) {
        setGitResult({ ...gitResult, alreadyImported: true });
      }
      load(); // Refresh main list
    } catch (err: any) {
      message.error('导入失败: ' + (err.message || '未知错误'));
    } finally {
      setImporting(null);
    }
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: Resource) => (
        <Space>
          <Tag color={TYPE_COLORS[record.type]}>{TYPE_LABELS[record.type]}</Tag>
          {name}
          {!record.enabled && <Tag color="default">已禁用</Tag>}
        </Space>
      ),
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 100,
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 100,
      render: (s: string) => SOURCE_LABELS[s] || s,
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      ellipsis: true,
    },
    {
      title: '操作',
      key: 'actions',
      width: 240,
      render: (_: unknown, record: Resource) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Button
            size="small"
            icon={<PoweroffOutlined />}
            onClick={() => handleToggle(record.id)}
            danger={record.enabled}
          >
            {record.enabled ? '禁用' : '启用'}
          </Button>
          <Popconfirm title="确认删除此资源?" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const tabItems = [
    { key: 'all', label: '全部' },
    { key: 'skill', label: 'Skills' },
    { key: 'agent', label: 'Agents' },
    { key: 'mcp', label: 'MCPs' },
  ];

  const configPreview = (resource: Resource) => {
    const { config } = resource;
    if (resource.type === 'skill') {
      const c = config as any;
      return `Prompt: ${c.prompt?.substring(0, 100)}...`;
    }
    if (resource.type === 'agent') {
      const c = config as any;
      return `SystemPrompt: ${c.systemPrompt?.substring(0, 100)}... | Model: ${c.model || 'default'}`;
    }
    const c = config as any;
    return `Command: ${c.command || c.url || 'N/A'}`;
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>资源管理</Typography.Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button icon={<ImportOutlined />} onClick={openImport}>导入</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建资源
          </Button>
        </Space>
      </div>

      <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />

      <Table
        dataSource={resources}
        columns={columns}
        rowKey="id"
        loading={loading}
        expandable={{
          expandedRowRender: (record: Resource) => (
            <Descriptions size="small" column={2}>
              <Descriptions.Item label="ID">{record.id}</Descriptions.Item>
              <Descriptions.Item label="来源">{SOURCE_LABELS[record.source]}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{record.createdAt}</Descriptions.Item>
              <Descriptions.Item label="更新时间">{record.updatedAt}</Descriptions.Item>
              <Descriptions.Item label="配置" span={2}>
                <Typography.Text code>{configPreview(record)}</Typography.Text>
              </Descriptions.Item>
            </Descriptions>
          ),
        }}
      />

      {/* Create Modal */}
      <Modal
        title="新建资源"
        open={createOpen}
        onOk={handleCreate}
        onCancel={() => { setCreateOpen(false); form.resetFields(); }}
        width={640}
      >
        <ResourceForm form={form} />
      </Modal>

      {/* Edit Modal */}
      <Modal
        title="编辑资源"
        open={!!editResource}
        onOk={handleUpdate}
        onCancel={() => { setEditResource(null); form.resetFields(); }}
        width={640}
      >
        <ResourceForm form={form} isEdit />
      </Modal>

      {/* Import Modal */}
      <Modal
        title={<Space><ImportOutlined /> 导入资源</Space>}
        open={importOpen}
        onCancel={() => { setImportOpen(false); setScanData(null); setMarketData(null); setGitResult(null); }}
        footer={null}
        width={720}
      >
        <Tabs
          activeKey={importTab}
          onChange={(key) => {
            setImportTab(key);
            if (key === 'claude-code' && !scanData) handleScanClaudeCode();
            if (key === 'marketplace' && !marketData) handleLoadMarketplace();
          }}
          items={[
            {
              key: 'claude-code',
              label: <span><FolderOpenOutlined /> Claude Code 本地</span>,
              children: (
                <div>
                  <Typography.Paragraph type="secondary">
                    扫描本地 ~/.claude/ 目录，发现已安装的 Skills 和 MCP 服务。
                  </Typography.Paragraph>
                  {scanning ? (
                    <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="扫描中..." /></div>
                  ) : scanData ? (
                    <div>
                      {scanData.skills.length === 0 && scanData.mcps.length === 0 ? (
                        <Alert message="未发现任何资源" description="~/.claude/skills/ 和 MCP 配置中未找到可用资源。" type="info" showIcon />
                      ) : (
                        <>
                          {scanData.skills.length > 0 && (
                            <Card title={<span>🧠 Skills ({scanData.skills.length})</span>} size="small" style={{ marginBottom: 12 }}>
                              <List size="small" dataSource={scanData.skills} renderItem={(item: DiscoveredResource) => (
                                <List.Item actions={[
                                  item.alreadyImported
                                    ? <Tag color="green">已导入</Tag>
                                    : <Button size="small" type="primary" icon={<DownloadOutlined />}
                                        loading={importing === item.name}
                                        onClick={() => handleImportResource(item)}>
                                        导入
                                      </Button>,
                                ]}>
                                  <List.Item.Meta
                                    title={item.name}
                                    description={item.description?.substring(0, 120)}
                                  />
                                </List.Item>
                              )} />
                            </Card>
                          )}
                          {scanData.mcps.length > 0 && (
                            <Card title={<span>🔌 MCP 服务 ({scanData.mcps.length})</span>} size="small">
                              <List size="small" dataSource={scanData.mcps} renderItem={(item: DiscoveredResource) => (
                                <List.Item actions={[
                                  item.alreadyImported
                                    ? <Tag color="green">已导入</Tag>
                                    : <Button size="small" type="primary" icon={<DownloadOutlined />}
                                        loading={importing === item.name}
                                        onClick={() => handleImportResource(item)}>
                                        导入
                                      </Button>,
                                ]}>
                                  <List.Item.Meta
                                    title={item.name}
                                    description={item.description?.substring(0, 120)}
                                  />
                                </List.Item>
                              )} />
                            </Card>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Button type="primary" icon={<SearchOutlined />} onClick={handleScanClaudeCode} loading={scanning}>
                        开始扫描
                      </Button>
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'marketplace',
              label: <span><AppstoreOutlined /> Marketplace</span>,
              children: (
                <div>
                  <Typography.Paragraph type="secondary">
                    浏览本地已同步的官方 Marketplace 插件（claude-plugins-official）。
                  </Typography.Paragraph>
                  {scanning ? (
                    <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="加载中..." /></div>
                  ) : marketData ? (
                    marketData.length === 0 ? (
                      <Alert message="Marketplace 为空" description="本地未找到 Marketplace 插件。请先运行 claude plugins sync 同步官方仓库。" type="info" showIcon />
                    ) : (
                      <List size="small" dataSource={marketData} renderItem={(item: DiscoveredResource) => (
                        <List.Item actions={[
                          item.alreadyImported
                            ? <Tag color="green">已导入</Tag>
                            : <Button size="small" type="primary" icon={<DownloadOutlined />}
                                loading={importing === item.name}
                                onClick={() => handleImportResource(item)}>
                                导入
                              </Button>,
                        ]}>
                          <List.Item.Meta
                            title={<Space>
                              <Tag color={item.type === 'skill' ? 'blue' : item.type === 'agent' ? 'purple' : 'green'}>
                                {item.type}
                              </Tag>
                              {item.name}
                            </Space>}
                            description={item.description?.substring(0, 120)}
                          />
                        </List.Item>
                      )} />
                    )
                  ) : (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Button type="primary" icon={<SearchOutlined />} onClick={handleLoadMarketplace} loading={scanning}>
                        加载 Marketplace
                      </Button>
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'local',
              label: <span><FolderOpenOutlined /> 本地目录</span>,
              children: (
                <div>
                  <Typography.Paragraph type="secondary">
                    输入本地目录路径，自动发现已安装的 Skill 和 MCP 插件（识别 SKILL.md、.claude-plugin/plugin.json、.mcp.json）。
                  </Typography.Paragraph>
                  <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
                    <Input
                      placeholder="如: d:/projects/my-skills 或 .pipeline/resources/skills"
                      value={dirPath}
                      onChange={e => setDirPath(e.target.value)}
                      onPressEnter={handleScanDirectory}
                    />
                    <Button type="primary" icon={<SearchOutlined />} onClick={handleScanDirectory} loading={dirScanning}>
                      扫描
                    </Button>
                  </Space.Compact>

                  {dirScanning && <div style={{ textAlign: 'center', padding: 20 }}><Spin tip="扫描中..." /></div>}

                  {dirResults && dirResults.length > 0 && (
                    <List size="small" dataSource={dirResults} renderItem={(item: DiscoveredResource) => (
                      <List.Item actions={[
                        item.alreadyImported
                          ? <Tag color="green">已导入</Tag>
                          : <Button size="small" type="primary" icon={<DownloadOutlined />}
                              loading={importing === item.name}
                              onClick={() => handleImportResource(item)}>
                              导入
                            </Button>,
                      ]}>
                        <List.Item.Meta
                          title={<Space>
                            <Tag color={item.type === 'skill' ? 'blue' : item.type === 'agent' ? 'purple' : 'green'}>
                              {item.type}
                            </Tag>
                            {item.name}
                          </Space>}
                          description={<Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            {item.sourcePath}
                          </Typography.Text>}
                        />
                      </List.Item>
                    )} />
                  )}

                  {!dirScanning && dirResults !== null && dirResults.length === 0 && (
                    <Alert message="未发现资源文件" description="该目录中没有有效的 .yaml / .yml / .json 资源定义文件。" type="info" showIcon />
                  )}

                  {!dirScanning && dirResults === null && (
                    <Alert message="输入目录路径并点击扫描" description="支持扫描目录中的 YAML/JSON 格式资源文件，文件需包含 name、type、config 等字段。" type="info" showIcon />
                  )}
                </div>
              ),
            },
            {
              key: 'git',
              label: <span><GithubOutlined /> Git / URL</span>,
              children: (
                <div>
                  <Typography.Paragraph type="secondary">
                    输入 GitHub 仓库地址（如 anthropics/claude-plugins-official），搜索并导入插件。
                  </Typography.Paragraph>
                  <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
                    <Input
                      placeholder="https://github.com/owner/repo 或 owner/repo"
                      value={gitUrl}
                      onChange={e => setGitUrl(e.target.value)}
                      onPressEnter={handleFetchGit}
                    />
                    <Button type="primary" icon={<SearchOutlined />} onClick={handleFetchGit} loading={gitFetching}>
                      搜索
                    </Button>
                  </Space.Compact>

                  {gitFetching && <div style={{ textAlign: 'center', padding: 20 }}><Spin tip="获取中..." /></div>}

                  {gitResult && (
                    <Card size="small" title={gitResult.name}
                      extra={gitResult.alreadyImported
                        ? <Tag color="green">已导入</Tag>
                        : <Button type="primary" size="small" icon={<DownloadOutlined />}
                            loading={importing === gitResult.name}
                            onClick={() => handleImportResource(gitResult)}>
                            导入
                          </Button>
                      }
                    >
                      <Descriptions size="small" column={1}>
                        <Descriptions.Item label="类型">
                          <Tag color={gitResult.type === 'skill' ? 'blue' : gitResult.type === 'agent' ? 'purple' : 'green'}>
                            {gitResult.type}
                          </Tag>
                        </Descriptions.Item>
                        <Descriptions.Item label="描述">{gitResult.description}</Descriptions.Item>
                        <Descriptions.Item label="来源">{gitResult.sourcePath}</Descriptions.Item>
                      </Descriptions>
                    </Card>
                  )}

                  {!gitFetching && !gitResult && (
                    <Alert message="输入 GitHub URL 搜索插件" description='支持格式: https://github.com/owner/repo 或 owner/repo (需包含 .claude-plugin/plugin.json)' type="info" showIcon />
                  )}
                </div>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
}

const DEFAULT_CONFIGS: Record<ResourceType, Record<string, unknown>> = {
  skill: { prompt: '请描述此 Skill 的行为...', tools: [] },
  agent: { systemPrompt: '请定义 Agent 的系统提示词...', tools: [] },
  mcp: { command: 'npx', args: [] },
};

function ResourceForm({ form, isEdit = false }: { form: any; isEdit?: boolean }) {
  const [resType, setResType] = useState<ResourceType>(
    form.getFieldValue('type') || 'skill'
  );
  const [resSource, setResSource] = useState<string>(
    form.getFieldValue('source') || 'manual'
  );
  const [fileLoading, setFileLoading] = useState(false);

  const handleFileImport = async (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileLoading(true);
    try {
      const text = await file.text();
      let parsed: Record<string, unknown>;

      // Try JSON first, then YAML
      if (file.name.endsWith('.json')) {
        parsed = JSON.parse(text);
      } else {
        // YAML files (.yaml, .yml) or treat as YAML by default
        const yaml = await import('js-yaml');
        parsed = (yaml as any).load(text) as Record<string, unknown>;
      }

      // Populate form fields from parsed data
      if (parsed.type) {
        setResType(parsed.type as ResourceType);
        form.setFieldValue('type', parsed.type);
        if (!isEdit) {
          const defaultConfig = DEFAULT_CONFIGS[parsed.type as ResourceType] || DEFAULT_CONFIGS.skill;
          form.setFieldValue('config', JSON.stringify(parsed.config || defaultConfig, null, 2));
        }
      }
      if (parsed.name) form.setFieldValue('name', parsed.name);
      if (parsed.description) form.setFieldValue('description', parsed.description);
      if (parsed.version) form.setFieldValue('version', parsed.version);
      if (parsed.config) form.setFieldValue('config', JSON.stringify(parsed.config, null, 2));

      message.success(`已加载文件: ${file.name}`);
    } catch (err: any) {
      message.error('文件解析失败: ' + (err.message || '未知错误'));
    } finally {
      setFileLoading(false);
      // Reset the input so the same file can be re-selected
      e.target.value = '';
    }
  };

  return (
    <Form form={form} layout="vertical">
      <Form.Item name="type" label="类型" rules={[{ required: true }]} initialValue="skill">
        <Select onChange={(v) => {
          setResType(v);
          // Set default config if creating new
          if (!isEdit) {
            const defaultConfig = DEFAULT_CONFIGS[v as ResourceType] || DEFAULT_CONFIGS.skill;
            form.setFieldValue('config', JSON.stringify(defaultConfig, null, 2));
          }
        }} disabled={isEdit}>
          <Select.Option value="skill">Skill — 可复用能力模块</Select.Option>
          <Select.Option value="agent">Agent — Claude 实例配置</Select.Option>
          <Select.Option value="mcp">MCP — 外部工具连接器</Select.Option>
        </Select>
      </Form.Item>
      <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
        <Input placeholder="如: code-review-expert" />
      </Form.Item>
      <Form.Item name="description" label="描述">
        <Input.TextArea rows={2} placeholder="简要描述资源用途" />
      </Form.Item>
      <Form.Item name="version" label="版本" initialValue="1.0.0">
        <Input placeholder="1.0.0" />
      </Form.Item>
      <Form.Item name="source" label="来源" initialValue="manual">
        <Select onChange={(v) => setResSource(v)} disabled={isEdit}>
          <Select.Option value="manual">手动创建</Select.Option>
          <Select.Option value="claude-code">从 Claude Code 导入</Select.Option>
          <Select.Option value="import">从文件导入</Select.Option>
        </Select>
      </Form.Item>

      {/* File picker: only shown when source is "import" */}
      {resSource === 'import' && (
        <Form.Item label="选择文件">
          <Space direction="vertical" style={{ width: '100%' }}>
            <input
              type="file"
              accept=".yaml,.yml,.json"
              onChange={handleFileImport}
              disabled={fileLoading}
              style={{
                display: 'block',
                width: '100%',
                padding: '4px 8px',
                background: '#1f1f1f',
                border: '1px dashed #434343',
                borderRadius: 6,
                color: '#d9d9d9',
                cursor: 'pointer',
              }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              支持 .yaml / .yml / .json 格式，文件需包含 name、type、config 等字段
            </Typography.Text>
          </Space>
        </Form.Item>
      )}

      {/* Type-specific hint */}
      <Typography.Paragraph type="secondary">
        {resType === 'skill' && 'Skill 需要配置 prompt 字段，定义其行为描述。'}
        {resType === 'agent' && 'Agent 需要配置 systemPrompt 字段，定义系统提示词。'}
        {resType === 'mcp' && 'MCP 需要配置 command 或 url 字段，定义连接方式。'}
      </Typography.Paragraph>

      <Form.Item
        name="config"
        label="配置 (JSON)"
        rules={[
          { required: true, message: '请输入配置' },
          {
            validator: async (_: any, value: string) => {
              if (!value) return;
              try { JSON.parse(value); } catch { throw new Error('无效的 JSON 格式'); }
            },
          },
        ]}
        initialValue={JSON.stringify(DEFAULT_CONFIGS.skill, null, 2)}
      >
        <Input.TextArea rows={8} placeholder='{"prompt": "...", "tools": [...]}' style={{ fontFamily: 'monospace' }} />
      </Form.Item>
    </Form>
  );
}
