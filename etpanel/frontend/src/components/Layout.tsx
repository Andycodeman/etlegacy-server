import { useState, useEffect } from 'react';
import { Link, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../stores/auth';
import { auth, sounds, users } from '../api/client';

const navItems = [
  { path: '/', label: 'Dashboard', icon: '📊' },
  { path: '/browser', label: 'Server Scout', icon: '🌐' },
  { path: '/commands', label: 'Commands', icon: '⚡' },
  { path: '/console', label: 'Console', icon: '🖥️', adminOnly: true },
  { path: '/chat', label: 'Chat', icon: '💬' },
  { path: '/logs', label: 'Logs', icon: '📜', modOnly: true },
  { path: '/players', label: 'Players', icon: '👥' },
  { path: '/server', label: 'Server', icon: '🎮', adminOnly: true },
  { path: '/config', label: 'Config', icon: '⚙️', adminOnly: true },
  { path: '/schedule', label: 'Schedule', icon: '📅' },
  { path: '/users', label: 'Users', icon: '🔑', adminOnly: true },
  { path: '/admin', label: 'Admin', icon: '🛡️', modOnly: true },
];

const soundNavItems = [
  { path: '/sounds', label: 'My Sounds', icon: '🎵' },
  { path: '/sounds/playlists', label: 'Playlists', icon: '📁' },
  { path: '/sounds/public', label: 'Public Library', icon: '🌐' },
  { path: '/sounds/private', label: 'Private Library', icon: '🔒', adminOnly: true },
];

export default function Layout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Fetch counts for sidebar badges
  const { data: mySoundsData } = useQuery({
    queryKey: ['mySounds'],
    queryFn: sounds.list,
    staleTime: 30000, // Cache for 30 seconds
  });

  const { data: playlistsData } = useQuery({
    queryKey: ['playlists'],
    queryFn: sounds.playlists,
    staleTime: 30000,
  });

  const { data: publicLibraryData } = useQuery({
    queryKey: ['publicLibrary'],
    queryFn: () => sounds.publicLibrary(),
    staleTime: 30000,
  });

  // Fetch users count for admin badge
  const { data: usersData } = useQuery({
    queryKey: ['users'],
    queryFn: users.list,
    staleTime: 30000,
    enabled: user?.role === 'admin', // Only fetch for admins
  });

  const mySoundsCount = mySoundsData?.sounds?.length || 0;
  const usersCount = usersData?.users?.length || 0;
  const playlistsCount = playlistsData?.playlists?.length || 0;
  const publicLibraryCount = publicLibraryData?.sounds?.length || 0;

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Close sidebar on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  const handleLogout = async () => {
    try {
      await auth.logout();
    } catch {
      // Ignore logout errors
    }
    logout();
    navigate('/login');
  };

  return (
    <div className="h-screen bg-gray-900 flex overflow-hidden">
      {/* Mobile Header */}
      <div className="fixed top-0 left-0 right-0 h-14 bg-gray-800 border-b border-gray-700 flex items-center justify-between px-4 md:hidden z-40">
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-2 -ml-2 text-gray-300 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
          aria-label="Open menu"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <h1 className="text-lg font-bold text-orange-500">ET Panel</h1>
        <div className="w-10" /> {/* Spacer for centering */}
      </div>

      {/* Mobile Overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - fixed height on desktop */}
      <aside
        className={`fixed md:sticky md:top-0 inset-y-0 left-0 w-64 h-screen bg-gray-800 border-r border-gray-700 transform transition-transform duration-200 ease-in-out z-50 flex flex-col ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <div className="px-4 pt-4 pb-[12px] border-b border-gray-700 flex items-center justify-between flex-shrink-0">
          <div className="leading-tight">
            <h1 className="text-xl font-bold text-orange-500">ET Panel</h1>
            <p className="text-sm text-gray-400 -mt-0.5">Server Control</p>
          </div>
          {/* Close button for mobile */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-2 -mr-2 text-gray-400 hover:text-white md:hidden"
            aria-label="Close menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav className="p-4 space-y-2 flex-1 overflow-y-auto">
          {navItems
            .filter((item) => {
              if (item.adminOnly) return user?.role === 'admin';
              if (item.modOnly) return user?.role === 'admin' || user?.role === 'moderator';
              return true;
            })
            .map((item) => {
              // Get badge count for specific items
              let badgeCount = 0;
              if (item.path === '/users') badgeCount = usersCount;

              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center gap-3 px-4 py-3 md:py-2 rounded-lg transition-colors ${
                    location.pathname === item.path
                      ? 'bg-orange-600 text-white'
                      : 'text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  <span className="text-lg md:text-base">{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                  {badgeCount > 0 && (
                    <span className={`px-1.5 py-0.5 text-xs rounded-full ${
                      location.pathname === item.path
                        ? 'bg-orange-700 text-white'
                        : 'bg-gray-600 text-gray-300'
                    }`}>
                      {badgeCount}
                    </span>
                  )}
                </Link>
              );
            })}

          {/* Sounds Section */}
          <div className="pt-4 mt-4 border-t border-gray-700">
            <div className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Sounds
            </div>
            {soundNavItems
              .filter((item) => {
                if (item.adminOnly) return user?.role === 'admin';
                return true;
              })
              .map((item) => {
              // Get the count for each item
              let count = 0;
              if (item.path === '/sounds') count = mySoundsCount;
              else if (item.path === '/sounds/playlists') count = playlistsCount;
              else if (item.path === '/sounds/public') count = publicLibraryCount;

              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center gap-3 px-4 py-3 md:py-2 rounded-lg transition-colors ${
                    location.pathname === item.path
                      ? 'bg-orange-600 text-white'
                      : 'text-gray-300 hover:bg-gray-700'
                  }`}
                >
                  <span className="text-lg md:text-base">{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                  {count > 0 && (
                    <span className={`px-1.5 py-0.5 text-xs rounded-full ${
                      location.pathname === item.path
                        ? 'bg-orange-700 text-white'
                        : 'bg-gray-600 text-gray-300'
                    }`}>
                      {count}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="p-4 border-t border-gray-700 bg-gray-800 flex-shrink-0">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="font-medium text-sm">{user?.displayName}</div>
              <div className="text-xs text-gray-400">{user?.role}</div>
            </div>
            <button
              onClick={handleLogout}
              className="px-3 py-2 md:py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded transition-colors"
            >
              Logout
            </button>
          </div>
          <Link
            to="/settings"
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
              location.pathname === '/settings'
                ? 'bg-orange-600 text-white'
                : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
            }`}
          >
            <span>⚙️</span>
            <span>Settings</span>
          </Link>
        </div>
      </aside>

      {/* Main content - scrollable */}
      <main className="flex-1 p-4 md:p-8 overflow-y-auto pt-18 md:pt-8">
        <Outlet />
      </main>
    </div>
  );
}
