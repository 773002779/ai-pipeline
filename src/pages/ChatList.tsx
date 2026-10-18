import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Typography, Card, List, Button, Modal, Input, Popconfirm, message, Tag, Space, Empty } from 'antd';
import { PlusOutlined, DeleteOutlined, CommentOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { chatApi } from '../api/chat';
import type { Session } from '../types';

const STATUS_TAGS: Record<string, { color: string; label: string }> = {
  idle: { color: 'default', label: '待输入' },
  running: { color: 'processing', label: '生成中' },
  error: { color: 'error', label: '异常' },
};

export default function ChatList() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setSessions(await chatApi.list()); }
    catch { message.error('加载对话列表失败'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    const path = workspacePath.trim();
    if (!path) { message.warning('请填写工作目录'); return; }
    setCreating(true);
    try {
      const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '工作目录';
      const s = await chatApi.create({ workspaces: [{ name, path, type: 'unknown' }] });
      message.success('对话已创建');
      setModalOpen(false);
      setWorkspacePath('');
      navigate(`/chat/${s.id}`);
    } catch (err: any) {
      message.error(err.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await chatApi.remove(id);
      message.success('已删除');
      load();
    } catch (err: any) {
      message.error(err.message || '删除失败');
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>Claude 对话</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>新建对话</Button>
      </div>

      <Card>
        <List
          loading={loading}
          dataSource={sessions}
          locale={{ emptyText: <Empty description="还没有对话，点右上角新建一个" /> }}
          renderItem={(s) => {
            const st = STATUS_TAGS[s.status] || STATUS_TAGS.idle;
            return (
              <List.Item
                style={{ cursor: 'pointer' }}
                onClick={() => navigate(`/chat/${s.id}`)}
                actions={[
                  <Popconfirm key="del" title="删除该对话及其全部消息？" onConfirm={(e) => { e?.stopPropagation(); handleDelete(s.id); }} onCancel={(e) => e?.stopPropagation()}>
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                  </Popconfirm>,
                  <Button key="go" size="small" type="link" icon={<ArrowRightOutlined />} onClick={(e) => { e.stopPropagation(); navigate(`/chat/${s.id}`); }} />,
                ]}
              >
                <List.Item.Meta
                  avatar={<CommentOutlined style={{ fontSize: 20, marginTop: 4 }} />}
                  title={<Space><span>{s.name}</span><Tag color={st.color}>{st.label}</Tag></Space>}
                  description={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.workspaces[0]?.path}</Typography.Text>}
                />
              </List.Item>
            );
          }}
        />
      </Card>

      <Modal
        title="新建 Claude 对话"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleCreate}
        confirmLoading={creating}
        okText="创建"
      >
        <Input
          placeholder="工作目录绝对路径，如 D:\\develop\\workspace\\my-app"
          value={workspacePath}
          onChange={(e) => setWorkspacePath(e.target.value)}
          onPressEnter={handleCreate}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Claude 将在该目录内读写文件；模型可在对话页随时切换。
        </Typography.Text>
      </Modal>
    </div>
  );
}
