import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sounds, settings, auth } from '../api/client';

export default function Settings() {
  const queryClient = useQueryClient();

  // User info
  const { data: user } = useQuery({
    queryKey: ['me'],
    queryFn: auth.me,
  });

  // GUID status
  const { data: guidStatus } = useQuery({
    queryKey: ['guidStatus'],
    queryFn: sounds.getGuidStatus,
  });

  // Quick Command settings
  const { data: quickCmdData, isLoading: quickCmdLoading } = useQuery({
    queryKey: ['quickCommandSettings'],
    queryFn: settings.getQuickCommand,
    enabled: guidStatus?.linked === true,
  });

  // Local state for prefix editing
  const [prefix, setPrefix] = useState('');
  const [prefixError, setPrefixError] = useState<string | null>(null);
  const [prefixSaved, setPrefixSaved] = useState(false);

  // Initialize prefix from server data
  useEffect(() => {
    if (quickCmdData?.prefix !== undefined) {
      setPrefix(quickCmdData.prefix);
    }
  }, [quickCmdData?.prefix]);

  // Update prefix mutation
  const updatePrefixMutation = useMutation({
    mutationFn: (newPrefix: string) => settings.updatePrefix(newPrefix),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['quickCommandSettings'] });
      setPrefix(data.prefix);
      setPrefixError(null);
      setPrefixSaved(true);
      setTimeout(() => setPrefixSaved(false), 2000);
    },
    onError: (error: Error) => {
      setPrefixError(error.message);
    },
  });

  const handlePrefixSave = () => {
    if (prefix !== quickCmdData?.prefix) {
      updatePrefixMutation.mutate(prefix);
    }
  };

  // Format prefix for display - show trailing space visually
  const formatPrefixDisplay = (p: string) => {
    if (p.endsWith(' ')) {
      return p.slice(0, -1) + '␣';
    }
    return p;
  };

  const isLinked = guidStatus?.linked === true;

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      {/* Account Info */}
      <div className="bg-gray-800 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span>👤</span>
          Account
        </h2>
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-gray-400">Display Name</span>
            <span className="font-medium">{user?.displayName || '—'}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-400">Email</span>
            <span className="font-medium">{user?.email || '—'}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-400">Role</span>
            <span className={`font-medium ${
              user?.role === 'admin' ? 'text-red-400' :
              user?.role === 'moderator' ? 'text-yellow-400' :
              'text-gray-300'
            }`}>
              {user?.role || '—'}
            </span>
          </div>
        </div>
      </div>

      {/* Game Account Link Status */}
      <div className="bg-gray-800 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span>🎮</span>
          Game Account
        </h2>
        {isLinked ? (
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Status</span>
              <span className="text-green-400 font-medium flex items-center gap-2">
                <span className="w-2 h-2 bg-green-400 rounded-full"></span>
                Linked
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-400">GUID</span>
              <span className="font-mono text-sm text-gray-300">
                {guidStatus?.guid?.substring(0, 8)}...{guidStatus?.guid?.substring(24)}
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-2">
              Your web account is linked to your in-game identity. You can manage sounds and use quick commands.
            </p>
          </div>
        ) : (
          <div>
            <div className="flex justify-between items-center mb-3">
              <span className="text-gray-400">Status</span>
              <span className="text-yellow-400 font-medium flex items-center gap-2">
                <span className="w-2 h-2 bg-yellow-400 rounded-full"></span>
                Not Linked
              </span>
            </div>
            <p className="text-sm text-gray-400 mb-3">
              Link your game account to manage sounds and use quick commands.
            </p>
            <a
              href="/sounds"
              className="inline-block px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded font-medium transition-colors text-sm"
            >
              Link Account in My Sounds
            </a>
          </div>
        )}
      </div>

      {/* Quick Command Settings */}
      <div className="bg-gray-800 rounded-lg p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span>⚡</span>
          Quick Commands
        </h2>

        {!isLinked ? (
          <p className="text-gray-400">
            Link your game account to configure quick commands.
          </p>
        ) : quickCmdLoading ? (
          <p className="text-gray-400">Loading...</p>
        ) : (
          <div className="space-y-4">
            {/* Prefix Setting */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Command Prefix
              </label>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <input
                    type="text"
                    value={prefix}
                    onChange={(e) => {
                      const val = e.target.value;
                      // Allow trailing space but not leading/middle whitespace
                      if (val.length <= 4 && !/^\s/.test(val) && !/\s[^\s]/.test(val)) {
                        setPrefix(val);
                        setPrefixError(null);
                        setPrefixSaved(false);
                      }
                    }}
                    onBlur={handlePrefixSave}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handlePrefixSave();
                    }}
                    maxLength={4}
                    className={`w-24 bg-gray-700 border rounded px-3 py-2 text-white font-mono text-center focus:outline-none ${
                      prefixError ? 'border-red-500' : 'border-gray-600 focus:border-cyan-500'
                    }`}
                    placeholder="@"
                  />
                  {prefix.endsWith(' ') && (
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-cyan-400" title="Includes trailing space">
                      ␣
                    </span>
                  )}
                </div>
                <button
                  onClick={handlePrefixSave}
                  disabled={updatePrefixMutation.isPending || prefix === quickCmdData?.prefix}
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                >
                  {updatePrefixMutation.isPending ? 'Saving...' : 'Save'}
                </button>
                {prefixSaved && (
                  <span className="text-green-400 text-sm">Saved!</span>
                )}
              </div>
              {prefixError && (
                <p className="text-red-400 text-sm mt-1">{prefixError}</p>
              )}
            </div>

            {/* Current Prefix Display */}
            <div className="bg-gray-900/50 rounded-lg p-4">
              <p className="text-sm text-gray-300 mb-2">
                <span className="text-cyan-400 font-semibold">Current prefix:</span>{' '}
                <span className="font-mono text-cyan-400">{formatPrefixDisplay(quickCmdData?.prefix || '@')}</span>
              </p>
              <p className="text-sm text-gray-400">
                Type <span className="font-mono text-cyan-400">{quickCmdData?.prefix || '@'}alias</span> in game chat to trigger a quick command.
              </p>
            </div>

            {/* Instructions */}
            <div className="bg-gray-900/50 rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-300 mb-2">How Quick Commands Work</h3>
              <ul className="text-sm text-gray-400 space-y-1">
                <li>1. Set up a quick alias for a sound in My Sounds</li>
                <li>2. Type your prefix + alias in game chat (e.g., <span className="font-mono text-cyan-400">{quickCmdData?.prefix || '@'}lol</span>)</li>
                <li>3. Your sound plays and optional chat text appears</li>
              </ul>
            </div>

            {/* Blocked Prefixes Warning */}
            <div className="bg-yellow-900/20 border border-yellow-600/50 rounded-lg p-3">
              <p className="text-yellow-400 text-sm">
                <span className="font-medium">Blocked prefixes:</span>{' '}
                <span className="font-mono">!</span> (admin commands),{' '}
                <span className="font-mono">/</span> and <span className="font-mono">\</span> (console)
              </p>
            </div>

            {/* Quick Command Stats */}
            {quickCmdData?.aliases && quickCmdData.aliases.length > 0 && (
              <div className="text-sm text-gray-400">
                You have <span className="text-cyan-400 font-medium">{quickCmdData.aliases.length}</span> quick command{quickCmdData.aliases.length !== 1 ? 's' : ''} configured.
                <a href="/sounds" className="text-blue-400 hover:text-blue-300 ml-2">
                  Manage in My Sounds →
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
