import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ResourceManager from './pages/ResourceManager';
import ProviderManager from './pages/ProviderManager';
import StepManager from './pages/StepManager';
import PipelineList from './pages/PipelineList';
import PipelineEditor from './pages/PipelineEditor';
import SessionList from './pages/SessionList';
import SessionDetail from './pages/SessionDetail';
import SessionCreate from './pages/SessionCreate';
import ChatList from './pages/ChatList';
import ChatSession from './pages/ChatSession';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/chat" element={<ChatList />} />
        <Route path="/chat/:id" element={<ChatSession />} />
        <Route path="/resources" element={<ResourceManager />} />
        <Route path="/providers" element={<ProviderManager />} />
        <Route path="/steps" element={<StepManager />} />
        <Route path="/pipelines" element={<PipelineList />} />
        <Route path="/pipelines/:id/edit" element={<PipelineEditor />} />
        <Route path="/pipelines/new" element={<PipelineEditor />} />
        <Route path="/sessions" element={<SessionList />} />
        <Route path="/sessions/new" element={<SessionCreate />} />
        <Route path="/sessions/:id" element={<SessionDetail />} />
      </Route>
    </Routes>
  );
}
