import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createCanvasServer } from './app.mjs';
import { homedir } from 'node:os';
import { createWorkspaceService } from './workspace-service.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.indexOf('--port');
const port = Number(arg >= 0 ? process.argv[arg + 1] : process.env.CANVAS_PORT || 4178);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('CANVAS_PORT / --port must be an integer between 1024 and 65535');
const workspaceDataDir = resolve(process.env.CANVAS_WORKSPACE_DIR || resolve(process.env.LOCALAPPDATA || homedir(), 'XingpanSmartCanvas', 'workspace'));
const workspaceService = createWorkspaceService({ dataDir: workspaceDataDir });
const server = createCanvasServer({ staticDir: resolve(root, 'dist'), directorDir: resolve(root, '../../docs/minimax-video-ref/bundled-plugins/3d-director-stage'), workspaceService });
server.listen(port, '127.0.0.1', () => console.log(`星盘智能画布：http://127.0.0.1:${port}`));
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? '端口已占用，请使用 --port 指定另一个本机端口' : '本机服务启动失败'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
