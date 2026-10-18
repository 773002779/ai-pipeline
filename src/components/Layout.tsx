import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout as AntLayout, Menu, Typography, Space, Tag, Button, theme as antdTheme } from 'antd';
import {
  DashboardOutlined,
  BlockOutlined,
  ApiOutlined,
  ApartmentOutlined,
  NodeIndexOutlined,
  PlaySquareOutlined,
  SettingOutlined,
  SunOutlined,
  MoonOutlined,
} from '@ant-design/icons';
import { useThemeMode } from '../theme/ThemeContext';

const { Header, Sider, Content } = AntLayout;

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
  { key: '/resources', icon: <BlockOutlined />, label: '资源管理' },
  { key: '/providers', icon: <ApiOutlined />, label: '模型配置' },
  { key: '/steps', icon: <SettingOutlined />, label: '步骤管理' },
  { key: '/pipelines', icon: <ApartmentOutlined />, label: '流水线配置' },
  { key: '/sessions', icon: <NodeIndexOutlined />, label: '会话列表' },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const { theme, toggle } = useThemeMode();
  const { token } = antdTheme.useToken();

  const selectedKey = '/' + location.pathname.split('/')[1];

  return (
    <AntLayout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Space>
          <PlaySquareOutlined style={{ fontSize: 24, color: token.colorPrimary }} />
          <Typography.Title level={4} style={{ margin: 0 }}>
            AI Pipeline
          </Typography.Title>
          <Tag color="blue">v1.0</Tag>
        </Space>
        <Space>
          <Typography.Text type="secondary">本地 Claude 流水线代码开发平台</Typography.Text>
          <Button
            type="text"
            icon={theme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggle}
            title={theme === 'dark' ? '切换到白色主题' : '切换到暗色主题'}
          />
        </Space>
      </Header>
      <AntLayout>
        <Sider
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          style={{ background: token.colorBgContainer }}
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
        <Content style={{ padding: 24, background: token.colorBgLayout, minHeight: 'calc(100vh - 64px)' }}>
          <Outlet />
        </Content>
      </AntLayout>
    </AntLayout>
  );
}
