import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
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
type Job = { uid: string; done: boolean; timer?: NodeJS.Timeout; targets: string[]; id: string; status: 'running' | 'done' | 'failed' | 'cancelled'; log: string; diags: Diag[]; proc?: ChildProcess; dir: string; js?: string; wasm?: string };
const jobs = new Map<string, Job>();
const uidOf = (k: string) => createHash('sha256').update(k).digest('hex').slice(0, 16);

const app = Fastify({ logger: true, bodyLimit: MAX_BYTES + 100000 });
const CORS = (process.env.CORS_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
if (!CORS.length) console.warn('CORS_ORIGIN is not set: cross-origin browser requests are blocked');
await app.register(cors, { origin: CORS.length ? CORS : false });
await app.register(rateLimit, { max: 60, timeWindow: '1 minute', keyGenerator: (req) => String(req.headers['x-api-key'] || req.ip) });
app.addHook('onRequest', async (req, reply) => {
  if (req.method === 'OPTIONS' || req.url === '/health') return;
  const k = String(req.headers['x-api-key'] || '');
  if (!KEYS.includes(k)) { reply.code(401).send({ error: 'unauthorized' }); return; }
  (req as any).uid = uidOf(k);
});
app.get('/health', async () => ({ ok: true }));

const U = (req: any) => (req as any).uid as string;
const pdir = (uid: string) => path.join(DATA, 'projects', uid);
const pfile = (uid: string, id: string) => path.join(pdir(uid), id + '.json');
const Body = z.object({ name: z.string().min(1).max(80), files: Files });
async function writeAtomic(f: string, data: string) { await mkdir(path.dirname(f), { recursive: true }); const t = f + '.' + randomUUID() + '.tmp'; await writeFile(t, data); await rename(t, f); }
app.get('/api/projects', async (req) => {
  await mkdir(pdir(U(req)), { recursive: true }); const out = [];
  for (const f of await readdir(pdir(U(req)))) if (f.endsWith('.json')) { try { const j = JSON.parse(await readFile(path.join(pdir(U(req)), f), 'utf8')); out.push({ id: f.slice(0, -5), name: j.name }); } catch {} }
  return out;
});
app.post('/api/projects', async (req, reply) => {
  const b = Body.parse(req.body); const id = randomUUID();
  await writeAtomic(pfile(U(req), id), JSON.stringify(b)); reply.code(201); return { id };
});
app.get('/api/projects/:id', async (req, reply) => {
  const { id } = z.object({ id: Id }).parse(req.params);
  try { return { id, ...JSON.parse(await readFile(pfile(U(req), id), 'utf8')) }; } catch { reply.code(404); return { error: 'not found' }; }
});
app.put('/api/projects/:id', async (req, reply) => {
  const { id } = z.object({ id: Id }).parse(req.params);
  const b = Body.parse(req.body);
  try { await readFile(pfile(U(req), id), 'utf8'); } catch { reply.code(404); return { error: 'not found' }; }
  await writeAtomic(pfile(U(req), id), JSON.stringify(b)); return { id };
});
app.delete('/api/projects/:id', async (req) => {
  const { id } = z.object({ id: Id }).parse(req.params);
  await rm(pfile(U(req), id), { force: true }); return { ok: true };
});

function parseDiags(log: string): Diag[] {
  const out: Diag[] = []; const re = /^([^\s:]+):(\d+):(\d+): (error|warning): (.*)$/gm; let m;
  while ((m = re.exec(log))) out.push({ file: m[1], line: +m[2], col: +m[3], severity: m[4] as Diag['severity'], message: m[5] });
  return out;
}
const stripC = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const hasMain = (s: string) => /\b(?:int|void)\s+main\s*\(/.test(stripC(s));
const BAD_INC = /#\s*include\s*[<"]\s*(\/|[^>"\n]*\.\.)/;
class HttpErr extends Error { constructor(public statusCode: number, m: string) { super(m); } }
function plan(files: Record<string, string>, entry: string | undefined, single: boolean) {
  const all = Object.keys(files).filter(f => /\.(cpp|cc|c)$/.test(f));
  if (!all.length) throw new HttpErr(400, 'no .c/.cpp files in project');
  for (const [f, c] of Object.entries(files)) if (/\.(c|cc|cpp|h|hpp)$/.test(f) && BAD_INC.test(c)) throw new HttpErr(400, 'unsafe #include (absolute path or ..) in ' + f);
  if (single) { if (!entry || !all.includes(entry)) throw new HttpErr(400, 'Run File needs an open .c/.cpp file'); return { srcs: [entry], entry }; }
  const mains = all.filter(f => hasMain(files[f]));
  if (!mains.length) throw new HttpErr(400, 'no main() found in any .c/.cpp file');
  const e = entry && mains.includes(entry) ? entry : mains.length === 1 ? mains[0] : '';
  if (!e) throw new HttpErr(400, 'several files define main(): ' + mains.join(', ') + '. Open the one you want to run, then press Build Project.');
  return { srcs: all.filter(f => !mains.includes(f) || f === e), entry: e };
}
function finish(job: Job, status: Job['status']) {
  if (job.done) return; job.done = true; job.status = status; clearTimeout(job.timer);
  try { process.kill(-job.proc!.pid!, 'SIGKILL'); } catch {}
  rm(job.dir, { recursive: true, force: true }).catch(() => {});
  setTimeout(() => jobs.delete(job.id), status === 'done' ? 10 * 60 * 1000 : 60 * 1000).unref();
}
app.post('/api/build', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
  const uid = U(req);
  if ([...jobs.values()].some(j => j.uid === uid && !j.done)) { reply.code(429); return { error: 'you already have a build running' }; }
  if ([...jobs.values()].filter(j => !j.done).length >= Number(process.env.MAX_JOBS || 2)) { reply.code(429); return { error: 'build queue full, try again shortly' }; }
  const { files, entry, single, debug } = z.object({ files: Files, entry: z.string().optional(), single: z.boolean().optional(), debug: z.boolean().optional() }).parse(req.body);
  const { srcs, entry: ent } = plan(files, entry, !!single);
  const id = randomUUID(); const dir = path.join('/tmp/work', id);
  for (const [p, c] of Object.entries(files)) { const fp = path.join(dir, p); await mkdir(path.dirname(fp), { recursive: true }); await writeFile(fp, c); }
  await mkdir(path.join(dir, 'out'), { recursive: true });
  const incs = [...new Set(Object.keys(files).filter(f => /\.(h|hpp)$/.test(f)).map(f => path.dirname(f)).concat(['.', 'include']))].map(d => '-I' + d);
  const job: Job = { id, uid, done: false, targets: srcs, status: 'running', log: '[plan] ' + (single ? 'single file' : 'project') + ', entry: ' + ent + '\n[plan] sources: ' + srcs.join(', ') + '\n', diags: [], dir };
  jobs.set(id, job);
  const add = (d: Buffer) => { job.log += d.toString(); if (job.log.length > 200000) job.log = job.log.slice(-200000); };
  const runCmd = (args: string[]) => new Promise<number>(resolve => {
    const proc = spawn('emcc', args, { cwd: dir, detached: true, env: { ...process.env, HOME: '/tmp', NODE_OPTIONS: '--max-old-space-size=768' } });
    job.proc = proc; proc.stdout.on('data', add); proc.stderr.on('data', add);
    proc.on('error', () => resolve(1)); proc.on('close', code => resolve(code ?? 1));
  });
  job.timer = setTimeout(() => { job.log += '\n[timeout] build exceeded ' + TIMEOUT_MS / 1000 + 's\n'; job.diags = parseDiags(job.log); finish(job, 'failed'); }, TIMEOUT_MS);
  const opt = debug ? ['-g', '-O0', '-sASSERTIONS=2'] : ['-O1'];
  (async () => {
    let ok = true; const objs: string[] = [];
    for (let i = 0; i < srcs.length && ok && !job.done; i++) {
      const lang = srcs[i].endsWith('.c') ? ['-std=c17'] : ['-std=c++20', '-fexceptions']; const o = 'out/' + i + '.o'; objs.push(o);
      ok = (await runCmd(['-c', srcs[i], '-o', o, ...opt, '-Wall', ...lang, ...incs, '-I/opt/raylib/src', '-DPLATFORM_WEB'])) === 0;
    }
    if (ok && !job.done) ok = (await runCmd([...objs, ...opt, '-fexceptions', '-L/opt/raylib/src', '-lraylib', '-sUSE_GLFW=3', '-sASYNCIFY', '-sALLOW_MEMORY_GROWTH=1',
      '-sTOTAL_MEMORY=67108864', '-sSTACK_SIZE=5242880', '-sEXIT_RUNTIME=1', '-sFORCE_FILESYSTEM=1', '-o', 'out/game.js'])) === 0;
    if (job.done) return;
    job.diags = parseDiags(job.log);
    if (ok) { try { job.js = (await readFile(path.join(dir, 'out/game.js'))).toString('base64'); job.wasm = (await readFile(path.join(dir, 'out/game.wasm'))).toString('base64'); } catch { ok = false; } }
    finish(job, ok ? 'done' : 'failed');
  })().catch(e => { job.log += '\n[internal] ' + e.message + '\n'; finish(job, 'failed'); });
  reply.code(202); return { id, targets: srcs, entry: ent };
});
const getJob = (req: any) => { const j = jobs.get(z.string().uuid().parse(req.params.id)); return j && j.uid === U(req) ? j : undefined; };
app.get('/api/build/:id', async (req, reply) => {
  const j = getJob(req); if (!j) { reply.code(404); return { error: 'unknown job' }; }
  return { id: j.id, status: j.status, log: j.log, diagnostics: j.diags, targets: j.targets };
});
app.post('/api/build/:id/cancel', async (req, reply) => {
  const j = getJob(req); if (!j) { reply.code(404); return { error: 'unknown job' }; }
  if (!j.done) finish(j, 'cancelled');
  return { status: j.status };
});
app.get('/api/build/:id/result', async (req, reply) => {
  const j = getJob(req);
  if (!j || j.status !== 'done') { reply.code(409); return { error: 'result not available' }; }
  return { js: j.js, wasm: j.wasm };
});
app.setErrorHandler((e, _r, reply) => { reply.code(e instanceof z.ZodError ? 400 : (e as any).statusCode || 500).send({ error: e instanceof z.ZodError ? 'invalid input: ' + e.issues[0]?.message : e.message }); });
await app.listen({ port: Number(process.env.PORT || 8080), host: '0.0.0.0' });
