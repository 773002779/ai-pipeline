import { Modal, Typography, Space, Tag, Button, Descriptions } from 'antd';
import { CheckOutlined, CloseOutlined, SafetyOutlined } from '@ant-design/icons';
import type { PermissionRequest } from '../types';

const RISK_COLORS: Record<string, string> = { low: 'green', medium: 'orange', high: 'red' };
const RISK_LABELS: Record<string, string> = { low: '低风险', medium: '中风险', high: '⚠️ 高风险' };

interface Props {
  request: PermissionRequest | null;
  onAllow: () => void;
  onDeny: () => void;
  onWhitelist: () => void;
}

export default function PermissionModal({ request, onAllow, onDeny, onWhitelist }: Props) {
  if (!request) return null;

  return (
    <Modal
      title={
        <Space>
          <SafetyOutlined style={{ color: '#faad14' }} />
          权限确认请求
        </Space>
      }
      open={!!request}
      onCancel={onDeny}
      footer={
        <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
          <Button danger icon={<CloseOutlined />} onClick={onDeny}>
            拒绝
          </Button>
          <Button icon={<SafetyOutlined />} onClick={onWhitelist}>
            本次会话始终允许
          </Button>
          <Button type="primary" icon={<CheckOutlined />} onClick={onAllow}>
            允许一次
          </Button>
        </Space>
      }
      width={580}
    >
      <Descriptions column={1} size="small">
        <Descriptions.Item label="工具">
          <Tag color="blue">{request.toolName}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="风险等级">
          <Tag color={RISK_COLORS[request.risk]}>{RISK_LABELS[request.risk]}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="详情">
          <Typography.Text>{request.message}</Typography.Text>
        </Descriptions.Item>
        {Object.keys(request.toolInput).length > 0 && (
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
