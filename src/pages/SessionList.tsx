import { useState, useEffect, useCallback } from 'react';
import { Typography, Table, Button, Space, Tag, message, Popconfirm } from 'antd';
import { PlusOutlined, PlayCircleOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { sessionApi } from '../api/sessions';
import type { Session, SessionStatus } from '../types';
import { BUILTIN_CHAT_PIPELINE_ID } from '../types';

const STATUS_COLORS: Record<SessionStatus, string> = {
  idle: 'default', precheck: 'processing', running: 'processing',
  waiting_confirm: 'warning', paused: 'warning',
  error: 'error', completed: 'success', cancelled: 'default',
};
const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: '等待中', precheck: '预检中', running: '执行中',
  waiting_confirm: '等待确认', paused: '已暂停',
  error: '异常', completed: '已完成', cancelled: '已取消',
};

export default function SessionList() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try { setSessions((await sessionApi.list()).filter(s => s.pipelineId !== BUILTIN_CHAT_PIPELINE_ID)); } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCancel = async (id: string) => {
    await sessionApi.cancel(id); message.success('已取消'); load();
  };

  const handleDelete = async (id: string) => {
    try {
      await sessionApi.delete(id);
      message.success('已删除（项目文件未受影响）');
    } catch (err: any) {
      message.error(err.message || '删除失败');
    }
    load();
  };

  const columns = [
    { title: '名称', dataIndex: 'name', key: 'name',
      render: (n: string, r: Session) => <a onClick={() => navigate(`/sessions/${r.id}`)}>{n}</a> },
    { title: '流水线', key: 'pipeline', render: (_: unknown, r: Session) => r.pipelineSnapshot.name },
    { title: '状态', dataIndex: 'status', key: 'status', width: 100,
      render: (s: SessionStatus) => <Tag color={STATUS_COLORS[s]}>{STATUS_LABELS[s]}</Tag> },
    { title: '步骤', key: 'steps', width: 100,
      render: (_: unknown, r: Session) => `${r.currentStepIndex}/${r.steps.length}` },
    { title: '更新时间', dataIndex: 'updatedAt', key: 'time', width: 160,
      render: (t: string) => new Date(t).toLocaleString() },
    { title: '操作', key: 'actions', width: 220,
      render: (_: unknown, r: Session) => (
        <Space>
          <Button size="small" onClick={() => navigate(`/sessions/${r.id}`)}>查看</Button>
          {['idle', 'running', 'paused'].includes(r.status) && (
            <Popconfirm title="取消会话?" onConfirm={() => handleCancel(r.id)}>
              <Button size="small" danger icon={<DeleteOutlined />}>取消</Button>
            </Popconfirm>
          )}
          <Popconfirm
            title="删除会话?"
            description="仅删除会话记录（消息、步骤、用量），不影响项目文件。"
            onConfirm={() => handleDelete(r.id)}
          >
            <Button size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>会话列表</Typography.Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/sessions/new')}>新建会话</Button>
        </Space>
      </div>
      <Table dataSource={sessions} columns={columns} rowKey="id" loading={loading} />
    </div>
  );
}
