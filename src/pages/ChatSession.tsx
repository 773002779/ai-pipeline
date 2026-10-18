import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Typography, Card, Button, message, Badge, Tag, Space, AutoComplete, Mentions,
  Popconfirm, List, Empty,
} from 'antd';
import {
  SendOutlined, ArrowLeftOutlined, PlusOutlined, StopOutlined,
  CommentOutlined, DeleteOutlined,
} from '@ant-design/icons';
import { chatApi, fsApi } from '../api/chat';
import { sessionApi } from '../api/sessions';
import { providerApi } from '../api/providers';
import { resourceApi } from '../api/resources';
import { useLiveMessages } from '../hooks/useLiveMessages';
import ChatMessages from '../components/ChatMessages';
import PermissionModal from '../components/PermissionModal';
import type { Session, FsNode, Resource } from '../types';

/** 文件树扁平化为 @引用候选（相对路径，上限 2000） */
function flattenOptions(node: FsNode, root: string, out: { value: string }[] = []): { value: string }[] {
  if (out.length >= 2000) return out;
  const rel = node.path === root ? '' : node.path.slice(root.length + 1).replace(/\\/g, '/');
  if (node.type === 'file' && rel) out.push({ value: rel });
  for (const c of node.children || []) flattenOptions(c, root, out);
  return out;
}

export default function ChatSession() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [chatList, setChatList] = useState<Session[]>([]);
  const [input, setInput] = useState('');
  const [fileOptions, setFileOptions] = useState<{ value: string }[]>([]);
  const [modelOptions, setModelOptions] = useState<{ value: string }[]>([]);
  const [model, setModel] = useState<string>('');
  const [sending, setSending] = useState(false);
  const [skills, setSkills] = useState<Resource[]>([]);
  const [slashMode, setSlashMode] = useState(false);

  const { messages, setMessages, permissionRequest, setPermissionRequest, thinkingDoneRef, connected, on, send } = useLiveMessages(id);

  const running = session?.status === 'running';

  const loadSession = useCallback(async () => {
    if (!id) return;
    try {
      const s = await sessionApi.get(id);
      setSession(s);
      setModel(s.chatModel || '');
    } catch { message.error('加载对话失败'); }
  }, [id]);

  const loadMessages = useCallback(async () => {
    if (!id) return;
    try {
      const msgs = await sessionApi.getMessages(id);
      setMessages(msgs);
      thinkingDoneRef.current = new Set(
        msgs.filter(m => m.role === 'assistant' && m.thinking).map(m => m.id),
      );
    } catch { /* 忽略 */ }
  }, [id, setMessages, thinkingDoneRef]);

  const loadList = useCallback(async () => {
    try { setChatList(await chatApi.list()); } catch { /* 忽略 */ }
  }, []);

  useEffect(() => { loadSession(); loadList(); }, [loadSession, loadList]);

  // 进入页面拉取历史消息
  useEffect(() => { loadMessages(); }, [loadMessages]);

  // 工作目录文件树（@引用候选）+ 模型候选
  useEffect(() => {
    const root = session?.workspaces[0]?.path;
    if (root) {
      fsApi.tree(root).then(tree => setFileOptions(flattenOptions(tree, root)))
        .catch(() => setFileOptions([]));
    }
  }, [session?.workspaces]);

  useEffect(() => {
    providerApi.list().then(list => {
      const models = Array.from(new Set(list.map(p => p.model))).filter(Boolean);
      setModelOptions(models.map(m => ({ value: m })));
    }).catch(() => {});
  }, []);

  // skill 列表拉取一次（/ 命令候选）
  useEffect(() => {
    resourceApi.list('skill').then(list => setSkills(list.filter(s => s.enabled))).catch(() => {});
  }, []);

  // WS：状态变化 → 刷新会话与消息
  useEffect(() => {
    const unsubs = [
      on('status_change', (data) => {
        setSession(prev => (prev ? { ...prev, status: data.status } : prev));
        if (data.status !== 'running') { loadMessages(); loadList(); }
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [on, id, loadMessages, loadList]);

  const handleSend = async () => {
    const content = input.trim();
    if (!id || !content || running) return;
    const isCommand = content.startsWith('/');
    setSending(true);
    try {
      await chatApi.sendMessage(id, content);
      setInput('');
      if (isCommand) {
        // 内置命令服务端同步完成（/clear 已广播 idle；/compact no-op 无广播）——
        // 不做乐观 running，直接回读消息与会话状态
        await loadMessages();
        await loadSession();
      } else {
        // 乐观追加用户气泡：生成期间用户消息立即可见，
        // 并让 useLiveMessages 的追加逻辑为新回复开一个新助手气泡
        setMessages(prev => [...prev, {
          id: `user-${Date.now()}`, sessionId: id, role: 'user' as const,
          content, createdAt: new Date().toISOString(),
        }]);
        setSession(prev => prev ? { ...prev, status: 'running' } : prev);
      }
    } catch (err: any) {
      message.error(err.message || '发送失败');
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    if (!id) return;
    try { await chatApi.stop(id); } catch (err: any) { message.error(err.message || '停止失败'); }
  };

  const handleModelChange = (v: string) => {
    setModel(v);
    if (id) chatApi.setModel(id, v || undefined).catch(() => {});
  };

  const replyPermission = (action: 'approve' | 'deny' | 'whitelist') => {
    if (!permissionRequest) return;
    send({ type: 'permission_response', data: { reqId: permissionRequest.id, action } });
    setPermissionRequest(null);
  };

  const commandOptions = useMemo(() => [
    { value: 'clear', label: <div>🧹 <b>/clear</b> 清理上下文（重置模型记忆，保留聊天记录）</div> },
    { value: 'compact', label: <div>📦 <b>/compact</b> 压缩上下文（生成摘要后重新开始）</div> },
    ...skills.map(s => (
      { value: s.name, label: <div>⚡ <b>/{s.name}</b>{s.description ? ` ${s.description}` : ''}</div> }
    )),
  ], [skills]);

  const thinkingPendingIds = useMemo(
    () => new Set(messages.filter(m => m.role === 'assistant' && m.thinking && !thinkingDoneRef.current.has(m.id)).map(m => m.id)),
    [messages, thinkingDoneRef],
  );

  const sidebar = (
    <Card size="small" style={{ height: '100%' }} bodyStyle={{ padding: 8 }}>
      <Button block type="primary" icon={<PlusOutlined />} style={{ marginBottom: 8 }} onClick={() => navigate('/chat')}>
        新建对话
      </Button>
      <List
        size="small"
        dataSource={chatList}
        locale={{ emptyText: <Empty description="暂无对话" imageStyle={{ height: 40 }} /> }}
        renderItem={(s) => (
          <List.Item
            style={{
              cursor: 'pointer', padding: '6px 8px', borderRadius: 6,
              background: s.id === id ? 'rgba(22,119,255,0.12)' : undefined,
            }}
            actions={[
              <Popconfirm key="d" title="删除该对话？" onConfirm={async (e) => {
                e?.stopPropagation();
                await chatApi.remove(s.id);
                if (s.id === id) navigate('/chat'); else loadList();
              }} onCancel={(e) => e?.stopPropagation()}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
              </Popconfirm>,
            ]}
            onClick={() => { if (s.id !== id) navigate(`/chat/${s.id}`); }}
          >
            <Space size={4} style={{ minWidth: 0 }}>
              <CommentOutlined style={{ color: s.id === id ? '#1677ff' : undefined }} />
              <Typography.Text ellipsis style={{ maxWidth: 140 }}>{s.name}</Typography.Text>
              {s.status === 'running' && <Tag color="processing">生成中</Tag>}
            </Space>
          </List.Item>
        )}
      />
    </Card>
  );

  if (!session) return <Empty description="对话不存在" style={{ marginTop: 100 }} />;

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 120px)' }}>
      <div style={{ width: 240, flexShrink: 0, overflow: 'auto' }}>{sidebar}</div>

      <Card
        style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
        bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 0, minHeight: 0 }}
        title={
          <Space>
            <Button icon={<ArrowLeftOutlined />} size="small" onClick={() => navigate('/chat')} />
            <Typography.Text strong>{session.name}</Typography.Text>
            <Badge status={connected ? 'success' : 'error'} text={connected ? '实时连接' : '未连接'} />
          </Space>
        }
        extra={
          <Space>
            <AutoComplete
              style={{ width: 200 }}
              value={model}
              options={modelOptions}
              placeholder="模型（空=供应商默认）"
              onChange={handleModelChange}
            />
            {running && (
              <Button danger icon={<StopOutlined />} onClick={handleStop}>停止</Button>
            )}
          </Space>
        }
      >
        <ChatMessages
          messages={messages}
          thinkingPendingIds={thinkingPendingIds}
          height="100%"
        />
        <div style={{ padding: 12, borderTop: '1px solid rgba(128,128,128,0.25)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <Mentions
            style={{ flex: 1 }}
            rows={2}
            value={input}
            onChange={setInput}
            placeholder="输入消息，@ 引用文件（Shift+Enter 换行）"
            prefix={['@', '/']}
            options={slashMode ? commandOptions : fileOptions}
            onSearch={(_search, prefix) => setSlashMode(prefix === '/')}
            onPressEnter={(e) => {
              if (!e.shiftKey) { e.preventDefault(); handleSend(); }
            }}
          />
          <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!input.trim() || running} onClick={handleSend}>
            发送
          </Button>
        </div>
      </Card>

      <PermissionModal
        request={permissionRequest}
        onAllow={() => replyPermission('approve')}
        onDeny={() => replyPermission('deny')}
        onWhitelist={() => replyPermission('whitelist')}
      />
    </div>
  );
}
