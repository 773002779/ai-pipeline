import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Typography, Card, Button, Space, Tag, Steps, message, theme,
  Input, Descriptions, Row, Col, Empty, Spin, Badge,
} from 'antd';
import {
  PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined,
  StopOutlined, CopyOutlined, ArrowLeftOutlined,
  SendOutlined, SearchOutlined,
} from '@ant-design/icons';
import { sessionApi } from '../api/sessions';
import { useLiveMessages } from '../hooks/useLiveMessages';
import ChatMessages from '../components/ChatMessages';
import PermissionModal from '../components/PermissionModal';
import OutputViewer from '../components/OutputViewer';
import type { Session, SessionStatus, SessionStepStatus } from '../types';

const STATUS_TAGS: Record<SessionStatus, { color: string; label: string }> = {
  idle: { color: 'default', label: '等待中' }, precheck: { color: 'processing', label: '预检中' },
  running: { color: 'processing', label: '执行中' }, waiting_confirm: { color: 'warning', label: '等待确认' },
  paused: { color: 'warning', label: '已暂停' }, error: { color: 'error', label: '异常' },
  completed: { color: 'success', label: '已完成' }, cancelled: { color: 'default', label: '已取消' },
};

const STEP_ICONS: Record<SessionStepStatus, string> = {
  pending: '⏳', running: '🔵', completed: '✅', error: '❌', skipped: '⏭️',
};

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [session, setSession] = useState<Session | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [outputVisible, setOutputVisible] = useState(false);
  const [selectedOutputPath, setSelectedOutputPath] = useState<string>('');

  // 会话实时消息流：ai_message / thinking_delta / tool_use / permission_request 均由 hook 处理
  const {
    messages, setMessages, permissionRequest, setPermissionRequest,
    thinkingDoneRef, connected, on, send,
  } = useLiveMessages(id);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [s, msgs] = await Promise.all([
        sessionApi.get(id),
        sessionApi.getMessages(id),
      ]);
      setSession(s);
      setMessages(msgs);
      // Mark pre-loaded assistant messages with thinking as done
      for (const m of msgs) {
        if (m.role === 'assistant' && m.thinking) {
          thinkingDoneRef.current.add(m.id);
        }
      }
    } catch { message.error('加载会话失败'); }
    finally { setLoading(false); }
  }, [id, setMessages, thinkingDoneRef]);

  useEffect(() => { load(); }, [load]);

  // Listen for pipeline-level WebSocket events（消息类事件由 useLiveMessages 处理）
  useEffect(() => {
    const unsubs = [
      on('status_change', (data) => {
        setSession(prev => prev ? { ...prev, status: data.status, currentStepIndex: data.currentStepIndex } : prev);
      }),
      on('step_complete', () => {
        load(); // Reload session to refresh step status
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [on, load]);

  // thinking 仍在流式接收的消息 id 集合
  const thinkingPendingIds = useMemo(
    () => new Set(
      messages
        .filter(m => m.role === 'assistant' && m.thinking && !thinkingDoneRef.current.has(m.id))
        .map(m => m.id)
    ),
    [messages, thinkingDoneRef]
  );

  const handleAction = async (action: string) => {
    if (!id) return;
    try {
      switch (action) {
        case 'precheck': setSession(await sessionApi.precheck(id)); break;
        case 'start': setSession(await sessionApi.start(id)); break;
        case 'pause': setSession(await sessionApi.pause(id)); break;
        case 'resume': setSession(await sessionApi.resume(id)); break;
        case 'cancel': setSession(await sessionApi.cancel(id)); break;
        case 'retry': setSession(await sessionApi.retry(id)); break;
        case 'clone': {
          const cloned = await sessionApi.clone(id);
          message.success('克隆成功');
          navigate(`/sessions/${cloned.id}`);
          return;
        }
      }
      message.success('操作成功');
    } catch (err: any) { message.error(err.message || '操作失败'); }
  };

  const handlePermissionResponse = async (action: 'approve' | 'deny' | 'whitelist') => {
    if (!permissionRequest) return;
    // Send response via WebSocket to the server
    send({ type: 'permission_response', data: { reqId: permissionRequest.id, action } });
    setPermissionRequest(null);
  };

  const handleSend = async () => {
    if (!id || !chatInput.trim()) return;
    setSending(true);
    try {
      const msg = await sessionApi.sendMessage(id, chatInput.trim());
      setMessages([...messages, msg]);
      setChatInput('');
    } catch { message.error('发送失败'); }
    finally { setSending(false); }
  };

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  if (!session) return <Empty description="会话未找到" />;

  const st = STATUS_TAGS[session.status];

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/sessions')}>返回</Button>
          <Typography.Title level={3} style={{ margin: 0 }}>{session.name}</Typography.Title>
          <Tag color={st.color}>{st.label}</Tag>
          <Badge status={connected ? 'success' : 'error'} text={connected ? '实时连接' : '未连接'} />
        </Space>
        <Space>
          {session.status === 'idle' && (
            <>
              <Button icon={<SearchOutlined />} onClick={() => handleAction('precheck')}>预检</Button>
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => handleAction('start')}>开始执行</Button>
            </>
          )}
          {session.status === 'running' && <Button icon={<PauseCircleOutlined />} onClick={() => handleAction('pause')}>暂停</Button>}
          {session.status === 'paused' && <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => handleAction('resume')}>恢复</Button>}
          {session.status === 'waiting_confirm' && (
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => handleAction('resume')}>继续下一步</Button>
          )}
          {session.status === 'error' && <Button icon={<ReloadOutlined />} onClick={() => handleAction('retry')}>重试</Button>}
          {['idle', 'running', 'paused', 'error'].includes(session.status) && (
            <Button danger icon={<StopOutlined />} onClick={() => handleAction('cancel')}>取消</Button>
          )}
          <Button icon={<CopyOutlined />} onClick={() => handleAction('clone')}>克隆</Button>
        </Space>
      </div>

      <Row gutter={16}>
        {/* Left column: Steps + Environment */}
        <Col xs={24} lg={8}>
          <Card title="步骤进度" size="small" style={{ marginBottom: 16 }}>
            <Steps
              direction="vertical" size="small"
              current={session.currentStepIndex}
              status={session.status === 'error' ? 'error' : session.status === 'completed' ? 'finish' : 'process'}
              items={session.steps.map((s, i) => ({
                title: <Space>
                  <span>{STEP_ICONS[s.status]}</span>
                  <Typography.Text style={{ fontSize: 13 }}>{s.stepName}</Typography.Text>
                  {s.retryCount > 0 && <Tag color="orange" style={{ fontSize: 10 }}>×{s.retryCount}</Tag>}
                </Space>,
                description: s.outputPath ? (
                  <Button size="small" type="link" onClick={() => { setSelectedOutputPath(s.outputPath || ''); setOutputVisible(true); }}>
                    查看输出
                  </Button>
                ) : s.errorMessage ? (
                  <Typography.Text type="danger" style={{ fontSize: 11 }}>{s.errorMessage}</Typography.Text>
                ) : undefined,
              }))}
            />
          </Card>

          {session.environment && (
            <Card title="🏗️ 环境信息" size="small">
              <Descriptions column={1} size="small">
                <Descriptions.Item label="可用工具">
                  {session.environment.availableTools.map((t: string) => <Tag key={t}>{t}</Tag>)}
                </Descriptions.Item>
                {session.environment.workspaces.map((w: any) => (
                  <Descriptions.Item key={w.name} label={`📁 ${w.name}`}>
                    <div><Typography.Text code>{w.path}</Typography.Text></div>
                    <Space wrap style={{ marginTop: 4 }}>
                      {w.techStack.map((t: string) => <Tag key={t} color="blue">{t}</Tag>)}
                    </Space>
                  </Descriptions.Item>
                ))}
              </Descriptions>
            </Card>
          )}
        </Col>

        {/* Right column: Chat */}
        <Col xs={24} lg={16}>
          <Card
            title={<Space>💬 对话 <Tag>{messages.length}</Tag></Space>}
            size="small"
            bodyStyle={{ padding: 0 }}
          >
            <ChatMessages
              messages={messages}
              thinkingPendingIds={thinkingPendingIds}
              height={450}
            />
            <div style={{ padding: 12, borderTop: `1px solid ${token.colorBorderSecondary}`, display: 'flex', gap: 8 }}>
              <Input.TextArea
                value={chatInput} onChange={e => setChatInput(e.target.value)}
                placeholder="输入消息与 AI 对话... (Shift+Enter 换行)" rows={2}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
                }}
                disabled={['cancelled'].includes(session.status)}
              />
              <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={handleSend} disabled={!chatInput.trim()}>
                发送
              </Button>
            </div>
          </Card>
        </Col>
      </Row>

      {/* Permission Modal */}
      <PermissionModal
        request={permissionRequest}
        onAllow={() => handlePermissionResponse('approve')}
        onDeny={() => handlePermissionResponse('deny')}
        onWhitelist={() => handlePermissionResponse('whitelist')}
      />

      {/* Output Viewer */}
      <OutputViewer
        open={outputVisible}
        path={selectedOutputPath}
        onClose={() => setOutputVisible(false)}
      />
    </div>
  );
}
