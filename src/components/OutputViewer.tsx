import { useState, useEffect } from 'react';
import { Modal, Typography, Spin, Empty } from 'antd';

interface Props {
  open: boolean;
  path: string;
  onClose: () => void;
}

export default function OutputViewer({ open, path, onClose }: Props) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !path) return;
    setLoading(true);
    // Load output file content via API
    fetch(`/api/sessions/${path}`)
      .then(r => {
        if (!r.ok) throw new Error('Not found');
        return r.json();
      })
      .then(data => {
        if (data.success && data.data) {
          setContent(data.data);
        }
      })
      .catch(() => setContent('*无法加载输出文件*'))
      .finally(() => setLoading(false));
  }, [open, path]);

  return (
    <Modal
      title="📄 步骤输出"
      open={open}
      onCancel={onClose}
      footer={null}
      width={800}
      bodyStyle={{ maxHeight: '70vh', overflow: 'auto' }}
    >
      {loading ? (
        <Spin />
      ) : content ? (
        <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>
          {content}
        </div>
      ) : (
        <Empty description="暂无输出内容" />
      )}
    </Modal>
  );
}
