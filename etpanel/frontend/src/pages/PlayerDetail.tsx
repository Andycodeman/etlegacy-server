import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, Link, useLocation } from 'react-router-dom';
import { players } from '../api/client';

function stripColors(text: string): string {
  return text.replace(/\^[0-9a-zA-Z]/g, '');
}

function formatPlaytime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatWeaponName(weapon: string): string {
  // Convert MOD_MP40 to "MP40", MOD_KNIFE to "Knife", etc.
  return weapon
    .replace('MOD_', '')
    .split('_')
    .map(w => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

export default function PlayerDetail() {
  const { guid } = useParams<{ guid: string }>();
  const location = useLocation();
  const isPublicRoute = location.pathname.startsWith('/stats');
  const basePath = isPublicRoute ? '/stats' : '/players';
  const [activeTab, setActiveTab] = useState<'opponents' | 'weapons'>('opponents');
  const [searchOpponent, setSearchOpponent] = useState('');

  const { data: player, isLoading: playerLoading } = useQuery({
    queryKey: ['player', guid],
    queryFn: () => players.get(guid!),
    enabled: !!guid,
  });

  const { data: matchupsData, isLoading: matchupsLoading } = useQuery({
    queryKey: ['playerMatchups', guid],
    queryFn: () => players.matchups(guid!),
    enabled: !!guid,
  });

  const { data: weaponStats, isLoading: weaponsLoading } = useQuery({
    queryKey: ['playerWeapons', guid],
    queryFn: () => players.weapons(guid!),
    enabled: !!guid,
  });

  const wrapperClass = isPublicRoute ? 'min-h-screen bg-gray-900 p-8' : '';

  if (playerLoading) {
    return (
      <div className={`flex items-center justify-center h-64 ${wrapperClass}`}>
        <div className="text-gray-400">Loading player...</div>
      </div>
    );
  }

  if (!player) {
    return (
      <div className={`text-center py-12 ${wrapperClass}`}>
        <h1 className="text-2xl font-bold text-red-400">Player Not Found</h1>
        <p className="text-gray-400 mt-2">The player you're looking for doesn't exist.</p>
        <Link to={basePath} className="text-blue-400 hover:underline mt-4 inline-block">
          Back to Players
        </Link>
      </div>
    );
  }

  const filteredMatchups = matchupsData?.matchups.filter(m =>
    stripColors(m.opponentName).toLowerCase().includes(searchOpponent.toLowerCase())
  ) ?? [];

  const humanKD = player.deaths > 0 ? (player.kills / player.deaths).toFixed(2) : player.kills.toString();
  const botKD = player.botDeaths > 0 ? (player.botKills / player.botDeaths).toFixed(2) : player.botKills.toString();

  return (
    <div className={`space-y-6 ${wrapperClass}`}>
      {/* Back link */}
      <Link to={basePath} className="text-blue-400 hover:underline text-sm">
        &larr; Back to Players
      </Link>

      {/* Player header */}
      <div className="bg-gray-800 rounded-lg p-6">
        <h1 className="text-3xl font-bold mb-4">{stripColors(player.name)}</h1>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-gray-700/50 rounded p-4">
            <div className="text-gray-400 text-sm">Human K/D</div>
            <div className="text-2xl font-bold">
              <span className="text-green-400">{player.kills}</span>
              <span className="text-gray-500"> / </span>
              <span className="text-red-400">{player.deaths}</span>
            </div>
            <div className="text-gray-400 text-sm">Ratio: {humanKD}</div>
          </div>

          <div className="bg-gray-700/50 rounded p-4">
            <div className="text-gray-400 text-sm">Bot K/D</div>
            <div className="text-2xl font-bold">
              <span className="text-green-400">{player.botKills}</span>
              <span className="text-gray-500"> / </span>
              <span className="text-red-400">{player.botDeaths}</span>
            </div>
            <div className="text-gray-400 text-sm">Ratio: {botKD}</div>
          </div>

          <div className="bg-gray-700/50 rounded p-4">
            <div className="text-gray-400 text-sm">Suicides</div>
            <div className="text-2xl font-bold text-yellow-400">{player.suicides}</div>
          </div>

          <div className="bg-gray-700/50 rounded p-4">
            <div className="text-gray-400 text-sm">Playtime</div>
            <div className="text-2xl font-bold">{formatPlaytime(player.playtimeSeconds)}</div>
            <div className="text-gray-400 text-sm">
              Since {new Date(player.firstSeen).toLocaleDateString()}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTab('opponents')}
          className={`px-4 py-2 rounded ${
            activeTab === 'opponents'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Opponents ({matchupsData?.matchups.length ?? 0})
        </button>
        <button
          onClick={() => setActiveTab('weapons')}
          className={`px-4 py-2 rounded ${
            activeTab === 'weapons'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Weapons ({weaponStats?.length ?? 0})
        </button>
      </div>

      {/* Opponents Tab */}
      {activeTab === 'opponents' && (
        <div className="bg-gray-800 rounded-lg p-6">
          <div className="mb-4">
            <input
              type="text"
              placeholder="Search opponents..."
              value={searchOpponent}
              onChange={(e) => setSearchOpponent(e.target.value)}
              className="w-full md:w-64 bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
            />
          </div>

          {matchupsLoading ? (
            <div className="text-gray-400">Loading matchups...</div>
          ) : filteredMatchups.length === 0 ? (
            <div className="text-gray-400 text-center py-8">
              {searchOpponent ? 'No opponents found' : 'No matchup data yet'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-700">
                    <th className="pb-3 pr-4">Opponent</th>
                    <th className="pb-3 pr-4">Type</th>
                    <th className="pb-3 pr-4">Kills</th>
                    <th className="pb-3 pr-4">Deaths</th>
                    <th className="pb-3 pr-4">K/D</th>
                    <th className="pb-3 pr-4">Team Kills</th>
                    <th className="pb-3">Top Weapons</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMatchups.map((matchup) => {
                    const kd = matchup.totalDeaths > 0
                      ? (matchup.totalKills / matchup.totalDeaths).toFixed(2)
                      : matchup.totalKills.toString();

                    const topWeapons = matchup.weapons
                      .sort((a, b) => (b.kills + b.deaths) - (a.kills + a.deaths))
                      .slice(0, 3)
                      .map(w => formatWeaponName(w.weapon));

                    return (
                      <tr key={matchup.opponentGuid} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                        <td className="py-3 pr-4 font-medium">
                          {matchup.opponentIsBot ? (
                            <span className="text-purple-400">{stripColors(matchup.opponentName)}</span>
                          ) : (
                            <Link
                              to={`${basePath}/${matchup.opponentGuid}`}
                              className="text-blue-400 hover:text-blue-300 hover:underline"
                            >
                              {stripColors(matchup.opponentName)}
                            </Link>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          {matchup.opponentIsBot ? (
                            <span className="text-purple-400 text-sm">Bot</span>
                          ) : (
                            <span className="text-blue-400 text-sm">Human</span>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-green-400">{matchup.totalKills}</td>
                        <td className="py-3 pr-4 text-red-400">{matchup.totalDeaths}</td>
                        <td className="py-3 pr-4 text-gray-300">{kd}</td>
                        <td className="py-3 pr-4">
                          {matchup.totalTeamKills > 0 || matchup.totalTeamDeaths > 0 ? (
                            <span className="text-orange-400">
                              {matchup.totalTeamKills} / {matchup.totalTeamDeaths}
                            </span>
                          ) : (
                            <span className="text-gray-500">-</span>
                          )}
                        </td>
                        <td className="py-3 text-gray-400 text-sm">
                          {topWeapons.join(', ') || '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Weapons Tab */}
      {activeTab === 'weapons' && (
        <div className="bg-gray-800 rounded-lg p-6">
          {weaponsLoading ? (
            <div className="text-gray-400">Loading weapon stats...</div>
          ) : !weaponStats || weaponStats.length === 0 ? (
            <div className="text-gray-400 text-center py-8">No weapon data yet</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-700">
                    <th className="pb-3 pr-4">Weapon</th>
                    <th className="pb-3 pr-4">Kills</th>
                    <th className="pb-3 pr-4">Deaths</th>
                    <th className="pb-3 pr-4">K/D</th>
                    <th className="pb-3 pr-4">Team Kills</th>
                    <th className="pb-3">Team Deaths</th>
                  </tr>
                </thead>
                <tbody>
                  {weaponStats.map((weapon) => {
                    const kd = weapon.deaths > 0
                      ? (weapon.kills / weapon.deaths).toFixed(2)
                      : weapon.kills.toString();

                    return (
                      <tr key={weapon.weapon} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                        <td className="py-3 pr-4 font-medium">{formatWeaponName(weapon.weapon)}</td>
                        <td className="py-3 pr-4 text-green-400">{weapon.kills}</td>
                        <td className="py-3 pr-4 text-red-400">{weapon.deaths}</td>
                        <td className="py-3 pr-4 text-gray-300">{kd}</td>
                        <td className="py-3 pr-4">
                          {weapon.teamKills > 0 ? (
                            <span className="text-orange-400">{weapon.teamKills}</span>
                          ) : (
                            <span className="text-gray-500">-</span>
                          )}
                        </td>
                        <td className="py-3">
                          {weapon.teamDeaths > 0 ? (
                            <span className="text-orange-400">{weapon.teamDeaths}</span>
                          ) : (
                            <span className="text-gray-500">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
