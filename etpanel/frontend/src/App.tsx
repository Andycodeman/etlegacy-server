import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore } from './stores/auth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Players from './pages/Players';
import PlayerDetail from './pages/PlayerDetail';
import Config from './pages/Config';
import Schedule from './pages/Schedule';
import Console from './pages/Console';
import Chat from './pages/Chat';
import Users from './pages/Users';
import Server from './pages/Server';
import Logs from './pages/Logs';
import ServerBrowser from './pages/ServerBrowser';
import MySounds from './pages/MySounds';
import Playlists from './pages/Playlists';
import PublicSounds from './pages/PublicSounds';
import GameRegister from './pages/GameRegister';
import Admin from './pages/Admin';
import Commands from './pages/Commands';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
    },
  },
});

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<GameRegister />} />
          {/* Public routes - no auth required */}
          <Route path="/stats" element={<Players />} />
          <Route path="/stats/:guid" element={<PlayerDetail />} />
          {/* Protected routes - auth required */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="console" element={<Console />} />
            <Route path="chat" element={<Chat />} />
            <Route path="logs" element={<Logs />} />
            <Route path="players" element={<Players />} />
            <Route path="players/:guid" element={<PlayerDetail />} />
            <Route path="server" element={<Server />} />
            <Route path="config" element={<Config />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="users" element={<Users />} />
            <Route path="browser" element={<ServerBrowser />} />
            {/* Sound Management Routes */}
            <Route path="sounds" element={<MySounds />} />
            <Route path="sounds/playlists" element={<Playlists />} />
            <Route path="sounds/public" element={<PublicSounds />} />
            <Route path="admin" element={<Admin />} />
            <Route path="commands" element={<Commands />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
