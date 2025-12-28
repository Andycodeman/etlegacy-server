import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';

const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3000/api';

interface GameRegisterResponse {
  user: {
    id: number;
    displayName: string;
    role: string;
    guid: string;
  };
  accessToken: string;
  refreshToken: string;
}

async function gameRegister(data: {
  code: string;
  username: string;
  password: string;
}): Promise<GameRegisterResponse> {
  const response = await fetch(`${API_BASE}/auth/game-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Registration failed' }));
    throw new Error(error.error || 'Registration failed');
  }

  return response.json();
}

export default function GameRegister() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const [step, setStep] = useState<'code' | 'details'>('code');
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [playerName, setPlayerName] = useState('');

  // Verify code first
  const verifyMutation = useMutation({
    mutationFn: async (verifyCode: string) => {
      const response = await fetch(`${API_BASE}/auth/verify-game-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: verifyCode }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Invalid code' }));
        throw new Error(error.error || 'Invalid code');
      }
      return response.json();
    },
    onSuccess: (data) => {
      setPlayerName(data.playerName);
      // Default username to player name (sanitized)
      const sanitizedName = data.playerName.replace(/[^a-zA-Z0-9_]/g, '');
      setUsername(sanitizedName || 'player');
      setStep('details');
    },
  });

  // Register with code + username + password
  const registerMutation = useMutation({
    mutationFn: (data: { code: string; username: string; password: string }) =>
      gameRegister(data),
    onSuccess: (data) => {
      login(
        {
          id: data.user.id,
          displayName: data.user.displayName,
          role: data.user.role as 'admin' | 'moderator' | 'user',
          email: '',
        },
        data.accessToken,
        data.refreshToken
      );
      navigate('/');
    },
  });

  const handleVerifyCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length === 6) {
      verifyMutation.mutate(code.toUpperCase());
    }
  };

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      return;
    }
    registerMutation.mutate({ code: code.toUpperCase(), username, password });
  };

  // Check if error is about username being taken
  const isUsernameTaken = registerMutation.error?.message?.toLowerCase().includes('username') ||
                          registerMutation.error?.message?.toLowerCase().includes('already exists');

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-orange-500 mb-2">ET Panel</h1>
          <p className="text-gray-400">Create account from in-game</p>
        </div>

        <div className="bg-gray-800 rounded-lg p-6 shadow-xl">
          {step === 'code' ? (
            <>
              <h2 className="text-xl font-semibold mb-4">Step 1: Enter Verification Code</h2>
              <p className="text-gray-400 text-sm mb-6">
                Type <code className="bg-gray-700 px-2 py-1 rounded">/etman register</code> in-game
                to get your 6-digit code.
              </p>

              <form onSubmit={handleVerifyCode} className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Verification Code</label>
                  <input
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    placeholder="ABC123"
                    maxLength={6}
                    className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:border-orange-500 text-center text-2xl tracking-[0.5em] uppercase font-mono"
                  />
                </div>

                {verifyMutation.isError && (
                  <p className="text-red-400 text-sm">
                    {(verifyMutation.error as Error).message}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={code.length !== 6 || verifyMutation.isPending}
                  className="w-full py-3 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                >
                  {verifyMutation.isPending ? 'Verifying...' : 'Verify Code'}
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold mb-4">Step 2: Create Your Account</h2>
              <div className="bg-green-900/30 border border-green-600 rounded-lg p-3 mb-6">
                <p className="text-green-400 text-sm">
                  ✓ Verified as <span className="font-medium">{playerName}</span>
                </p>
              </div>

              <form onSubmit={handleRegister} className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Username</label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                    placeholder="your_username"
                    required
                    minLength={3}
                    maxLength={32}
                    className={`w-full bg-gray-700 border rounded px-4 py-3 text-white placeholder-gray-400 focus:outline-none ${
                      isUsernameTaken
                        ? 'border-red-500 focus:border-red-500'
                        : 'border-gray-600 focus:border-orange-500'
                    }`}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    This is your login name. Letters, numbers, underscores only.
                  </p>
                  {isUsernameTaken && (
                    <p className="text-red-400 text-xs mt-1">
                      This username is taken. Please choose a different one.
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm text-gray-400 mb-2">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={6}
                    className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:border-orange-500"
                  />
                  {password && password.length < 6 ? (
                    <p className="text-red-400 text-xs mt-1">
                      Password must be at least 6 characters ({password.length}/6)
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500 mt-1">
                      At least 6 characters
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm text-gray-400 mb-2">Confirm Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={6}
                    className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:border-orange-500"
                  />
                  {confirmPassword && password !== confirmPassword && (
                    <p className="text-red-400 text-xs mt-1">Passwords don't match</p>
                  )}
                </div>

                {registerMutation.isError && !isUsernameTaken && (
                  <p className="text-red-400 text-sm">
                    {(registerMutation.error as Error).message}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={
                    !username ||
                    username.length < 3 ||
                    password.length < 6 ||
                    password !== confirmPassword ||
                    registerMutation.isPending
                  }
                  className="w-full py-3 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                >
                  {registerMutation.isPending ? 'Creating Account...' : 'Create Account'}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setStep('code');
                    setPlayerName('');
                    setUsername('');
                    registerMutation.reset();
                  }}
                  className="w-full py-2 text-gray-400 hover:text-white text-sm transition-colors"
                >
                  ← Use different code
                </button>
              </form>
            </>
          )}
        </div>

        {/* Footer Links */}
        <div className="mt-6 text-center space-y-2">
          <p className="text-gray-400 text-sm">
            Already have an account?{' '}
            <Link to="/login" className="text-orange-400 hover:text-orange-300">
              Sign in
            </Link>
          </p>
          <p className="text-gray-500 text-xs">
            Your username will be linked to your in-game GUID.
          </p>
        </div>
      </div>
    </div>
  );
}
