import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const KEYS = (process.env.API_KEYS || process.env.API_KEY || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA = process.env.DATA_DIR || '/data';
const TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 120000);
const MAX_BYTES = 2 * 1024 * 1024;
if (!KEYS.length) { console.error('API_KEYS is required'); process.exit(1); }

const Files = z.record(z.string().regex(/^[A-Za-z0-9_./-]{1,200}$/).refine(p => !p.includes('..') && !p.startsWith('/')), z.string())
  .refine(f => Object.values(f).reduce((a, s) => a + s.length, 0) <= MAX_BYTES && Object.keys(f).length <= 200, 'project too large');
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

type Diag = { file: string; line: number; col: number; severity: 'error' | 'warning'; message: string };
type Job = { id: string; status: 'running' | 'done' | 'failed' | 'cancelled'; log: string; diags: Diag[]; proc?: ChildProcess; dir: string; js?: string; wasm?: string };
const jobs = new Map<string, Job>();

const app = Fastify({ logger: true, bodyLimit: MAX_BYTES + 100000 });
await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',') || true });
await app.register(rateLimit, { max: 60, timeWindow: '1 minute', keyGenerator: (req) => String(req.headers['x-api-key'] || req.ip) });
app.addHook('onRequest', async (req, reply) => {
  if (req.method === 'OPTIONS' || req.url === '/health') return;
  if (!KEYS.includes(String(req.headers['x-api-key'] || ''))) reply.code(401).send({ error: 'unauthorized' });
});
app.get('/health', async () => ({ ok: true }));

const pfile = (id: string) => path.join(DATA, 'projects', id + '.json');
app.get('/api/projects', async () => {
  await mkdir(path.join(DATA, 'projects'), { recursive: true });
  return (await readdir(path.join(DATA, 'projects'))).map(f => f.replace('.json', ''));
});
app.post('/api/projects', async (req, reply) => {
  const b = z.object({ name: z.string().max(80), files: Files }).parse(req.body);
  const id = randomUUID();
  await mkdir(path.join(DATA, 'projects'), { recursive: true });
  await writeFile(pfile(id), JSON.stringify(b)); reply.code(201); return { id };
});
app.get('/api/projects/:id', async (req, reply) => {
  const { id } = z.object({ id: Id }).parse(req.params);
  try { return JSON.parse(await readFile(pfile(id), 'utf8')); } catch { reply.code(404); return { error: 'not found' }; }
});
app.put('/api/projects/:id', async (req) => {
  const { id } = z.object({ id: Id }).parse(req.params);
  const b = z.object({ name: z.string().max(80), files: Files }).parse(req.body);
  await mkdir(path.join(DATA, 'projects'), { recursive: true });
  await writeFile(pfile(id), JSON.stringify(b)); return { id };
});
app.delete('/api/projects/:id', async (req) => {
  const { id } = z.object({ id: Id }).parse(req.params);
  await rm(pfile(id), { force: true }); return { ok: true };
});

function parseDiags(log: string): Diag[] {
  const out: Diag[] = []; const re = /^([^\s:]+):(\d+):(\d+): (error|warning): (.*)$/gm; let m;
  while ((m = re.exec(log))) out.push({ file: m[1], line: +m[2], col: +m[3], severity: m[4] as Diag['severity'], message: m[5] });
  return out;
}
app.post('/api/build', async (req, reply) => {
  if ([...jobs.values()].filter(j => j.status === 'running').length >= Number(process.env.MAX_JOBS || 2)) { reply.code(429); return { error: 'build queue full, try again shortly' }; }
  const { files, entry } = z.object({ files: Files, entry: z.string().optional() }).parse(req.body);
  let srcs = Object.keys(files).filter(f => /\.(cpp|cc|c)$/.test(f));
  if (entry !== undefined) { if (!srcs.includes(entry)) { reply.code(400); return { error: 'entry must be an existing .c/.cpp file' }; } srcs = [entry]; }
  if (!srcs.length) { reply.code(400); return { error: 'no .cpp/.c files in project' }; }
  const id = randomUUID(); const dir = path.join('/tmp/work', id);
  for (const [p, c] of Object.entries(files)) { const fp = path.join(dir, p); await mkdir(path.dirname(fp), { recursive: true }); await writeFile(fp, c); }
  await mkdir(path.join(dir, 'out'), { recursive: true });
  const incs = [...new Set(Object.keys(files).filter(f => /\.(h|hpp)$/.test(f)).map(f => path.dirname(f)).concat(['.', 'include']))].map(d => '-I' + d);
  const job: Job = { id, status: 'running', log: '', diags: [], dir };
  jobs.set(id, job);
  const add = (d: Buffer) => { job.log += d.toString(); if (job.log.length > 200000) job.log = job.log.slice(-200000); };
  const runCmd = (args: string[]) => new Promise<number>(resolve => {
    const proc = spawn('emcc', args, { cwd: dir, detached: true, env: { ...process.env, HOME: '/tmp' } });
    job.proc = proc; proc.stdout.on('data', add); proc.stderr.on('data', add);
    proc.on('error', () => resolve(1)); proc.on('close', code => resolve(code ?? 1));
  });
  const timer = setTimeout(() => { job.log += '\n[timeout] build exceeded limit\n'; job.status = 'failed'; try { process.kill(-job.proc!.pid!, 'SIGKILL'); } catch {} }, TIMEOUT_MS);
  (async () => {
    let ok = true; const objs: string[] = [];
    for (let i = 0; i < srcs.length && ok; i++) {
      const isC = srcs[i].endsWith('.c'); const o = 'out/' + i + '.o'; objs.push(o);
      const lang = isC ? ['-std=c17'] : ['-std=c++20', '-fexceptions'];
      ok = (await runCmd(['-c', srcs[i], '-o', o, '-O1', '-Wall', ...lang, ...incs, '-I/opt/raylib/src', '-DPLATFORM_WEB'])) === 0 && job.status === 'running';
    }
    if (ok) ok = (await runCmd([...objs, '-fexceptions', '-L/opt/raylib/src', '-lraylib', '-sUSE_GLFW=3', '-sASYNCIFY', '-sALLOW_MEMORY_GROWTH=1',
      '-sTOTAL_MEMORY=67108864', '-sSTACK_SIZE=5242880', '-sEXIT_RUNTIME=1', '-o', 'out/game.js'])) === 0 && job.status === 'running';
    clearTimeout(timer); job.diags = parseDiags(job.log);
    if (job.status === 'cancelled') return;
    if (ok) {
      job.js = (await readFile(path.join(dir, 'out/game.js'))).toString('base64');
      job.wasm = (await readFile(path.join(dir, 'out/game.wasm'))).toString('base64'); job.status = 'done';
    } else job.status = 'failed';
    rm(dir, { recursive: true, force: true }).catch(() => {});
    setTimeout(() => jobs.delete(id), 10 * 60 * 1000);
  })();
  reply.code(202); return { id };
});
const getJob = (id: string) => jobs.get(z.string().uuid().parse(id));
app.get('/api/build/:id', async (req, reply) => {
  const j = getJob((req.params as any).id); if (!j) { reply.code(404); return { error: 'unknown job' }; }
  return { id: j.id, status: j.status, log: j.log, diagnostics: j.diags };
});
app.post('/api/build/:id/cancel', async (req, reply) => {
  const j = getJob((req.params as any).id); if (!j) { reply.code(404); return { error: 'unknown job' }; }
  if (j.status === 'running') { j.status = 'cancelled'; try { process.kill(-j.proc!.pid!, 'SIGKILL'); } catch {} rm(j.dir, { recursive: true, force: true }).catch(() => {}); }
  return { status: j.status };
});
app.get('/api/build/:id/result', async (req, reply) => {
  const j = getJob((req.params as any).id);
  if (!j || j.status !== 'done') { reply.code(409); return { error: 'result not available' }; }
  return { js: j.js, wasm: j.wasm };
});
app.setErrorHandler((e, _r, reply) => { reply.code(e instanceof z.ZodError ? 400 : (e as any).statusCode || 500).send({ error: e instanceof z.ZodError ? 'invalid input: ' + e.issues[0]?.message : e.message }); });
await app.listen({ port: Number(process.env.PORT || 8080), host: '0.0.0.0' });
