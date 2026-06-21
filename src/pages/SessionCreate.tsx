import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Typography, Card, Form, Input, Select, Button, Space, message, Steps, Row, Col, Tag, Divider,
} from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { pipelineApi } from '../api/pipelines';
import { sessionApi } from '../api/sessions';
import type { Pipeline } from '../types';

export default function SessionCreate() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  useEffect(() => {
    pipelineApi.list().then(setPipelines).catch(() => message.error('加载流水线失败'));
  }, []);

  const handleNext = async () => {
    try {
      await form.validateFields(['pipelineId', 'name', 'requirement']);
      const pipelineId = form.getFieldValue('pipelineId');
      const pipeline = pipelines.find(p => p.id === pipelineId);
      if (!pipeline) {
        message.warning('请选择有效的流水线');
        return;
      }
      setSelectedPipeline(pipeline);
      setStep(1);
    } catch (err: any) {
      // Show the first form validation error
      if (err.errorFields?.length > 0) {
        message.warning(err.errorFields[0].errors?.[0] || '请填写必填字段');
      }
    }
  };

  const handleCreate = async () => {
    // Use validateFields() to get ALL form values reliably (including nested Form.List)
    let values: Record<string, any>;
    try {
      values = await form.validateFields();
    } catch (err: any) {
      if (err.errorFields?.length > 0) {
        message.warning(err.errorFields[0].errors?.[0] || '请填写必填字段');
      }
      return;
    }

    console.log('[SessionCreate] form values:', JSON.stringify(values, null, 2));

    const pipelineId: string = values.pipelineId;
    const name: string = (values.name || '').trim();
    const requirement: string = (values.requirement || '').trim();

    // Validate workspaces: at least one entry with a non-empty path
    // Form.List may return entries with undefined or empty-string paths
    const rawWorkspaces: any[] = Array.isArray(values.workspaces) ? values.workspaces : [];
    console.log('[SessionCreate] rawWorkspaces:', JSON.stringify(rawWorkspaces));

    const validWorkspaces = rawWorkspaces.filter(w => {
      const p = typeof w?.path === 'string' ? w.path.trim() : '';
      console.log('[SessionCreate] checking workspace:', JSON.stringify(w), 'path="' + p + '"');
      return p.length > 0;
    });

    if (validWorkspaces.length === 0) {
      message.warning(`请至少填写一个有效的工作区路径（当前收到 ${rawWorkspaces.length} 个工作区，但路径均为空）`);
      return;
    }
    const workspaces = validWorkspaces.map(w => ({
      name: w.name?.trim() || w.path!.trim().split(/[/\\]/).filter(Boolean).pop() || 'workspace',
      path: w.path!.trim(),
      type: w.type || 'unknown',
    }));

    setLoading(true);
    try {
      const session = await sessionApi.create({ pipelineId, name, requirement, workspaces });
      message.success('会话创建成功');
      navigate(`/sessions/${session.id}`);
    } catch (err: any) {
      message.error(`创建失败: ${err.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/sessions')}>返回</Button>
        <Typography.Title level={3} style={{ margin: 0 }}>创建新会话</Typography.Title>
      </Space>

      <Steps current={step} items={[{ title: '配置信息' }, { title: '预览确认' }]} style={{ marginBottom: 24 }} />

      {/* Form ALWAYS mounted; step content uses display:none to preserve field values */}
      <Form form={form} layout="vertical" initialValues={{ workspaces: [] }}>
        <div style={{ display: step === 0 ? 'block' : 'none' }}>
          <Card>
            <Form.Item name="pipelineId" label="流水线模板" rules={[{ required: true, message: '请选择流水线' }]}>
              <Select placeholder="选择流水线模板" showSearch optionFilterProp="label"
                options={pipelines.map(p => ({ label: `${p.name} (${p.steps.length} 步骤)`, value: p.id }))}
                onChange={(id) => setSelectedPipeline(pipelines.find(p => p.id === id) || null)}
              />
            </Form.Item>
            <Form.Item name="name" label="会话名称" rules={[{ required: true, message: '请输入会话名称' }]}>
              <Input placeholder="如: 电商用户模块开发" />
            </Form.Item>

            <Form.Item name="requirement" label="需求描述 (流水线起点)" rules={[{ required: true, message: '请输入需求描述' }]}>
              <Input.TextArea rows={5} placeholder="描述你想要实现的功能，越详细越好..." />
            </Form.Item>

            <Divider>工作区</Divider>
            <Form.List name="workspaces">
              {(fields, { add, remove }) => (
                <>
                  {fields.length === 0 && (
                    <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
                      请添加至少一个工作区（代码目录路径）
                    </Typography.Text>
                  )}
                  {fields.map(({ key, name, ...rest }) => (
                    <Row gutter={8} key={key} style={{ marginBottom: 8 }}>
                      <Col span={6}>
                        <Form.Item {...rest} name={[name, 'name']} style={{ margin: 0 }}>
                          <Input placeholder="模块名 (可选)" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item {...rest} name={[name, 'path']} style={{ margin: 0 }}>
                          <Input placeholder="d:/projects/backend (必填)" />
                        </Form.Item>
                      </Col>
                      <Col span={4}>
                        <Form.Item {...rest} name={[name, 'type']} initialValue="backend" style={{ margin: 0 }}>
                          <Select options={[
                            { label: '🔙 后端', value: 'backend' }, { label: '🔜 前端', value: 'frontend' },
                            { label: '📦 全栈', value: 'fullstack' }, { label: '❓ 未知', value: 'unknown' },
                          ]} />
                        </Form.Item>
                      </Col>
                      <Col span={2}>
                        <Button danger size="small" onClick={() => remove(name)}>✕</Button>
                      </Col>
                    </Row>
                  ))}
                  <Button type="dashed" onClick={() => add({ name: '', path: '', type: 'backend' })} block>
                    + 添加工作区
                  </Button>
                </>
              )}
            </Form.List>

            <div style={{ marginTop: 24 }}>
              <Button type="primary" icon={<ArrowRightOutlined />} onClick={handleNext}>下一步: 预览</Button>
            </div>
          </Card>
        </div>

        {step === 1 && selectedPipeline && (
        <div>
        <Card title="流水线预览">
          <Space>
            <Tag color="blue">{selectedPipeline.name}</Tag>
            <Tag>{selectedPipeline.steps.length} 个步骤</Tag>
          </Space>
          <Divider />
          {selectedPipeline.steps.length === 0 ? (
            <Typography.Text type="secondary">此流水线暂无步骤，创建会话后可在编辑器中添加</Typography.Text>
          ) : (
            selectedPipeline.steps.map((s, i) => (
              <Card key={s.id} size="small" style={{ marginBottom: 8 }}>
                <Space>
                  <Tag>{i + 1}</Tag>
                  <Typography.Text strong>{s.templateId}</Typography.Text>
                  {s.condition && <Tag color="orange">条件: {s.condition}</Tag>}
                </Space>
              </Card>
            ))
          )}
          <Divider />
          <Space>
            <Button onClick={() => setStep(0)}>← 返回修改</Button>
            <Button type="primary" icon={<PlayCircleOutlined />} loading={loading} onClick={handleCreate}>
              创建会话
            </Button>
          </Space>
        </Card>
        </div>
        )}
      </Form>
    </div>
  );
}
