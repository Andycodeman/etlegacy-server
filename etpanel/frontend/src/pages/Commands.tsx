import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { admin } from '../api/client';
import type { AdminCommand } from '../api/client';

function getLevelColor(level: number): string {
  switch (level) {
    case 0: return 'text-gray-400';
    case 1: return 'text-gray-300';
    case 2: return 'text-blue-400';
    case 3: return 'text-green-400';
    case 4: return 'text-yellow-400';
    case 5: return 'text-red-400';
    default: return 'text-gray-400';
  }
}

function getLevelBg(level: number): string {
  switch (level) {
    case 0: return 'bg-gray-500/20 border-gray-500/30';
    case 1: return 'bg-gray-400/20 border-gray-400/30';
    case 2: return 'bg-blue-500/20 border-blue-500/30';
    case 3: return 'bg-green-500/20 border-green-500/30';
    case 4: return 'bg-yellow-500/20 border-yellow-500/30';
    case 5: return 'bg-red-500/20 border-red-500/30';
    default: return 'bg-gray-500/20 border-gray-500/30';
  }
}

interface ExecutionResult {
  success: boolean;
  message: string;
  response?: string;
  needsInGame?: boolean;
  note?: string;
}

export default function Commands() {
  const [selectedCommand, setSelectedCommand] = useState<AdminCommand | null>(null);
  const [args, setArgs] = useState('');
  const [result, setResult] = useState<ExecutionResult | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'availableCommands'],
    queryFn: admin.availableCommands,
  });

  const executeMutation = useMutation({
    mutationFn: ({ command, args }: { command: string; args?: string }) =>
      admin.executeCommand(command, args || undefined),
    onSuccess: (data) => {
      setResult({
        success: data.success,
        message: data.message,
        response: data.response,
        needsInGame: data.needsInGame,
        note: data.note,
      });
    },
    onError: (err: Error) => {
      setResult({ success: false, message: err.message });
    },
  });

  const handleExecute = () => {
    if (!selectedCommand) return;
    setResult(null);
    executeMutation.mutate({ command: selectedCommand.name, args: args.trim() || undefined });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading commands...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/30 border border-red-500 rounded-lg p-4">
        <p className="text-red-400">Failed to load commands</p>
      </div>
    );
  }

  const commands = data?.commands || [];
  const userLevel = data?.userLevel ?? 0;
  const userGuid = data?.userGuid;

  // Group commands by level
  const commandsByLevel: Record<number, AdminCommand[]> = {};
  commands.forEach((cmd) => {
    if (!commandsByLevel[cmd.defaultLevel]) {
      commandsByLevel[cmd.defaultLevel] = [];
    }
    commandsByLevel[cmd.defaultLevel].push(cmd);
  });

  const levels = Object.keys(commandsByLevel)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Execute Commands</h1>
          <p className="text-gray-400 text-sm mt-1">
            Run !commands on the server based on your admin level
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-gray-400">Your Level:</span>
          <span className={`px-3 py-1 rounded font-medium ${getLevelColor(userLevel)} ${getLevelBg(userLevel)} border`}>
            {userLevel}
          </span>
        </div>
      </div>

      {!userGuid && (
        <div className="bg-yellow-900/30 border border-yellow-500/50 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <h3 className="font-semibold text-yellow-400">Game Account Not Linked</h3>
              <p className="text-gray-300 text-sm mt-1">
                To execute commands, you need to link your game account.
                Run <code className="bg-gray-700 px-1 rounded">/etman register</code> in-game to get a verification code.
              </p>
            </div>
          </div>
        </div>
      )}

      {commands.length === 0 && userGuid && (
        <div className="bg-gray-800 rounded-lg p-6 text-center">
          <div className="text-4xl mb-3">🔒</div>
          <h3 className="font-semibold text-gray-300">No Commands Available</h3>
          <p className="text-gray-400 text-sm mt-1">
            Your admin level ({userLevel}) doesn't have access to any commands.
          </p>
        </div>
      )}

      {/* Command Execution Panel */}
      {selectedCommand && (
        <div className="bg-gray-800 rounded-lg p-4 md:p-6 border border-orange-500/50">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <span className="text-orange-400">!{selectedCommand.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded ${getLevelBg(selectedCommand.defaultLevel)} ${getLevelColor(selectedCommand.defaultLevel)} border`}>
                  Level {selectedCommand.defaultLevel}
                </span>
              </h2>
              {selectedCommand.description && (
                <p className="text-gray-400 text-sm mt-1">{selectedCommand.description}</p>
              )}
              {selectedCommand.usage && (
                <p className="text-gray-500 text-xs font-mono mt-1">{selectedCommand.usage}</p>
              )}
            </div>
            <button
              onClick={() => {
                setSelectedCommand(null);
                setArgs('');
                setResult(null);
              }}
              className="text-gray-400 hover:text-white"
            >
              ✕
            </button>
          </div>

          <div className="mt-4 flex gap-2">
            <div className="flex-1 flex items-center bg-gray-700 rounded px-3 py-2">
              <span className="text-orange-400 mr-2">!{selectedCommand.name}</span>
              <input
                type="text"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleExecute()}
                placeholder="arguments (optional)"
                className="flex-1 bg-transparent text-white placeholder-gray-500 focus:outline-none"
                autoFocus
              />
            </div>
            <button
              onClick={handleExecute}
              disabled={executeMutation.isPending || !userGuid}
              className="px-6 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 rounded font-medium transition-colors"
            >
              {executeMutation.isPending ? 'Executing...' : 'Execute'}
            </button>
          </div>

          {result && (
            <div className="mt-3 space-y-2">
              {/* Command sent indicator */}
              <div className={`p-3 rounded ${result.success ? 'bg-green-500/20 border border-green-500/30' : 'bg-red-500/20 border border-red-500/30'}`}>
                <div className="flex items-center gap-2">
                  <span className={result.success ? 'text-green-400' : 'text-red-400'}>
                    {result.success ? '✓' : '✗'}
                  </span>
                  <span className="text-white font-mono">{result.message}</span>
                </div>
                {result.note && (
                  <p className="text-gray-400 text-sm mt-1">{result.note}</p>
                )}
              </div>

              {/* Console response */}
              {result.response && (
                <div className="bg-gray-900 rounded border border-gray-700 p-3">
                  <div className="flex items-center gap-2 mb-2 text-gray-400 text-xs">
                    <span>📟</span>
                    <span>Server Response:</span>
                  </div>
                  <pre className="text-green-400 font-mono text-sm whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">
                    {result.response}
                  </pre>
                </div>
              )}

              {/* In-game notice */}
              {result.needsInGame && !result.response && (
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded p-3">
                  <p className="text-yellow-400 text-sm">
                    ⚠️ This command requires player name matching. For full functionality, execute it in-game.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Command List */}
      <div className="space-y-4">
        {levels.map((level) => (
          <div key={level} className="bg-gray-800 rounded-lg p-4">
            <h3 className={`font-semibold mb-3 ${getLevelColor(level)}`}>
              Level {level} Commands
            </h3>
            <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {commandsByLevel[level].map((cmd) => (
                <button
                  key={cmd.id}
                  onClick={() => {
                    setSelectedCommand(cmd);
                    setArgs('');
                    setResult(null);
                  }}
                  className={`text-left p-3 rounded border transition-all ${
                    selectedCommand?.id === cmd.id
                      ? 'bg-orange-600/30 border-orange-500'
                      : 'bg-gray-700 border-gray-600 hover:bg-gray-600 hover:border-gray-500'
                  }`}
                >
                  <div className="text-orange-400 font-mono font-medium">!{cmd.name}</div>
                  {cmd.description && (
                    <div className="text-gray-400 text-xs mt-1 line-clamp-2">{cmd.description}</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Recent Commands (could be expanded) */}
      <div className="text-xs text-gray-500 text-center pt-4">
        Commands executed via ETPanel are logged to the admin_command_log table.
      </div>
    </div>
  );
}
