import dgram from 'dgram';
import { config } from '../config.js';

const RCON_HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

export interface RconResponse {
  success: boolean;
  response: string;
  error?: string;
}

export async function sendRcon(command: string): Promise<RconResponse> {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const timeout = setTimeout(() => {
      client.close();
      resolve({ success: false, response: '', error: 'Timeout' });
    }, 5000);

    const message = Buffer.concat([
      RCON_HEADER,
      Buffer.from(`rcon ${config.ET_RCON_PASSWORD} ${command}`),
    ]);

    client.on('message', (msg) => {
      clearTimeout(timeout);
      client.close();

      // Skip the 4-byte header and "print\n" prefix
      const response = msg.slice(4).toString('utf8').replace(/^print\n/, '').trim();
      resolve({ success: true, response });
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      client.close();
      resolve({ success: false, response: '', error: err.message });
    });

    client.send(message, config.ET_SERVER_PORT, config.ET_SERVER_HOST, (err) => {
      if (err) {
        clearTimeout(timeout);
        client.close();
        resolve({ success: false, response: '', error: err.message });
      }
    });
  });
}

export async function getServerStatus(): Promise<{
  online: boolean;
  map?: string;
  players?: number;
  maxPlayers?: number;
  hostname?: string;
}> {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const timeout = setTimeout(() => {
      client.close();
      resolve({ online: false });
    }, 3000);

    const message = Buffer.concat([RCON_HEADER, Buffer.from('getstatus')]);

    client.on('message', (msg) => {
      clearTimeout(timeout);
      client.close();

      const response = msg.slice(4).toString('utf8');
      const lines = response.split('\n');

      if (lines.length < 2) {
        resolve({ online: false });
        return;
      }

      // Parse server info from first line (key\value pairs)
      const infoLine = lines[1];
      const info: Record<string, string> = {};
      const parts = infoLine.split('\\').slice(1);
      for (let i = 0; i < parts.length; i += 2) {
        info[parts[i]] = parts[i + 1] || '';
      }

      // Count players (remaining lines are player info)
      const playerCount = lines.slice(2).filter((line) => line.trim()).length;

      resolve({
        online: true,
        map: info.mapname,
        hostname: info.sv_hostname,
        players: playerCount,
        maxPlayers: parseInt(info.sv_maxclients) || 16,
      });
    });

    client.on('error', () => {
      clearTimeout(timeout);
      client.close();
      resolve({ online: false });
    });

    client.send(message, config.ET_SERVER_PORT, config.ET_SERVER_HOST);
  });
}

// Send multiple RCON commands sequentially
export async function sendRconMultiple(commands: string[]): Promise<RconResponse> {
  const responses: string[] = [];
  let allSuccess = true;

  for (const cmd of commands) {
    const result = await sendRcon(cmd);
    if (!result.success) {
      allSuccess = false;
      if (result.error) responses.push(`Error: ${result.error}`);
    } else if (result.response) {
      responses.push(result.response);
    }
    // Small delay between commands to let server process
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return {
    success: allSuccess,
    response: responses.join('\n'),
  };
}

export async function getPlayers(): Promise<
  Array<{
    slot: number;
    name: string;
    score: number;
    ping: number;
  }>
> {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    const timeout = setTimeout(() => {
      client.close();
      resolve([]);
    }, 3000);

    const message = Buffer.concat([RCON_HEADER, Buffer.from('getstatus')]);

    client.on('message', (msg) => {
      clearTimeout(timeout);
      client.close();

      const response = msg.slice(4).toString('utf8');
      const lines = response.split('\n').slice(2); // Skip header and server info

      const players = lines
        .filter((line) => line.trim())
        .map((line, index) => {
          // Format: "score ping \"name\""
          const match = line.match(/(\d+)\s+(\d+)\s+"(.*)"/);
          if (match) {
            return {
              slot: index,
              score: parseInt(match[1]),
              ping: parseInt(match[2]),
              name: match[3],
            };
          }
          return null;
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      resolve(players);
    });

    client.on('error', () => {
      clearTimeout(timeout);
      client.close();
      resolve([]);
    });

    client.send(message, config.ET_SERVER_PORT, config.ET_SERVER_HOST);
  });
}
