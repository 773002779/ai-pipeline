import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, Row, Col, Statistic, Typography, Segmented, DatePicker, Table, List,
  Tag, Empty, Spin, message, Space, theme as antdTheme,
} from 'antd';
import {
  BlockOutlined, ApartmentOutlined, SyncOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import dayjs, { type Dayjs } from 'dayjs';
import { statsApi, type StatsOverview, type UsageStats } from '../api/stats';

type RangeKey = 'today' | 'd7' | 'd30' | 'all' | 'custom';

const COLORS = ['#1677ff', '#52c41a', '#faad14', '#eb2f96', '#722ed1', '#13c2c2', '#fa8c16', '#2f54eb'];
const fmt = (d: Dayjs) => d.format('YYYY-MM-DD');

export default function Dashboard() {
  const navigate = useNavigate();
  const { token } = antdTheme.useToken();
  const [rangeKey, setRangeKey] = useState<RangeKey>('d7');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  const range = useMemo<{ from: string; to: string }>(() => {
    const today = dayjs();
    switch (rangeKey) {
      case 'today': return { from: fmt(today), to: fmt(today) };
      case 'd30': return { from: fmt(today.subtract(29, 'day')), to: fmt(today) };
      case 'all': return { from: '1970-01-01', to: fmt(today) };
      case 'custom':
        return customRange
          ? { from: fmt(customRange[0]), to: fmt(customRange[1]) }
          : { from: fmt(today.subtract(6, 'day')), to: fmt(today) };
      default: return { from: fmt(today.subtract(6, 'day')), to: fmt(today) };
    }
  }, [rangeKey, customRange]);

  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const [ov, us] = await Promise.all([statsApi.overview(), statsApi.usage(range)]);
      if (seq !== loadSeqRef.current) return; // 已有更新的请求，丢弃本次结果
      setOverview(ov);
      setUsage(us);
    } catch {
      if (seq !== loadSeqRef.current) return;
      message.error('加载统计数据失败');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // daily: [{date, model, tokens}] → [{date, [model]: tokens}] 供堆叠柱图
  const pivoted = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const r of usage?.daily || []) {
      if (!map.has(r.date)) map.set(r.date, { date: r.date });
      (map.get(r.date) as Record<string, unknown>)[r.model] = r.tokens;
    }
    return Array.from(map.values());
  }, [usage]);

  const modelNames = useMemo(() => (usage?.models || []).map(m => m.model), [usage]);

  if (loading && !overview) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;

  return (
    <div>
      <Typography.Title level={3}>仪表盘</Typography.Title>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="资源总数" value={overview?.resources ?? 0} prefix={<BlockOutlined />} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card><Statistic title="流水线模板" value={overview?.pipelines ?? 0} prefix={<ApartmentOutlined />} /></Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="活跃会话" value={overview?.sessionsByStatus?.running ?? 0}
              prefix={<SyncOutlined spin={(overview?.sessionsByStatus?.running ?? 0) > 0} />}
              valueStyle={{ color: token.colorPrimary }} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic title="已完成会话" value={overview?.sessionsByStatus?.completed ?? 0}
              prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
      </Row>

      <Card style={{ marginBottom: 16 }}>
        <Space wrap style={{ marginBottom: 16 }}>
          <Segmented
            value={rangeKey}
            onChange={(v) => setRangeKey(v as RangeKey)}
            options={[
              { label: '今天', value: 'today' },
              { label: '近7天', value: 'd7' },
              { label: '近30天', value: 'd30' },
              { label: '全部', value: 'all' },
            ]}
          />
          <DatePicker.RangePicker
            value={customRange}
            allowClear={false}
            onChange={(v) => {
              if (v && v[0] && v[1]) {
                setCustomRange([v[0], v[1] as Dayjs]);
                setRangeKey('custom');
              }
            }}
          />
        </Space>

        <Typography.Title level={5}>每日 Token 消耗（按模型堆叠）</Typography.Title>
        {pivoted.length === 0 ? (
          <Empty description="所选时间范围内暂无用量数据（统计自功能上线起累积）" />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={pivoted}>
              <CartesianGrid strokeDasharray="3 3" stroke={token.colorBorderSecondary} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: token.colorTextSecondary }} />
              <YAxis tick={{ fontSize: 11, fill: token.colorTextSecondary }} />
              <Tooltip />
              <Legend />
              {modelNames.map((m, i) => (
                <Bar key={m} dataKey={m} stackId="t" fill={COLORS[i % COLORS.length]} name={m} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title="模型用量明细" size="small">
            <Table
              rowKey="model"
              size="small"
              dataSource={usage?.models || []}
              pagination={false}
              locale={{ emptyText: <Empty description="暂无数据" /> }}
              columns={[
                { title: '模型', dataIndex: 'model' },
                { title: '输入', dataIndex: 'inputTokens', render: (v: number) => v.toLocaleString() },
                { title: '输出', dataIndex: 'outputTokens', render: (v: number) => v.toLocaleString() },
                { title: '缓存', dataIndex: 'cacheTokens', render: (v: number) => v.toLocaleString() },
                {
                  title: '合计', dataIndex: 'totalTokens', defaultSortOrder: 'descend',
                  sorter: (a: any, b: any) => a.totalTokens - b.totalTokens,
                  render: (v: number) => v.toLocaleString(),
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="Top5 Token 消耗会话" size="small">
            <List
              dataSource={usage?.topSessions || []}
              locale={{ emptyText: <Empty description="暂无数据" /> }}
              renderItem={(item) => (
                <List.Item
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(item.kind === 'chat' ? `/chat/${item.sessionId}` : `/sessions/${item.sessionId}`)}
                  actions={[<Typography.Text key="t" type="secondary">{item.totalTokens.toLocaleString()} tokens</Typography.Text>]}
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        <Typography.Text ellipsis style={{ maxWidth: 260 }}>
                          {item.name || '未命名会话'}
                        </Typography.Text>
                        <Tag color={item.kind === 'chat' ? 'purple' : 'blue'}>
                          {item.kind === 'chat' ? '对话' : '流水线'}
                        </Tag>
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
