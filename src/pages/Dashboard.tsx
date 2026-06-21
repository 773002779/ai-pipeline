import { Card, Row, Col, Statistic, Typography } from 'antd';
import {
  BlockOutlined,
  ApartmentOutlined,
  NodeIndexOutlined,
  CheckCircleOutlined,
  SyncOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons';

export default function Dashboard() {
  return (
    <div>
      <Typography.Title level={3}>仪表盘</Typography.Title>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="资源总数" value={12} prefix={<BlockOutlined />} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="流水线模板" value={6} prefix={<ApartmentOutlined />} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="活跃会话" value={2} prefix={<SyncOutlined spin />} valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="已完成会话" value={15} prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="快捷操作">
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <Card size="small" hoverable onClick={() => window.location.href = '/sessions/new'}>
                  🚀 创建新会话
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small" hoverable onClick={() => window.location.href = '/pipelines/new'}>
                  ⚙️ 新建流水线
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small" hoverable onClick={() => window.location.href = '/resources'}>
                  📦 管理资源
                </Card>
              </Col>
              <Col span={12}>
                <Card size="small" hoverable onClick={() => window.location.href = '/sessions'}>
                  📋 查看会话
                </Card>
              </Col>
            </Row>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="系统状态">
            <Statistic
              title="后端服务"
              value="运行中"
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: '#52c41a', fontSize: 18 }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
