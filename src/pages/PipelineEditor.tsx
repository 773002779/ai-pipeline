import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Typography, Button, Space, Card, Select, Input, Form, Switch, InputNumber,
  message, Tag, Popconfirm, Empty, Divider, Row, Col,
} from 'antd';
import {
  ArrowUpOutlined, ArrowDownOutlined, DeleteOutlined,
  PlusOutlined, SaveOutlined, ArrowLeftOutlined,
} from '@ant-design/icons';
import { pipelineApi } from '../api/pipelines';
import { stepApi } from '../api/steps';
import type { Pipeline, PipelineStepConfig, StepTemplate } from '../types';

export default function PipelineEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<PipelineStepConfig[]>([]);
  const [availableSteps, setAvailableSteps] = useState<StepTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const templates = await stepApi.list();
      setAvailableSteps(templates);
      if (!isNew) {
        const p = await pipelineApi.get(id!);
        setPipeline(p);
        setName(p.name);
        setDescription(p.description || '');
        setSteps(p.steps || []);
      }
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  }, [id, isNew]);

  useEffect(() => { load(); }, [load]);

  const addStep = (templateId: string) => {
    const template = availableSteps.find(t => t.id === templateId);
    if (!template) return;
    const newStep: PipelineStepConfig = {
      id: `step-${Date.now()}`,
      templateId,
      order: steps.length + 1,
    };
    setSteps([...steps, newStep]);
  };

  const removeStep = (stepId: string) => {
    setSteps(steps.filter(s => s.id !== stepId).map((s, i) => ({ ...s, order: i + 1 })));
  };

  const moveStep = (index: number, direction: 'up' | 'down') => {
    const newSteps = [...steps];
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= newSteps.length) return;
    [newSteps[index], newSteps[target]] = [newSteps[target], newSteps[index]];
    setSteps(newSteps.map((s, i) => ({ ...s, order: i + 1 })));
  };

  const updateStepOverride = (stepId: string, key: string, value: unknown) => {
    setSteps(steps.map(s => {
      if (s.id !== stepId) return s;
      return { ...s, overrides: { ...s.overrides, [key]: value } };
    }));
  };

  const handleSave = async () => {
    if (!name.trim()) return message.warning('请输入名称');
    setSaving(true);
    try {
      const payload = { name: name.trim(), description, steps };
      if (isNew) {
        const created = await pipelineApi.create(payload);
        message.success('创建成功');
        navigate(`/pipelines/${created.id}/edit`, { replace: true });
      } else {
        await pipelineApi.update(id!, payload);
        message.success('保存成功');
      }
    } catch (err: any) { message.error(err.message); }
    finally { setSaving(false); }
  };

  const getTemplate = (templateId: string) => availableSteps.find(t => t.id === templateId);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/pipelines')}>返回</Button>
          <Typography.Title level={3} style={{ margin: 0 }}>{isNew ? '新建流水线' : `编辑: ${name}`}</Typography.Title>
        </Space>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>保存</Button>
      </div>

      <Row gutter={16}>
        <Col span={16}>
          <Card title="流水线基本信息" style={{ marginBottom: 16 }}>
            <Form layout="vertical">
              <Form.Item label="名称" required>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="如: Java后端开发模板" />
              </Form.Item>
              <Form.Item label="描述">
                <Input.TextArea value={description} onChange={e => setDescription(e.target.value)} rows={2} />
              </Form.Item>
            </Form>
          </Card>

          <Card
            title={`流水线步骤 (${steps.length})`}
            extra={
              <Select
                placeholder="+ 添加步骤"
                style={{ width: 220 }}
                value={undefined}
                onChange={addStep}
                showSearch
                optionFilterProp="label"
                options={availableSteps.map(s => ({
                  label: `${s.name} (${s.category})`,
                  value: s.id,
                }))}
              />
            }
          >
            {steps.length === 0 ? (
              <Empty description="从上方下拉框添加步骤" />
            ) : (
              <div>
                {steps.map((step, index) => {
                  const tmpl = getTemplate(step.templateId);
                  return (
                    <Card
                      key={step.id}
                      size="small"
                      style={{ marginBottom: 8 }}
                      title={
                        <Space>
                          <Tag>{index + 1}</Tag>
                          {tmpl?.name || step.templateId}
                          <Tag color="blue">{tmpl?.category}</Tag>
                          <Tag color={tmpl?.interactionMode === 'auto' ? 'green' : 'orange'}>
                            {tmpl?.interactionMode || 'auto'}
                          </Tag>
                        </Space>
                      }
                      extra={
                        <Space>
                          <Button size="small" icon={<ArrowUpOutlined />} disabled={index === 0}
                            onClick={() => moveStep(index, 'up')} />
                          <Button size="small" icon={<ArrowDownOutlined />} disabled={index === steps.length - 1}
                            onClick={() => moveStep(index, 'down')} />
                          <Popconfirm title="移除此步骤?" onConfirm={() => removeStep(step.id)}>
                            <Button size="small" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        </Space>
                      }
                    >
                      {tmpl && (
                        <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: 0 }}>
                          {tmpl.description}
                        </Typography.Paragraph>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </Card>
        </Col>

        <Col span={8}>
          <Card title="步骤详情" style={{ position: 'sticky', top: 24 }}>
            {steps.length > 0 ? (
              <Typography.Text type="secondary">点击左侧步骤查看详情和配置覆盖</Typography.Text>
            ) : (
              <Empty description="暂无步骤" />
            )}
            <Divider />
            <Space direction="vertical" style={{ width: '100%' }}>
              <Typography.Text strong>统计</Typography.Text>
              <Tag>{steps.length} 个步骤</Tag>
              <Tag color="green">{steps.length > 0 ? '~30-60分钟' : '-'}</Tag>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
