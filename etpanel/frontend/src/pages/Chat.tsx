import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { console as consoleApi, type ConsolePlayer } from '../api/client';
import { useAuthStore } from '../stores/auth';

interface ChatMessage {
  id: string;
  timestamp: string;
  type: 'chat' | 'dm_sent' | 'dm_received' | 'system';
  player?: string;
  message: string;
  slot?: number;
  raw?: string;
}

function stripColors(text: string): string {
  return text.replace(/\^[0-9a-zA-Z]/g, '');
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', { hour12: false });
}

type TabType = 'chat' | 'dm';

export default function Chat() {
  const user = useAuthStore((s) => s.user);
  const [activeTab, setActiveTab] = useState<TabType>('chat');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [dmTarget, setDmTarget] = useState<ConsolePlayer | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const canSendDM = user?.role === 'admin' || user?.role === 'moderator';

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Fetch current players
  const { data: playersData } = useQuery({
    queryKey: ['consolePlayers'],
    queryFn: consoleApi.players,
    refetchInterval: 5000,
  });

  const players = playersData?.players || [];
  const humanPlayers = players.filter((p) => !p.isBot);

  // Send chat mutation
  const sendChatMutation = useMutation({
    mutationFn: consoleApi.say,
    onSuccess: (data) => {
      addMessage({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'chat',
        player: user?.displayName || 'You',
        message: data.message,
      });
      setInputMessage('');
    },
  });

  // Send DM mutation
  const sendDmMutation = useMutation({
    mutationFn: ({ slot, message }: { slot: number; message: string }) =>
      consoleApi.dm(slot, message),
    onSuccess: (data) => {
      addMessage({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: 'dm_sent',
        player: stripColors(data.targetName),
        message: data.message,
        slot: data.targetSlot,
      });
      setInputMessage('');
    },
  });

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => {
      const updated = [...prev, msg];
      if (updated.length > 500) {
        return updated.slice(-500);
      }
      return updated;
    });
  }, []);

  // WebSocket connection
  useEffect(() => {
    let isMounted = true;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    const wsUrl = import.meta.env.PROD
      ? `wss://${window.location.host}/ws`
      : 'ws://localhost:3000/ws';

    const connect = () => {
      if (!isMounted) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!isMounted) {
          ws.close();
          return;
        }
        setIsConnected(true);
        ws.send(JSON.stringify({ type: 'subscribe_console' }));
      };

      ws.onmessage = (event) => {
        if (!isMounted) return;
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'console_history') {
            // Filter for chat messages only
            const chatMessages: ChatMessage[] = data.data
              .filter((line: { raw?: string; type?: string }) => {
                if (!line.raw) return false;
                const rawLower = line.raw.toLowerCase();
                return rawLower.startsWith('say:') || rawLower.startsWith('sayteam:');
              })
              .map((line: { timestamp: string; player?: string; message?: string; raw: string }) => ({
                id: crypto.randomUUID(),
                timestamp: line.timestamp,
                type: 'chat' as const,
                player: line.player,
                message: line.message || line.raw,
                raw: line.raw,
              }));
            setMessages((prev) => [...chatMessages, ...prev]);
          }

          if (data.type === 'console_line') {
            const line = data.data;
            // Only process chat messages
            if (line.raw) {
              const rawLower = line.raw.toLowerCase();
              if (rawLower.startsWith('say:') || rawLower.startsWith('sayteam:')) {
                addMessage({
                  id: crypto.randomUUID(),
                  timestamp: line.timestamp,
                  type: 'chat',
                  player: line.player,
                  message: line.message || line.raw,
                  raw: line.raw,
                });
              }
            }
          }

          if (data.type === 'player_dm') {
            const msg = data.data;
            addMessage({
              id: crypto.randomUUID(),
              timestamp: msg.timestamp,
              type: 'dm_received',
              player: msg.name,
              message: msg.message,
              slot: msg.slot,
            });
          }
        } catch (err) {
          console.error('WebSocket message parse error:', err);
        }
      };

      ws.onclose = () => {
        if (!isMounted) return;
        setIsConnected(false);
        reconnectTimeout = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [addMessage]);

  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setAutoScroll(distanceFromBottom < 150);
  };

  useEffect(() => {
    if (autoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, autoScroll]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim()) return;

    if (activeTab === 'dm' && dmTarget && canSendDM) {
      sendDmMutation.mutate({ slot: dmTarget.slot, message: inputMessage.trim() });
    } else if (activeTab === 'chat') {
      sendChatMutation.mutate(inputMessage.trim());
    }
  };

  const selectPlayerForDM = (player: ConsolePlayer) => {
    setDmTarget(player);
    setActiveTab('dm');
  };

  // Filter messages based on active tab
  const filteredMessages = messages.filter((msg) => {
    if (activeTab === 'chat') {
      return msg.type === 'chat';
    }
    if (activeTab === 'dm') {
      if (!dmTarget) return msg.type === 'dm_sent' || msg.type === 'dm_received';
      // Show DMs for selected player
      return (msg.type === 'dm_sent' || msg.type === 'dm_received') &&
             (msg.slot === dmTarget.slot || stripColors(msg.player || '') === stripColors(dmTarget.name));
    }
    return true;
  });

  const getMessageStyle = (msg: ChatMessage) => {
    switch (msg.type) {
      case 'dm_received':
        return 'bg-orange-900/30 border-l-4 border-orange-500';
      case 'dm_sent':
        return 'bg-blue-900/30 border-l-4 border-blue-500';
      case 'chat':
        return 'bg-green-900/20';
      default:
        return '';
    }
  };

  return (
    <div className="h-[calc(100vh-8rem)] md:h-[calc(100vh-4rem)] flex flex-col">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl md:text-2xl font-bold">Chat</h1>
          <span
            className={`px-2 py-1 rounded text-xs font-medium ${
              isConnected ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
            }`}
          >
            {isConnected ? '● Live' : '○ Disconnected'}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-700 mb-4">
        <button
          onClick={() => setActiveTab('chat')}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'chat'
              ? 'text-orange-400 border-b-2 border-orange-400'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          💬 Game Chat
        </button>
        <button
          onClick={() => {
            setActiveTab('dm');
            if (!dmTarget && humanPlayers.length > 0) {
              setDmTarget(humanPlayers[0]);
            }
          }}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === 'dm'
              ? 'text-orange-400 border-b-2 border-orange-400'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          📩 Direct Messages
        </button>
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        {/* Players List - Half height */}
        <div className="h-1/2 md:h-2/5 bg-gray-800 rounded-lg overflow-hidden flex flex-col mb-4">
          <div className="p-3 bg-gray-900 border-b border-gray-700 flex-shrink-0">
            <h2 className="font-semibold text-sm">
              Online Players ({humanPlayers.length})
              {activeTab === 'dm' && canSendDM && (
                <span className="text-xs text-gray-400 ml-2">Select to DM</span>
              )}
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto p-2 hide-scrollbar">
            {humanPlayers.length === 0 ? (
              <div className="text-gray-500 text-center py-4 text-sm">
                No human players online
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                {humanPlayers.map((player) => (
                  <button
                    key={player.slot}
                    onClick={() => canSendDM && selectPlayerForDM(player)}
                    disabled={!canSendDM}
                    className={`text-left p-2 rounded transition-colors ${
                      dmTarget?.slot === player.slot
                        ? 'bg-orange-600/30 border border-orange-500'
                        : canSendDM
                        ? 'bg-gray-700 hover:bg-gray-600'
                        : 'bg-gray-700/50'
                    }`}
                  >
                    <div className="font-medium text-sm truncate">{stripColors(player.name)}</div>
                    <div className="text-xs text-gray-400 flex justify-between">
                      <span>#{player.slot}</span>
                      <span
                        className={
                          player.ping < 50
                            ? 'text-green-400'
                            : player.ping < 100
                            ? 'text-yellow-400'
                            : 'text-red-400'
                        }
                      >
                        {player.ping}ms
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Bots */}
            {players.filter((p) => p.isBot).length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-700">
                <div className="text-xs text-gray-500 mb-2">
                  Bots ({players.filter((p) => p.isBot).length})
                </div>
                <div className="flex flex-wrap gap-2">
                  {players.filter((p) => p.isBot).map((bot) => (
                    <span key={bot.slot} className="text-xs text-gray-500 bg-gray-700/50 px-2 py-1 rounded">
                      {stripColors(bot.name)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Messages - Half height */}
        <div className="flex-1 flex flex-col bg-gray-800 rounded-lg overflow-hidden min-h-0">
          {activeTab === 'dm' && dmTarget && (
            <div className="p-2 bg-gray-900 border-b border-gray-700 flex items-center justify-between">
              <span className="text-sm">
                DM with <span className="text-orange-400 font-medium">{stripColors(dmTarget.name)}</span>
              </span>
              <button
                onClick={() => setDmTarget(null)}
                className="text-xs text-gray-400 hover:text-white"
              >
                Show all DMs
              </button>
            </div>
          )}

          <div
            ref={messagesContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto p-3 font-mono text-sm"
          >
            {filteredMessages.length === 0 ? (
              <div className="text-gray-500 text-center py-8">
                {activeTab === 'chat' ? 'No chat messages yet...' : 'No direct messages yet...'}
              </div>
            ) : (
              filteredMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`py-1 px-2 rounded mb-1 ${getMessageStyle(msg)}`}
                >
                  <span className="text-gray-500 mr-2">{formatTime(msg.timestamp)}</span>
                  {msg.type === 'dm_received' && (
                    <span className="text-orange-400 mr-1">[from {stripColors(msg.player || '')}]</span>
                  )}
                  {msg.type === 'dm_sent' && (
                    <span className="text-blue-400 mr-1">[to {stripColors(msg.player || '')}]</span>
                  )}
                  {msg.type === 'chat' && msg.player && (
                    <span className="text-yellow-400 mr-1">{stripColors(msg.player)}:</span>
                  )}
                  <span className="text-gray-200">{stripColors(msg.message)}</span>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <form onSubmit={handleSend} className="p-3 bg-gray-900 border-t border-gray-700">
            <div className="flex gap-2">
              <input
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                placeholder={
                  activeTab === 'dm' && dmTarget
                    ? `Message ${stripColors(dmTarget.name)}...`
                    : activeTab === 'dm'
                    ? 'Select a player to DM...'
                    : 'Type a message to all players...'
                }
                className="flex-1 bg-gray-700 rounded px-3 py-2.5 md:py-2 text-base md:text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                disabled={
                  sendChatMutation.isPending ||
                  sendDmMutation.isPending ||
                  (activeTab === 'dm' && (!dmTarget || !canSendDM))
                }
              />
              <button
                type="submit"
                disabled={
                  sendChatMutation.isPending ||
                  sendDmMutation.isPending ||
                  !inputMessage.trim() ||
                  (activeTab === 'dm' && (!dmTarget || !canSendDM))
                }
                className="px-4 py-2.5 md:py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
              >
                {sendChatMutation.isPending || sendDmMutation.isPending ? '...' : 'Send'}
              </button>
            </div>
            {activeTab === 'chat' && (
              <p className="text-xs text-gray-500 mt-1 hidden md:block">
                Messages are delivered live to all players in-game
              </p>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
