import { Modal, Typography, Space, Tag, Button, Descriptions, theme } from 'antd';
import { CheckOutlined, CloseOutlined, SafetyOutlined, FileTextOutlined } from '@ant-design/icons';
import type { PermissionRequest } from '../types';

const RISK_COLORS: Record<string, string> = { low: 'green', medium: 'orange', high: 'red' };
const RISK_LABELS: Record<string, string> = { low: '低风险', medium: '中风险', high: '⚠️ 高风险' };
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

interface Props {
  request: PermissionRequest | null;
  onAllow: () => void;
  onDeny: () => void;
  onWhitelist: () => void;
}

export default function PermissionModal({ request, onAllow, onDeny, onWhitelist }: Props) {
  const { token } = theme.useToken();
  if (!request) return null;

  const isEdit = EDIT_TOOLS.includes(request.toolName);

  return (
    <Modal
      title={
        <Space>
          <SafetyOutlined style={{ color: '#faad14' }} />
          {isEdit ? '编辑文件确认' : '权限确认请求'}
        </Space>
      }
      open={!!request}
      onCancel={onDeny}
      footer={
        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button danger icon={<CloseOutlined />} onClick={onDeny}>拒绝</Button>
          <Button icon={<SafetyOutlined />} onClick={onWhitelist}>本次会话始终允许</Button>
          <Button type="primary" icon={<CheckOutlined />} onClick={onAllow}>允许一次</Button>
        </Space>
      }
      width={request.diff ? 760 : 580}
    >
      <Descriptions column={1} size="small">
        <Descriptions.Item label="工具">
          <Space>
            <Tag color="blue">{request.toolName}</Tag>
            {isEdit && <Tag icon={<FileTextOutlined />} color="orange">{request.diff?.path}</Tag>}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="风险等级">
          <Tag color={RISK_COLORS[request.risk]}>{RISK_LABELS[request.risk]}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="详情">
          <Typography.Text>{request.message}</Typography.Text>
        </Descriptions.Item>
        {request.diff && (
          <Descriptions.Item label="变更预览">
            <div style={{
              maxHeight: 280, overflow: 'auto',
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: 4, fontFamily: 'Consolas, Monaco, monospace', fontSize: 12, lineHeight: 1.5,
            }}>
              {request.diff.diffLines.map((l, i) => (
                <div
                  key={i}
                  style={{
                    padding: '0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    background: l.type === 'add' ? '#e6ffec' : l.type === 'del' ? '#ffebe9' : undefined,
                    color: l.type === 'add' ? '#1a7f37' : l.type === 'del' ? '#cf222e' : token.colorText,
                  }}
                >
                  {l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}
                </div>
              ))}
            </div>
          </Descriptions.Item>
        )}
        {!request.diff && Object.keys(request.toolInput).length > 0 && (
          <Descriptions.Item label="参数">
            <Typography.Paragraph code style={{ maxHeight: 120, overflow: 'auto', fontSize: 12, margin: 0 }}>
              {JSON.stringify(request.toolInput, null, 2)}
            </Typography.Paragraph>
          </Descriptions.Item>
        )}
      </Descriptions>
    </Modal>
  );
}
