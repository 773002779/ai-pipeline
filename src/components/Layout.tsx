import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout as AntLayout, Menu, Typography, Space, Tag } from 'antd';
import {
  DashboardOutlined,
  BlockOutlined,
  ApartmentOutlined,
  NodeIndexOutlined,
  PlaySquareOutlined,
  SettingOutlined,
} from '@ant-design/icons';

const { Header, Sider, Content } = AntLayout;

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
  { key: '/resources', icon: <BlockOutlined />, label: '资源管理' },
  { key: '/steps', icon: <SettingOutlined />, label: '步骤管理' },
  { key: '/pipelines', icon: <ApartmentOutlined />, label: '流水线配置' },
  { key: '/sessions', icon: <NodeIndexOutlined />, label: '会话列表' },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const selectedKey = '/' + location.pathname.split('/')[1];

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          background: '#141414',
          borderBottom: '1px solid #303030',
        }}
      >
        <Space>
          <PlaySquareOutlined style={{ fontSize: 24, color: '#1677ff' }} />
          <Typography.Title level={4} style={{ margin: 0, color: '#fff' }}>
            AI Pipeline
          </Typography.Title>
          <Tag color="blue">v1.0</Tag>
        </Space>
        <Typography.Text type="secondary">
          本地 Claude 流水线代码开发平台
        </Typography.Text>
      </Header>
      <AntLayout>
        <Sider
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          style={{ background: '#141414' }}
          width={200}
        >
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
            style={{ background: 'transparent', borderRight: 0 }}
          />
        </Sider>
        <Content style={{ padding: 24, background: '#1f1f1f', minHeight: 'calc(100vh - 64px)' }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  );
}
