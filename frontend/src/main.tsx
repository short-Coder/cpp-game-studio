import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor from '@monaco-editor/react';
import { get, set } from 'idb-keyval';
import JSZip from 'jszip';
import { SAMPLE } from './sample';
import './style.css';

type Files = Record<string, string>;
type Diag = { file: string; line: number; col: number; severity: 'error' | 'warning'; message: string };
type View = 'explorer' | 'search' | 'settings';
const lang = (p: string) => p.endsWith('.c') ? 'c' : /\.(cpp|cc|h|hpp)$/.test(p) ? 'cpp' : p.endsWith('.json') ? 'json' : p.endsWith('.md') ? 'markdown' : 'plaintext';
const ls = (k: string, d: string) => localStorage.getItem(k) ?? d;
const conf = () => ({ url: ls('url', (import.meta.env.VITE_API_URL as string) || ''), key: ls('key', '') });
async function api(p: string, init: RequestInit = {}) {
  const c = conf(); if (!c.url) throw new Error('Backend URL not set (Settings)');
  const url = c.url.trim().replace(/\/$/, '') + p;
  let r: Response;
  try { r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', 'x-api-key': c.key.trim() } }); }
  catch (e: any) { throw new Error('Cannot reach ' + url + ' (' + (e?.message || 'network/CORS') + ')'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status + ' ' + (j.error || j.message || r.statusText || 'no message'));
  return j;
}
const OKPATH = /^[A-Za-z0-9_./-]+$/;
const previewDoc = (js: string, wasm: string, inp = '') => `<!doctype html><body style="margin:0;background:#000"><canvas id="c" style="width:100%;height:100%;touch-action:none" oncontextmenu="return false"></canvas><script>
const b=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const w=URL.createObjectURL(new Blob([b("${wasm}")],{type:'application/wasm'}));
const L=t=>parent.postMessage({log:String(t)},'*');
var IN=${JSON.stringify(inp && !inp.endsWith('\n') ? inp + '\n' : inp).replace(/</g, '\\u003c')},ip=0;
function SI(){if(ip>=IN.length){L('[waiting for input]');var l=prompt('Program is waiting for input (Cancel = end of input)');if(l===null)return null;IN=l+'\n';ip=0;L('[input] '+l);}return IN.charCodeAt(ip++);}
window.Module={canvas:document.getElementById('c'),locateFile:()=>w,print:L,printErr:t=>L('[stderr] '+t),stdin:SI,onAbort:t=>L('ABORT: '+t),
onExit:c=>L('[program exited with code '+c+']')};
window.onerror=m=>L('JS error: '+m);
const s=document.createElement('script');s.src=URL.createObjectURL(new Blob([b("${js}")],{type:'text/javascript'}));document.body.appendChild(s);
</script></body>`;

const SNIPS: [string, string][] = [
  ['main', 'int main() {\n\t${1}\n\treturn 0;\n}'], ['for', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ++${1:i}) {\n\t${3}\n}'],
  ['rfor', 'for (auto& ${1:x} : ${2:container}) {\n\t${3}\n}'], ['while', 'while (${1:cond}) {\n\t${2}\n}'],
  ['if', 'if (${1:cond}) {\n\t${2}\n}'], ['ifelse', 'if (${1:cond}) {\n\t${2}\n} else {\n\t${3}\n}'],
  ['switch', 'switch (${1:x}) {\ncase ${2:0}:\n\t${3}\n\tbreak;\ndefault:\n\tbreak;\n}'],
  ['class', 'class ${1:Name} {\npublic:\n\t${1:Name}();\n\t~${1:Name}();\nprivate:\n\t${2}\n};'], ['struct', 'struct ${1:Name} {\n\t${2}\n};'],
  ['inc', '#include <${1:iostream}>'], ['incl', '#include "${1:file.h}"'], ['cout', 'std::cout << ${1} << std::endl;'], ['cin', 'std::cin >> ${1};'],
  ['vec', 'std::vector<${1:int}> ${2:v};'], ['map', 'std::map<${1:std::string}, ${2:int}> ${3:m};'], ['str', 'std::string ${1:s};'],
  ['lambda', 'auto ${1:f} = [&](${2}) {\n\t${3}\n};'], ['try', 'try {\n\t${1}\n} catch (const std::exception& e) {\n\t${2}\n}'],
  ['template', 'template <typename ${1:T}>\n${2}'], ['uptr', 'auto ${1:p} = std::make_unique<${2:T}>(${3});'], ['sptr', 'auto ${1:p} = std::make_shared<${2:T}>(${3});'],
  ['raymain', '#include "raylib.h"\nint main() {\n\tInitWindow(800, 450, "Game");\n\tSetTargetFPS(60);\n\twhile (!WindowShouldClose()) {\n\t\tBeginDrawing();\n\t\tClearBackground(RAYWHITE);\n\t\t${1}\n\t\tEndDrawing();\n\t}\n\tCloseWindow();\n\treturn 0;\n}'],
];
const WORDS = ('std::cout std::cin std::endl std::cerr std::string std::vector std::map std::unordered_map std::set std::unordered_set std::array std::pair std::tuple std::optional std::variant std::function std::sort std::find std::move std::swap std::min std::max std::make_unique std::make_shared std::unique_ptr std::shared_ptr std::to_string std::stoi std::getline std::ostringstream std::chrono std::thread std::mutex std::runtime_error std::exception ' +
  'InitWindow CloseWindow WindowShouldClose BeginDrawing EndDrawing ClearBackground SetTargetFPS GetFrameTime DrawFPS DrawText DrawCircle DrawRectangle DrawLine DrawTexture LoadTexture IsKeyDown IsKeyPressed IsMouseButtonPressed GetMouseX GetMouseY GetTouchX GetTouchY GetTouchPointCount CheckCollisionRecs BeginMode3D EndMode3D DrawCube DrawGrid UpdateCamera').split(' ');
let registered = false;
const C_SNIPS: [string, string][] = [
  ['main', 'int main(void) {\n\t${1}\n\treturn 0;\n}'], ['inc', '#include <${1:stdio.h}>'], ['printf', 'printf("${1:%d}\\n", ${2});'], ['scanf', 'scanf("${1:%d}", &${2:x});'],
  ['for', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ++${1:i}) {\n\t${3}\n}'], ['while', 'while (${1:cond}) {\n\t${2}\n}'], ['if', 'if (${1:cond}) {\n\t${2}\n}'],
  ['ifelse', 'if (${1:cond}) {\n\t${2}\n} else {\n\t${3}\n}'], ['struct', 'struct ${1:Name} {\n\t${2}\n};'], ['typedef', 'typedef struct {\n\t${2}\n} ${1:Name};'],
  ['malloc', '${1:int}* ${2:p} = (${1:int}*)malloc(${3:n} * sizeof(${1:int}));'], ['switch', 'switch (${1:x}) {\ncase ${2:0}:\n\t${3}\n\tbreak;\ndefault:\n\tbreak;\n}'],
];
const C_WORDS = 'printf scanf puts putchar getchar fgets fprintf sprintf snprintf malloc calloc realloc free memcpy memset strlen strcpy strncpy strcmp strcat atoi atof rand srand sqrt pow abs fabs sizeof NULL stdin stdout stderr size_t uint8_t uint32_t int64_t bool true false'.split(' ');
function registerCpp(m: any) {
  if (registered) return; registered = true;
  m.languages.registerCompletionItemProvider('c', {
    provideCompletionItems: (model: any, pos: any) => {
      const w = model.getWordUntilPosition(pos); const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
      return { suggestions: [...C_SNIPS.map(([l, t]) => ({ label: l, kind: 27, insertText: t, insertTextRules: 4, range })), ...C_WORDS.map(l => ({ label: l, kind: 5, insertText: l, range }))] };
    },
  });
  m.languages.registerCompletionItemProvider('cpp', {
    triggerCharacters: [':', '.', '>'],
    provideCompletionItems: (model: any, pos: any) => {
      const w = model.getWordUntilPosition(pos); const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
      return { suggestions: [
        ...SNIPS.map(([l, t]) => ({ label: l, kind: 27, insertText: t, insertTextRules: 4, documentation: t.replace(/\$\{\d:?([^}]*)\}/g, '$1'), range })),
        ...WORDS.map(l => ({ label: l, kind: 5, insertText: l, range: { ...range, startColumn: Math.max(1, range.startColumn - (l.startsWith('std::') && model.getLineContent(pos.lineNumber).slice(0, w.startColumn - 1).endsWith('std::') ? 5 : 0)) } })),
      ] };
    },
  });
}

function App() {
  const [files, setFiles] = useState<Files>(SAMPLE);
  const [open, setOpen] = useState<string[]>(['src/main.cpp']);
  const [active, setActive] = useState('src/main.cpp');
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [log, setLog] = useState('');
  const [diags, setDiags] = useState<Diag[]>([]);
  const [tab, setTab] = useState<'console' | 'errors' | 'input'>('console');
  const [stdin, setStdin] = useState('');
  const [doc, setDoc] = useState('');
  const [gameKey, setGameKey] = useState(0);
  const [full, setFull] = useState(false);
  const [showPv, setShowPv] = useState(true);
  const [status, setStatus] = useState('');
  const [building, setBuilding] = useState<string | null>(null);
  const [view, setView] = useState<View>('explorer');
  const [sel, setSel] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [pal, setPal] = useState<{ text: string; idx: number } | null>(null);
  const [pos, setPos] = useState({ l: 1, c: 1 });
  const [url, setUrl] = useState(ls('url', (import.meta.env.VITE_API_URL as string) || ''));
  const [key, setKey] = useState(ls('key', ''));
  const [fs, setFs] = useState(Number(ls('fs', '14')));
  const [minimap, setMinimap] = useState(ls('minimap', '1') === '1');
  const [wrap, setWrap] = useState(ls('wrap', '1') === '1');
  const ed = useRef<any>(null); const mon = useRef<any>(null); const loaded = useRef(false);
  const say = (s: string) => setLog(l => l + s + '\n');
  const persist = (k: string, v: string) => localStorage.setItem(k, v);

  useEffect(() => { get('project').then(v => { if (v && Object.keys(v).length) setFiles(v); loaded.current = true; }); }, []);
  useEffect(() => { if (!loaded.current) return; const t = setTimeout(() => { set('project', files).then(() => setStatus('Saved locally')); setDirty(new Set()); }, 800); return () => clearTimeout(t); }, [files]);
  useEffect(() => { const h = (e: MessageEvent) => e.data?.log && say(e.data.log); window.addEventListener('message', h); return () => window.removeEventListener('message', h); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey; if (!mod) return; const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); save(); }
      else if (k === 'b' && !e.shiftKey) { e.preventDefault(); build(false); }
      else if (k === 'enter') { e.preventDefault(); build(true); }
      else if (k === 'p') { e.preventDefault(); setPal({ text: e.shiftKey ? '>' : '', idx: 0 }); }
      else if (k === 'f' && e.shiftKey) { e.preventDefault(); setView('search'); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  const edit = (v?: string) => { setFiles(f => ({ ...f, [active]: v ?? '' })); setDirty(d => new Set(d).add(active)); };
  const openFile = (p: string) => { setOpen(o => o.includes(p) ? o : [...o, p]); setActive(p); };
  const revealAt = (p: string, line: number, col: number) => { openFile(p); setTimeout(() => { ed.current?.revealLineInCenter(line); ed.current?.setPosition({ lineNumber: line, column: col }); ed.current?.focus(); }, 150); };
  const closeTab = (p: string) => { const o = open.filter(x => x !== p); setOpen(o); if (active === p) setActive(o[o.length - 1] || ''); };
  const base = () => (sel ? sel + '/' : '');
  const newFile = () => { const p = prompt('New file path', base() + 'new.cpp'); if (!p) return; if (!OKPATH.test(p) || p.includes('..') || p.startsWith('/')) return alert('Invalid path'); if (files[p] !== undefined) return alert('Exists'); setFiles({ ...files, [p]: '' }); openFile(p); };
  const newFolder = () => { const p = (prompt('New folder path', base() + 'newfolder') || '').replace(/\/+$/, ''); if (!p) return; if (!OKPATH.test(p) || p.includes('..') || p.startsWith('/')) return alert('Invalid path'); const k = p + '/.gitkeep'; if (files[k] !== undefined) return alert('Exists'); setFiles({ ...files, [k]: '' }); setCollapsed(c => { const n = new Set(c); n.delete(p); return n; }); setSel(p); };
  const rename = (p: string, dir = false) => {
    const n = (prompt('Rename / move to', p) || '').replace(/\/+$/, ''); if (!n || n === p || !OKPATH.test(n) || n.includes('..') || n.startsWith('/')) return;
    const nf: Files = {}; const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(files)) { const nk = dir ? (k.startsWith(p + '/') ? n + k.slice(p.length) : k) : (k === p ? n : k); if (nk !== k) map[k] = nk; nf[nk] = v; }
    if (!Object.keys(map).length) return;
    if (Object.keys(nf).length !== Object.keys(files).length) return alert('Name already exists');
    setFiles(nf); setOpen(open.map(x => map[x] || x)); if (map[active]) setActive(map[active]); if (dir) setSel(n);
  };
  const del = (p: string, dir = false) => {
    if (!confirm('Delete ' + p + (dir ? ' and everything in it?' : '?'))) return;
    const gone = (k: string) => dir ? k.startsWith(p + '/') : k === p;
    const nf: Files = {}; for (const [k, v] of Object.entries(files)) if (!gone(k)) nf[k] = v;
    setFiles(nf); const o = open.filter(x => !gone(x)); setOpen(o); if (gone(active)) setActive(o[o.length - 1] || ''); if (dir) setSel('');
  };
  const rows = (() => {
    const dirs = new Set<string>(); Object.keys(files).forEach(k => { const a = k.split('/'); for (let i = 1; i < a.length; i++) dirs.add(a.slice(0, i).join('/')); });
    const ents = [...[...dirs].map(p => ({ p, dir: true })), ...Object.keys(files).filter(k => !k.endsWith('.gitkeep')).map(p => ({ p, dir: false }))];
    ents.sort((a, b) => { const A = a.p.split('/'), B = b.p.split('/'); for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) { const ad = i < A.length - 1 || a.dir, bd = i < B.length - 1 || b.dir; if (ad !== bd) return ad ? -1 : 1; return A[i] < B[i] ? -1 : 1; } return A.length - B.length; });
    return ents.filter(e => { const a = e.p.split('/'); for (let i = 1; i < a.length; i++) if (collapsed.has(a.slice(0, i).join('/'))) return false; return true; });
  })();
  const results = query.length > 1 ? Object.entries(files).flatMap(([p, c]) => p.endsWith('.gitkeep') ? [] : c.split('\n').flatMap((l, i) => { const k = l.toLowerCase().indexOf(query.toLowerCase()); return k >= 0 ? [{ p, line: i + 1, col: k + 1, text: l.trim().slice(0, 80) }] : []; })).slice(0, 200) : [];

  const save = async () => {
    await set('project', files); setStatus('Saved locally');
    try {
      const body = JSON.stringify({ name: 'MyGame', files }); let id = localStorage.getItem('pid');
      if (id) { try { await api('/api/projects/' + id, { method: 'PUT', body }); } catch (e: any) { if (!String(e.message).startsWith('404')) throw e; id = null; } }
      if (!id) { id = (await api('/api/projects', { method: 'POST', body })).id; localStorage.setItem('pid', id!); }
      setStatus('Saved locally + server');
    } catch (e: any) { setStatus('Local only (' + e.message + ')'); }
  };
  const exportZip = async () => { const name = (prompt('ZIP file name', 'MyGame') || '').replace(/[^A-Za-z0-9_-]/g, ''); if (!name) return; const z = new JSZip(); Object.entries(files).forEach(([p, c]) => z.file(p, c)); const u = URL.createObjectURL(await z.generateAsync({ type: 'blob' })); const a = document.createElement('a'); a.href = u; a.download = name + '.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10000); };
  const importZip = async (f?: File) => { if (!f) return; const z = await JSZip.loadAsync(f); const n: Files = {}; for (const [p, e] of Object.entries(z.files)) if (!e.dir && OKPATH.test(p) && !p.includes('..') && (/\.(cpp|cc|c|h|hpp|txt|json|cmake|md)$/.test(p) || p.endsWith('.gitkeep'))) n[p] = await e.async('string'); if (!Object.keys(n).length) return alert('No supported files in ZIP'); setFiles(n); setOpen([]); setActive(''); };
  const markers = (d: Diag[]) => { const m = mon.current; if (!m) return; m.editor.getModels().forEach((mod: any) => { const f = mod.uri.path.replace(/^\//, ''); m.editor.setModelMarkers(mod, 'emcc', d.filter(x => f.endsWith(x.file.replace(/^\.\//, ''))).map(x => ({ startLineNumber: x.line, startColumn: x.col, endLineNumber: x.line, endColumn: x.col + 1, message: x.message, severity: x.severity === 'error' ? 8 : 4 }))); }); };

  const build = async (single = false) => {
    if (building) return; if (single && !/\.(c|cpp|cc)$/.test(active)) return alert('Open a .c or .cpp file first'); setLog(''); setDiags([]); markers([]); setTab('console'); setStatus('Building...');
    try {
      const { id } = await api('/api/build', { method: 'POST', body: JSON.stringify({ files, entry: active, single }) }); setBuilding(id);
      for (;;) {
        await new Promise(r => setTimeout(r, 1000));
        const j = await api('/api/build/' + id); setLog(j.log || 'Compiling...');
        if (j.status === 'running') continue;
        setBuilding(null); setDiags(j.diagnostics); markers(j.diagnostics);
        if (j.status === 'done') { const r = await api('/api/build/' + id + '/result'); setDoc(previewDoc(r.js, r.wasm, stdin)); setGameKey(k => k + 1); setStatus('Build OK'); say('\nBuild succeeded. Program output:'); }
        else { setStatus('Build ' + j.status); if (j.diagnostics.some((d: Diag) => d.severity === 'error')) setTab('errors'); }
        return;
      }
    } catch (e: any) { setBuilding(null); setStatus('Build error'); say('ERROR: ' + e.message); alert('Build error: ' + e.message); }
  };
  const cancel = async () => { if (building) { await api('/api/build/' + building + '/cancel', { method: 'POST' }).catch(() => {}); setBuilding(null); setStatus('Cancelled'); } };
  const stop = () => { setDoc(''); say('Stopped'); };

  const cmds: [string, () => void][] = [
    ['Run Current File (.c/.cpp only)', () => build(true)], ['Build Project (all files)', () => build(false)], ['Stop', stop], ['Save', save], ['New File', newFile], ['New Folder', newFolder], ['Export ZIP', exportZip],
    ['Toggle Preview', () => setShowPv(v => !v)], ['Toggle Minimap', () => { setMinimap(!minimap); persist('minimap', minimap ? '0' : '1'); }],
    ['Toggle Word Wrap', () => { setWrap(!wrap); persist('wrap', wrap ? '0' : '1'); }], ['Search in Files', () => setView('search')], ['Open Settings', () => setView('settings')],
    ['Format Document', () => ed.current?.getAction('editor.action.formatDocument')?.run()], ['Find and Replace', () => ed.current?.getAction('editor.action.startFindReplace')?.run()],
  ];
  const palItems = pal ? (pal.text.startsWith('>')
    ? cmds.filter(([n]) => n.toLowerCase().includes(pal.text.slice(1).trim().toLowerCase())).map(([n, f]) => ({ n, f }))
    : Object.keys(files).filter(p => !p.endsWith('.gitkeep') && p.toLowerCase().includes(pal.text.toLowerCase())).slice(0, 30).map(p => ({ n: p, f: () => openFile(p) }))) : [];
  const runPal = (i: number) => { const it = palItems[i]; setPal(null); if (it) setTimeout(it.f, 0); };

  const Icon = ({ d }: { d: React.ReactNode }) => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
  const errCount = diags.filter(d => d.severity === 'error').length, warnCount = diags.length - errCount;

  return <div className="app">
    <div className="top">
      <b style={{ marginRight: 6 }}>C++ Game Studio</b>
      <button onClick={save}>Save</button>
      <button onClick={() => ed.current?.trigger('k', 'undo')}>Undo</button><button onClick={() => ed.current?.trigger('k', 'redo')}>Redo</button>
      <button className="pri" onClick={() => build(true)} disabled={!!building}>Run File</button><button onClick={() => build(false)} disabled={!!building}>Build Project</button>
      <button onClick={cancel} disabled={!building}>Cancel</button><button onClick={stop}>Stop</button>
      <button onClick={() => setGameKey(k => k + 1)}>Restart</button>
      <button className={showPv ? 'on' : ''} onClick={() => setShowPv(!showPv)}>Preview</button>
      <button onClick={() => setPal({ text: '', idx: 0 })}>Go to File</button>
      <button onClick={() => setPal({ text: '>', idx: 0 })}>Commands</button>
    </div>
    <div className="act">
      <button className={view === 'explorer' ? 'on' : ''} title="Explorer" onClick={() => setView('explorer')}><Icon d={<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>} /></button>
      <button className={view === 'search' ? 'on' : ''} title="Search" onClick={() => setView('search')}><Icon d={<><circle cx="10" cy="10" r="6" /><path d="M15 15l6 6" /></>} /></button>
      <button className={view === 'settings' ? 'on' : ''} title="Settings" onClick={() => setView('settings')}><Icon d={<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>} /></button>
    </div>
    <div className="side">
      {view === 'explorer' && <>
        <div className="sh">Explorer: MyGame</div>
        <div style={{ padding: '0 8px 8px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <button onClick={newFile}>+File</button><button onClick={newFolder}>+Folder</button><button onClick={exportZip}>ZIP Export</button>
          <label><button onClick={e => (e.currentTarget.nextSibling as HTMLInputElement).click()}>ZIP Import</button><input type="file" accept=".zip" hidden onChange={e => importZip(e.target.files?.[0])} /></label>
          <button onClick={() => { if (confirm('Reset to sample project?')) { setFiles(SAMPLE); setSel(''); setOpen(['src/main.cpp']); setActive('src/main.cpp'); } }}>Reset</button>
        </div>
        {rows.map(({ p, dir }) => { const nm = p.split('/').pop(); const dp = p.split('/').length - 1; return <div key={(dir ? 'd:' : 'f:') + p} className={'file' + (!dir && p === active ? ' act' : '') + (dir && p === sel ? ' sel' : '')} style={{ paddingLeft: 10 + dp * 14 }}>
          <span style={{ flex: 1 }} onClick={() => { if (dir) { setSel(p); setCollapsed(c => { const n = new Set(c); n.has(p) ? n.delete(p) : n.add(p); return n; }); } else openFile(p); }}>{dir ? (collapsed.has(p) ? '> ' : 'v ') : (dirty.has(p) ? '* ' : '  ')}{nm}</span>
          <small onClick={() => rename(p, dir)}>Ren</small><small onClick={() => del(p, dir)}>Del</small></div>; })}
      </>}
      {view === 'search' && <>
        <div className="sh">Search</div>
        <input value={query} placeholder="Search in files" onChange={e => setQuery(e.target.value)} />
        <div className="res" style={{ color: '#858585' }}>{query.length > 1 ? results.length + ' results' : 'Type 2+ characters'}</div>
        {results.map((r, i) => <div key={i} className="res" onClick={() => revealAt(r.p, r.line, r.col)}><b>{r.p}:{r.line}</b> {r.text}</div>)}
      </>}
      {view === 'settings' && <>
        <div className="sh">Settings</div>
        <div className="res">Backend URL</div><input value={url} placeholder="https://xxxx.up.railway.app" onChange={e => { setUrl(e.target.value); persist('url', e.target.value); }} />
        <div className="res">API key</div><input type="password" value={key} onChange={e => { setKey(e.target.value); persist('key', e.target.value); }} />
        <div className="res">Font size: {fs}</div><input type="number" min={10} max={32} value={fs} onChange={e => { const n = Math.max(10, Math.min(32, Number(e.target.value) || 14)); setFs(n); persist('fs', String(n)); }} />
        <div className="res"><label><input type="checkbox" style={{ width: 'auto', margin: '0 8px 0 0', minHeight: 0 }} checked={minimap} onChange={e => { setMinimap(e.target.checked); persist('minimap', e.target.checked ? '1' : '0'); }} />Minimap</label></div>
        <div className="res"><label><input type="checkbox" style={{ width: 'auto', margin: '0 8px 0 0', minHeight: 0 }} checked={wrap} onChange={e => { setWrap(e.target.checked); persist('wrap', e.target.checked ? '1' : '0'); }} />Word wrap</label></div>
        <div className="res" style={{ color: '#858585' }}>Shortcuts: Cmd+S save, Cmd+B build, Cmd+P go to file, Cmd+Shift+P commands, Cmd+Shift+F search, Cmd+F find, Cmd+H replace</div>
      </>}
    </div>
    <div className="ed">
      <div className="tabs">{open.map(p => <div key={p} className={'tab' + (p === active ? ' act' : '')} onClick={() => setActive(p)}>{p.split('/').pop()}{dirty.has(p) ? ' *' : ''} <span onClick={e => { e.stopPropagation(); closeTab(p); }}>x</span></div>)}</div>
      {active && <div className="crumb">{active.split('/').join(' > ')}</div>}
      {active && files[active] !== undefined ? <Editor theme="vs-dark" path={active} language={lang(active)} value={files[active]} onChange={edit}
        onMount={(e, m) => { ed.current = e; mon.current = m; registerCpp(m); e.onDidChangeCursorPosition((ev: any) => setPos({ l: ev.position.lineNumber, c: ev.position.column })); }}
        options={{ fontSize: fs, minimap: { enabled: minimap }, automaticLayout: true, bracketPairColorization: { enabled: true }, guides: { indentation: true, bracketPairs: true }, tabSize: 4, wordWrap: wrap ? 'on' : 'off', formatOnType: true, formatOnPaste: true, autoClosingBrackets: 'always', autoIndent: 'full', smoothScrolling: true, cursorBlinking: 'smooth', renderWhitespace: 'selection', scrollBeyondLastLine: false, suggest: { showSnippets: true, showWords: true }, quickSuggestions: { other: true, comments: false, strings: false } }} /> : <p style={{ padding: 20 }}>Open a file (Go to File: Cmd+P).</p>}
    </div>
    {showPv && <div className={'pv' + (full ? ' full' : '')}>
      <div style={{ display: 'flex', gap: 6, padding: 4, background: '#252526' }}><button onClick={() => setFull(!full)}>{full ? 'Exit full' : 'Fullscreen'}</button></div>
      <iframe key={gameKey} title="game" sandbox="allow-scripts allow-modals" srcDoc={doc} allow="fullscreen; autoplay" />
    </div>}
    <div className="bot">
      <div className="tabs"><div className={'tab' + (tab === 'console' ? ' act' : '')} onClick={() => setTab('console')}>Console / Output</div>
        <div className={'tab' + (tab === 'errors' ? ' act' : '')} onClick={() => setTab('errors')}>Problems ({diags.length})</div><div className={'tab' + (tab === 'input' ? ' act' : '')} onClick={() => setTab('input')}>Input (stdin)</div></div>
      {tab === 'console' ? <pre className="log">{log || 'Press "Build & Run". Console programs: put code inside int main().'}</pre>
        : tab === 'errors' ? <pre className="log">{diags.map((d, i) => <div key={i} className="err" style={{ color: d.severity === 'error' ? '#f48771' : '#cca700' }} onClick={() => revealAt(Object.keys(files).find(f => f.endsWith(d.file.replace(/^\.\//, ''))) || active, d.line, d.col)}>{d.severity} {d.file}:{d.line}:{d.col} {d.message}</div>)}</pre> : <textarea value={stdin} onChange={e => setStdin(e.target.value)} placeholder={'Text for std::cin / scanf, one line per input. If it runs out, a dialog asks for more.'} style={{ flex: 1, margin: 8, fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 13 }} />}
    </div>
    <div className="stat">
      <span>{building ? 'Building...' : status} | errors {errCount} warnings {warnCount}</span>
      <span>Ln {pos.l}, Col {pos.c} | Spaces: 4 | UTF-8 | {active.endsWith('.c') ? 'C17' : 'C++20'}</span>
    </div>
    {pal && <div className="ov" onClick={() => setPal(null)}><div className="pal" onClick={e => e.stopPropagation()}>
      <input autoFocus value={pal.text} placeholder="File name, or > for commands" onChange={e => setPal({ text: e.target.value, idx: 0 })}
        onKeyDown={e => { if (e.key === 'Escape') setPal(null); else if (e.key === 'Enter') runPal(pal.idx); else if (e.key === 'ArrowDown') { e.preventDefault(); setPal({ ...pal, idx: Math.min(palItems.length - 1, pal.idx + 1) }); } else if (e.key === 'ArrowUp') { e.preventDefault(); setPal({ ...pal, idx: Math.max(0, pal.idx - 1) }); } }} />
      <div style={{ maxHeight: '50vh', overflow: 'auto' }}>{palItems.map((it, i) => <div key={it.n} className={'pi' + (i === pal.idx ? ' sel' : '')} onClick={() => runPal(i)}>{it.n}</div>)}</div>
    </div></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
