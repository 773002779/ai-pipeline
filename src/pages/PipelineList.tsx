import { useState, useEffect, useCallback } from 'react';
import { Typography, Card, Row, Col, Button, Space, Tag, message, Popconfirm, Modal, Input } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, PlaySquareOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { pipelineApi } from '../api/pipelines';
import type { Pipeline } from '../types';

export default function PipelineList() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try { setPipelines(await pipelineApi.list()); } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!name.trim()) return message.warning('请输入名称');
    try {
      const created = await pipelineApi.create({ name: name.trim(), description: desc, steps: [] });
      message.success('创建成功');
      setCreateOpen(false); setName(''); setDesc('');
      navigate(`/pipelines/${created.id}/edit`);
    } catch (err: any) { message.error(err.message); }
  };

  const handleDelete = async (id: string) => {
    await pipelineApi.delete(id); message.success('已删除'); load();
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>流水线配置</Typography.Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>新建流水线</Button>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        {pipelines.map(p => (
          <Col key={p.id} xs={24} sm={12} lg={8}>
            <Card
              hoverable
              title={<Space><PlaySquareOutlined />{p.name}</Space>}
              extra={
                <Space>
                  <Button size="small" icon={<EditOutlined />} onClick={() => navigate(`/pipelines/${p.id}/edit`)}>编辑</Button>
                  <Popconfirm title="确认删除?" onConfirm={() => handleDelete(p.id)}>
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              }
              onClick={() => navigate(`/pipelines/${p.id}/edit`)}
            >
              <Typography.Paragraph ellipsis={{ rows: 2 }} type="secondary">
                {p.description || '无描述'}
              </Typography.Paragraph>
              <Space>
                <Tag>{p.steps.length} 个步骤</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{p.updatedAt}</Typography.Text>
              </Space>
            </Card>
          </Col>
        ))}
        {!loading && pipelines.length === 0 && (
          <Col span={24}><Typography.Text type="secondary">暂无流水线，点击"新建流水线"开始</Typography.Text></Col>
        )}
      </Row>

      <Modal title="新建流水线" open={createOpen} onOk={handleCreate}
        onCancel={() => { setCreateOpen(false); setName(''); setDesc(''); }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="流水线名称" value={name} onChange={e => setName(e.target.value)} />
          <Input.TextArea rows={3} placeholder="描述（可选）" value={desc} onChange={e => setDesc(e.target.value)} />
        </Space>
      </Modal>
    </div>
  );
}
