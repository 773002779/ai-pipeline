import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Typography, Card, Button, Space, Tag, Steps, message, theme,
  Input, Descriptions, Row, Col, Empty, Spin, Divider, Badge,
} from 'antd';
import {
  PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined,
  StopOutlined, CopyOutlined, ArrowLeftOutlined,
  SendOutlined, SearchOutlined,
} from '@ant-design/icons';
import { sessionApi } from '../api/sessions';
import { useWebSocket } from '../hooks/useWebSocket';
import PermissionModal from '../components/PermissionModal';
import OutputViewer from '../components/OutputViewer';
import type { Session, SessionStatus, SessionStepStatus, Message as Msg, PermissionRequest } from '../types';

// antd 未导出 ThemeToken 类型（antd/es/theme/internal 无此导出），按 brief 回退方案取 useToken 的 token 类型
type ThemeToken = ReturnType<typeof theme.useToken>['token'];

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
  const [messages, setMessages] = useState<Msg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [outputVisible, setOutputVisible] = useState(false);
  const [selectedOutputPath, setSelectedOutputPath] = useState<string>('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const thinkingDoneRef = useRef<Set<string>>(new Set());

  // Inject thinking blink animation style
  useEffect(() => {
    if (!document.getElementById('thinking-blink-style')) {
      const style = document.createElement('style');
      style.id = 'thinking-blink-style';
      style.textContent = `@keyframes thinking-blink { 50% { opacity: 0; } }
        .thinking-cursor { animation: thinking-blink 1s step-end infinite; }`;
      document.head.appendChild(style);
      return () => { document.getElementById('thinking-blink-style')?.remove(); };
    }
  }, []);

  // WebSocket for real-time updates
  const { connected, on, send } = useWebSocket(id);

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
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Listen for WebSocket events
  useEffect(() => {
    const unsubs = [
      on('status_change', (data) => {
        setSession(prev => prev ? { ...prev, status: data.status, currentStepIndex: data.currentStepIndex } : prev);
      }),
      on('ai_message', (data) => {
        if (data.content) {
          const newMsg: Msg = {
            id: `ai-${Date.now()}`, sessionId: id!, stepId: data.stepId,
            role: 'assistant', content: data.content, createdAt: new Date().toISOString(),
          };
          setMessages(prev => {
            // If last message is also assistant and not done, append; otherwise new
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && !data.done) {
              return [...prev.slice(0, -1), { ...last, content: last.content + data.content }];
            }
            return [...prev, newMsg];
          });
        }
      }),
      on('thinking_delta', (data) => {
        const { content, done, stepId } = data;
        if (!content && done) return; // Skip empty done signals
        setMessages(prev => {
          const last = prev[prev.length - 1];
          // If the last message is an assistant still receiving thinking, append
          if (last && last.role === 'assistant' && !thinkingDoneRef.current.has(last.id)) {
            const updatedThinking = (last.thinking || '') + content;
            if (done) thinkingDoneRef.current.add(last.id);
            return [...prev.slice(0, -1), { ...last, thinking: updatedThinking }];
          }
          // First thinking chunk: create a placeholder assistant message
          const newMsg: Msg = {
            id: `ai-${Date.now()}`,
            sessionId: id!,
            stepId,
            role: 'assistant',
            content: '',
            thinking: content,
            createdAt: new Date().toISOString(),
          };
          if (done) thinkingDoneRef.current.add(newMsg.id);
          return [...prev, newMsg];
        });
      }),
      on('tool_use', (data) => {
        setMessages(prev => [...prev, {
          id: `tool-${Date.now()}`, sessionId: id!, role: 'system',
          content: `⚡ Tool: ${data.toolName} - ${JSON.stringify(data.input).substring(0, 100)}`,
          createdAt: new Date().toISOString(),
        }]);
      }),
      on('permission_request', (data) => {
        setPermissionRequest(data);
      }),
      on('step_complete', () => {
        load(); // Reload session to refresh step status
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [on, id, load]);

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

  // Thinking section sub-component
  function ThinkingSection({ thinking, streaming, token }: { thinking: string; streaming: boolean; token: ThemeToken }) {
    const [collapsed, setCollapsed] = useState(true);
    useEffect(() => {
      if (streaming) {
        setCollapsed(false);
      } else {
        const timer = setTimeout(() => setCollapsed(true), 2000);
        return () => clearTimeout(timer);
      }
    }, [streaming]);

    return (
      <div style={{
        marginTop: 6,
        marginBottom: 8,
        background: token.colorFillSecondary,
        border: `1px solid ${token.colorBorder}`,
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 12,
        lineHeight: 1.5,
      }}>
        <div
          onClick={() => setCollapsed(!collapsed)}
          style={{
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            userSelect: 'none',
            color: token.colorTextSecondary,
          }}
        >
          <span>🧠</span>
          <span style={{ fontWeight: 500, fontSize: 11 }}>
            思考过程
            {streaming && (
              <span style={{ marginLeft: 4, color: token.colorTextQuaternary, fontSize: 10 }}>
                (思考中...)
              </span>
            )}
          </span>
          <span style={{ marginLeft: 'auto', fontSize: 10, color: token.colorTextQuaternary }}>
            {collapsed ? '▶ 展开' : '▼ 收起'}
          </span>
        </div>
        {!collapsed && (
          <div style={{
            marginTop: 6,
            padding: '6px 8px',
            background: token.colorFillTertiary,
            borderRadius: 4,
            color: token.colorTextSecondary,
            fontStyle: 'italic',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: streaming ? 300 : 2000,
            overflowY: streaming ? 'auto' : 'visible',
            fontSize: 11,
          }}>
            {thinking}
            {streaming && <span className="thinking-cursor">|</span>}
          </div>
        )}
      </div>
    );
  }

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
            <div style={{ height: 450, overflow: 'auto', padding: 16, background: token.colorBgLayout }}>
              {messages.length === 0 && <Empty description="暂无消息" />}
              {messages.map(m => (
                <div key={m.id} style={{ marginBottom: 10, display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  <div style={{
                    maxWidth: '85%', padding: '8px 12px', borderRadius: 8,
                    background: m.role === 'user' ? '#1677ff' : m.role === 'system' ? token.colorFillSecondary : token.colorFillTertiary,
                    color: m.role === 'system' ? token.colorWarning : token.colorText,
                    border: m.role === 'system' ? `1px solid ${token.colorBorderSecondary}` : 'none',
                  }}>
                    <Typography.Text style={{ color: token.colorTextSecondary, fontSize: 10, display: 'block' }}>
                      {m.role === 'user' ? '👤 你' : m.role === 'system' ? '⚡ 系统' : '🤖 AI'}
                      {' · '}{new Date(m.createdAt).toLocaleTimeString()}
                    </Typography.Text>
                    {m.role === 'assistant' && m.thinking && (
                      <ThinkingSection
                        thinking={m.thinking}
                        streaming={!thinkingDoneRef.current.has(m.id)}
                        token={token}
                      />
                    )}
                    <div style={{ marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>
                      {m.content}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
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
