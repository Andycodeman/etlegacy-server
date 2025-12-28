import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { auth } from '../api/client';
import { useAuthStore } from '../stores/auth';

const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3000/api';

export default function Login() {
  const [loginId, setLoginId] = useState(''); // Can be email or username
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  const isEmail = loginId.includes('@');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let data;
      if (isEmail) {
        // Login with email
        data = await auth.login(loginId, password);
      } else {
        // Login with username
        const response = await fetch(`${API_BASE}/auth/login-username`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: loginId, password }),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Login failed' }));
          throw new Error(err.error || 'Login failed');
        }
        data = await response.json();
      }
      login(data.user, data.accessToken, data.refreshToken);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 p-4 py-8">
      <div className="w-full max-w-6xl mx-auto space-y-6">
        {/* Top row - Login and Game features */}
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left side - Login form */}
          <div className="lg:w-1/2 bg-gray-800 p-6 md:p-8 rounded-lg shadow-xl">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-orange-500">ET Panel</h1>
            <p className="text-gray-400 mt-2">Server Control Panel</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {error && (
              <div className="bg-red-900/50 border border-red-500 text-red-200 px-4 py-3 rounded">
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Username or Email
              </label>
              <input
                type="text"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                placeholder="username or email@example.com"
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent text-white placeholder-gray-400"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent text-white placeholder-gray-400"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 text-white font-medium rounded-lg transition-colors"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-gray-700">
            <p className="text-gray-400 text-sm text-center mb-4">
              Don't have an account?
            </p>
            <Link
              to="/register"
              className="block w-full py-3 px-4 bg-blue-600 hover:bg-blue-500 text-white text-center font-medium rounded-lg transition-colors"
            >
              Register from In-Game
            </Link>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-700 text-center">
            <p className="text-gray-500 text-sm mb-2">Just want to view stats?</p>
            <Link
              to="/stats"
              className="text-orange-400 hover:text-orange-300 text-sm"
            >
              View Player Stats →
            </Link>
          </div>
        </div>

          {/* Right side - Game Features */}
          <div className="lg:w-1/2 bg-gray-800/50 p-6 md:p-8 rounded-lg">
          <h2 className="text-2xl font-bold text-orange-500 mb-4">ETMan's Server</h2>
          <p className="text-gray-300 mb-6">
            A custom Wolfenstein: Enemy Territory server with unique features powered by our custom mod.
          </p>

          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <span className="text-2xl">🚀</span>
              <div>
                <h3 className="font-semibold text-white">Freeze & Homing Rockets</h3>
                <p className="text-gray-400 text-sm">Custom rocket modes - freeze enemies in place or let rockets track targets!</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="text-2xl">🎤</span>
              <div>
                <h3 className="font-semibold text-white">Live Voice Chat</h3>
                <p className="text-gray-400 text-sm">Real-time voice communication with your team using built-in voice chat.</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="text-2xl">🎵</span>
              <div>
                <h3 className="font-semibold text-white">Custom Sound System</h3>
                <p className="text-gray-400 text-sm">Upload and play MP3 sounds in-game. Create playlists and share with others!</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="text-2xl">⚡</span>
              <div>
                <h3 className="font-semibold text-white">Survival Mode</h3>
                <p className="text-gray-400 text-sm">Earn faster firing and movement as you rack up kills. Reach 30 kills for PANZERFEST!</p>
              </div>
            </div>
          </div>

          {/* ET:Legacy Requirement */}
          <div className="mt-6 p-4 bg-blue-900/30 border border-blue-600 rounded-lg">
            <div className="flex items-center gap-3 mb-3">
              <img
                src="https://www.etlegacy.com/favicon.ico"
                alt="ET:Legacy"
                className="w-8 h-8"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
              <h3 className="font-semibold text-blue-400">ET:Legacy Required</h3>
            </div>
            <p className="text-gray-300 text-sm mb-3">
              These custom features require the <strong>ET:Legacy</strong> client. The original ET 2.60b will connect but won't have voice chat, custom sounds, or mod features.
            </p>
            <a
              href="https://www.etlegacy.com/download"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors text-sm font-medium"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download ET:Legacy
            </a>
          </div>

          <div className="mt-4 text-center">
            <p className="text-gray-500 text-sm">Connect: <code className="bg-gray-700 px-2 py-1 rounded text-orange-400">et.etman.dev:27960</code></p>
          </div>
        </div>
        </div>

        {/* Bottom row - Web Panel Features */}
        <div className="bg-gray-800/50 p-6 md:p-8 rounded-lg">
          <h2 className="text-2xl font-bold text-green-500 mb-4">ET Panel Features</h2>
          <p className="text-gray-300 mb-6">
            Register an account to unlock web-based features that sync with your in-game experience.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-gray-700/50 p-4 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xl">🎵</span>
                <h3 className="font-semibold text-white">Sound Library</h3>
              </div>
              <p className="text-gray-400 text-sm">
                Upload MP3s from URLs, organize into playlists, and play them in-game with <code className="text-xs bg-gray-600 px-1 rounded">/etman playsnd</code>
              </p>
            </div>

            <div className="bg-gray-700/50 p-4 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xl">📊</span>
                <h3 className="font-semibold text-white">Player Stats</h3>
              </div>
              <p className="text-gray-400 text-sm">
                Track your kills, deaths, weapon accuracy, and head-to-head matchups against other players.
              </p>
            </div>

            <div className="bg-gray-700/50 p-4 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xl">🌐</span>
                <h3 className="font-semibold text-white">Server Scout</h3>
              </div>
              <p className="text-gray-400 text-sm">
                Monitor your favorite ET servers, see who's playing, and connect with one click.
              </p>
            </div>

            <div className="bg-gray-700/50 p-4 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xl">🤝</span>
                <h3 className="font-semibold text-white">Share & Discover</h3>
              </div>
              <p className="text-gray-400 text-sm">
                Share sounds with friends, browse public playlists, and discover new content from other players.
              </p>
            </div>
          </div>

          <div className="mt-6 p-4 bg-green-900/20 border border-green-600/50 rounded-lg">
            <h3 className="font-semibold text-green-400 mb-2">How to Register</h3>
            <ol className="text-gray-300 text-sm space-y-1 list-decimal list-inside">
              <li>Connect to the server: <code className="bg-gray-700 px-1 rounded text-orange-400">et.etman.dev:27960</code></li>
              <li>Type <code className="bg-gray-700 px-1 rounded text-orange-400">/etman register</code> in console to get a verification code</li>
              <li>Click "Register from In-Game" above and enter your code</li>
              <li>Your web account is now linked to your in-game identity!</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
