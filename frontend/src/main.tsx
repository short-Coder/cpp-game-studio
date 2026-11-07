import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Editor from '@monaco-editor/react';
import { get, set } from 'idb-keyval';
import JSZip from 'jszip';
import { SAMPLE } from './sample';
import './style.css';

type Files = Record<string, string>;
type Diag = { file: string; line: number; col: number; severity: 'error' | 'warning'; message: string };
const lang = (p: string) => /\.(cpp|cc|h|hpp|c)$/.test(p) ? 'cpp' : p.endsWith('.json') ? 'json' : 'plaintext';
const conf = () => ({ url: localStorage.getItem('url') || (import.meta.env.VITE_API_URL as string) || '', key: localStorage.getItem('key') || '' });
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
const previewDoc = (js: string, wasm: string) => `<!doctype html><body style="margin:0;background:#000"><canvas id="c" style="width:100%;height:100%;touch-action:none" oncontextmenu="return false"></canvas><script>
const b=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const w=URL.createObjectURL(new Blob([b("${wasm}")],{type:'application/wasm'}));
window.Module={canvas:document.getElementById('c'),locateFile:()=>w,print:t=>parent.postMessage({log:String(t)},'*'),printErr:t=>parent.postMessage({log:String(t)},'*'),onAbort:t=>parent.postMessage({log:'ABORT: '+t},'*')};
window.onerror=m=>parent.postMessage({log:'JS error: '+m},'*');
const s=document.createElement('script');s.src=URL.createObjectURL(new Blob([b("${js}")],{type:'text/javascript'}));document.body.appendChild(s);
</script></body>`;

function App() {
  const [files, setFiles] = useState<Files>(SAMPLE);
  const [open, setOpen] = useState<string[]>(['src/main.cpp']);
  const [active, setActive] = useState('src/main.cpp');
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [log, setLog] = useState('');
  const [diags, setDiags] = useState<Diag[]>([]);
  const [tab, setTab] = useState<'console' | 'errors'>('console');
  const [doc, setDoc] = useState('');
  const [gameKey, setGameKey] = useState(0);
  const [full, setFull] = useState(false);
  const [showPv, setShowPv] = useState(true);
  const [status, setStatus] = useState('');
  const [building, setBuilding] = useState<string | null>(null);
  const [fs, setFs] = useState(14);
  const [sel, setSel] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const ed = useRef<any>(null); const mon = useRef<any>(null); const loaded = useRef(false);
  const say = (s: string) => setLog(l => l + s + '\n');

  useEffect(() => { get('project').then(v => { if (v && Object.keys(v).length) setFiles(v); loaded.current = true; }); }, []);
  useEffect(() => { if (!loaded.current) return; const t = setTimeout(() => { set('project', files).then(() => setStatus('Saved locally')); setDirty(new Set()); }, 800); return () => clearTimeout(t); }, [files]);
  useEffect(() => { const h = (e: MessageEvent) => e.data?.log && say(e.data.log); window.addEventListener('message', h); return () => window.removeEventListener('message', h); }, []);
  useEffect(() => { const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); build(); } }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); });

  const edit = (v?: string) => { setFiles(f => ({ ...f, [active]: v ?? '' })); setDirty(d => new Set(d).add(active)); };
  const openFile = (p: string) => { setOpen(o => o.includes(p) ? o : [...o, p]); setActive(p); };
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
  const save = async () => { await set('project', files); setStatus('Saved locally'); try { let id = localStorage.getItem('pid'); if (id) await api('/api/projects/' + id, { method: 'PUT', body: JSON.stringify({ name: 'MyGame', files }) }); else { id = (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'MyGame', files }) })).id; localStorage.setItem('pid', id!); } setStatus('Saved locally + server'); } catch (e: any) { setStatus('Local only (' + e.message + ')'); } };
  const exportZip = async () => { const name = (prompt('ZIP file name', 'MyGame') || '').replace(/[^A-Za-z0-9_-]/g, ''); if (!name) return; const z = new JSZip(); Object.entries(files).forEach(([p, c]) => z.file(p, c)); const u = URL.createObjectURL(await z.generateAsync({ type: 'blob' })); const a = document.createElement('a'); a.href = u; a.download = name + '.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 10000); };
  const importZip = async (f?: File) => { if (!f) return; const z = await JSZip.loadAsync(f); const n: Files = {}; for (const [p, e] of Object.entries(z.files)) if (!e.dir && /^[A-Za-z0-9_./-]+$/.test(p) && !p.includes('..') && (/\.(cpp|cc|c|h|hpp|txt|json|cmake)$/.test(p) || p.endsWith('.gitkeep'))) n[p] = await e.async('string'); setFiles(n); setOpen([]); setActive(''); };
  const markers = (d: Diag[]) => { const m = mon.current; if (!m) return; m.editor.getModels().forEach((mod: any) => { const f = mod.uri.path.replace(/^\//, ''); m.editor.setModelMarkers(mod, 'emcc', d.filter(x => f.endsWith(x.file.replace(/^\.\//, ''))).map(x => ({ startLineNumber: x.line, startColumn: x.col, endLineNumber: x.line, endColumn: x.col + 1, message: x.message, severity: x.severity === 'error' ? 8 : 4 }))); }); };

  const build = async () => {
    if (building) return; setLog(''); setDiags([]); markers([]); setTab('console'); setStatus('Building...');
    try {
      const { id } = await api('/api/build', { method: 'POST', body: JSON.stringify({ files }) }); setBuilding(id);
      for (;;) {
        await new Promise(r => setTimeout(r, 1000));
        const j = await api('/api/build/' + id); setLog(j.log || 'Compiling...');
        if (j.status === 'running') continue;
        setBuilding(null); setDiags(j.diagnostics); markers(j.diagnostics);
        if (j.status === 'done') { const r = await api('/api/build/' + id + '/result'); setDoc(previewDoc(r.js, r.wasm)); setGameKey(k => k + 1); setStatus('Build OK'); say('\nBuild succeeded'); }
        else { setStatus('Build ' + j.status); if (j.diagnostics.length) setTab('errors'); }
        return;
      }
    } catch (e: any) { setBuilding(null); setStatus('Build error'); say('ERROR: ' + e.message); alert('Build error: ' + e.message); }
  };
  const cancel = async () => { if (building) { await api('/api/build/' + building + '/cancel', { method: 'POST' }).catch(() => {}); setBuilding(null); setStatus('Cancelled'); } };
  const stop = () => { setDoc(''); say('Game stopped'); };
  const settings = () => { const u = prompt('Backend URL (Railway)', conf().url); if (u !== null) localStorage.setItem('url', u); const k = prompt('API key', conf().key); if (k !== null) localStorage.setItem('key', k); };
  const goto = (d: Diag) => { const p = Object.keys(files).find(f => f.endsWith(d.file.replace(/^\.\//, ''))); if (p) { openFile(p); setTimeout(() => { ed.current?.revealLineInCenter(d.line); ed.current?.setPosition({ lineNumber: d.line, column: d.col }); }, 100); } };

  return <div className="app">
    <div className="top">
      <b>C++ Game Studio</b><span>MyGame</span>
      <button onClick={save}>Save</button>
      <button onClick={() => ed.current?.trigger('k', 'undo')}>Undo</button><button onClick={() => ed.current?.trigger('k', 'redo')}>Redo</button>
      <button className="pri" onClick={build} disabled={!!building}>Build &amp; Run</button>
      <button onClick={cancel} disabled={!building}>Cancel</button><button onClick={stop}>Stop</button>
      <button onClick={() => setGameKey(k => k + 1)}>Restart</button>
      <button className={showPv ? 'on' : ''} onClick={() => setShowPv(!showPv)}>Preview</button>
      <button onClick={() => setFs(Math.min(28, fs + 2))}>A+</button><button onClick={() => setFs(Math.max(10, fs - 2))}>A-</button>
      <button onClick={settings}>Settings</button><span>{status}</span>
    </div>
    <div className="side">
      <div style={{ padding: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button onClick={newFile}>+File</button><button onClick={newFolder}>+Folder</button><button onClick={exportZip}>ZIP Export</button>
        <label><button onClick={e => (e.currentTarget.nextSibling as HTMLInputElement).click()}>ZIP Import</button><input type="file" accept=".zip" hidden onChange={e => importZip(e.target.files?.[0])} /></label>
        <button onClick={() => { if (confirm('Reset to sample project?')) { setFiles(SAMPLE); setSel(''); } }}>Reset</button>
      </div>
      {rows.map(({ p, dir }) => { const nm = p.split('/').pop(); const dp = p.split('/').length - 1; return <div key={(dir ? 'd:' : 'f:') + p} className={'file' + (!dir && p === active ? ' act' : '') + (dir && p === sel ? ' sel' : '')} style={{ paddingLeft: 10 + dp * 14 }}>
        <span style={{ flex: 1 }} onClick={() => { if (dir) { setSel(p); setCollapsed(c => { const n = new Set(c); n.has(p) ? n.delete(p) : n.add(p); return n; }); } else openFile(p); }}>{dir ? (collapsed.has(p) ? '[+] ' : '[-] ') : (dirty.has(p) ? '* ' : '')}{nm}</span>
        <span onClick={() => rename(p, dir)}>Rename</span><span onClick={() => del(p, dir)}>Del</span></div>; })}
    </div>
    <div className="ed">
      <div className="tabs">{open.map(p => <div key={p} className={'tab' + (p === active ? ' act' : '')} onClick={() => setActive(p)}>{p.split('/').pop()}{dirty.has(p) ? ' *' : ''} <span onClick={e => { e.stopPropagation(); closeTab(p); }}>x</span></div>)}</div>
      {active && files[active] !== undefined ? <Editor theme="vs-dark" path={active} language={lang(active)} value={files[active]} onChange={edit}
        onMount={(e, m) => { ed.current = e; mon.current = m; }} options={{ fontSize: fs, minimap: { enabled: false }, automaticLayout: true, bracketPairColorization: { enabled: true }, tabSize: 2, wordWrap: 'on' }} /> : <p style={{ padding: 20 }}>Open a file from the explorer.</p>}
    </div>
    {showPv && <div className={'pv' + (full ? ' full' : '')}>
      <div style={{ display: 'flex', gap: 6, padding: 4, background: '#333' }}><button onClick={() => setFull(!full)}>{full ? 'Exit full' : 'Fullscreen'}</button></div>
      <iframe key={gameKey} title="game" sandbox="allow-scripts" srcDoc={doc} allow="fullscreen; autoplay" />
    </div>}
    <div className="bot">
      <div className="tabs"><div className={'tab' + (tab === 'console' ? ' act' : '')} onClick={() => setTab('console')}>Console / Output</div>
        <div className={'tab' + (tab === 'errors' ? ' act' : '')} onClick={() => setTab('errors')}>Errors ({diags.filter(d => d.severity === 'error').length})</div></div>
      {tab === 'console' ? <pre className="log">{log || 'Press "Build & Run".'}</pre>
        : <pre className="log">{diags.map((d, i) => <div key={i} className="err" onClick={() => goto(d)}>{d.severity} {d.file}:{d.line}:{d.col} {d.message}</div>)}</pre>}
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
