import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, ChevronRight, Circle, CircleHelp, Clock3, ExternalLink, FileText, Folder, HardDrive, Headphones, Library, LoaderCircle, Mic, MoreHorizontal, Pause, Play, Search, ShieldCheck, SlidersHorizontal, Square, Trash2, Video, X } from 'lucide-react';
import { initialOverview, inExtension, openPage, request } from './bridge';
import { deleteRecording, listRecordings, putRecording, recordingFile } from './db';
import { bytes, duration, elapsed, errorMessage, filename, isMeetUrl, type Overview, type Recording, type Settings } from './shared';
import './styles.css';
import { TranscriptDialog } from './TranscriptDialog';

function Brand() { return <div className="brand"><span className="brand-icon"><Video size={19} strokeWidth={2.4}/></span><span>meetkeep<span className="brand-dot">.</span></span></div>; }
function useWorkspace() {
  const [overview, setOverview] = useState<Overview>(initialOverview);
  const [records, setRecords] = useState<Recording[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  async function refresh() {
    try { const [next, saved] = await Promise.all([request<Overview>('OVERVIEW'), listRecordings()]); setOverview(next); setRecords(saved); }
    catch (error) { setError(errorMessage(error)); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    refresh();
    const timer = setInterval(() => { setNow(Date.now()); refresh(); }, 1500);
    const changed = () => { refresh(); };
    if (inExtension) chrome.storage.onChanged.addListener(changed);
    return () => { clearInterval(timer); if (inExtension) chrome.storage.onChanged.removeListener(changed); };
  }, []);
  async function action(type: string, fields: Record<string, unknown> = {}) {
    setBusy(true); setError('');
    const previousSettings = overview.settings;
    if (type === 'SETTINGS') setOverview(previous => ({ ...previous, settings: { ...previous.settings, ...(fields.settings as Partial<Settings>) } }));
    try { await request(type, fields); await refresh(); }
    catch (error) { if (type === 'SETTINGS') setOverview(previous => ({ ...previous, settings: previousSettings })); setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return { overview, records, error, setError, loading, busy, now, refresh, action };
}
type Workspace = ReturnType<typeof useWorkspace>;
function Notice({ children, kind = 'info' }: { children: React.ReactNode; kind?: string }) { return <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>; }
function Toggle({ label, detail, checked, disabled, onChange }: { label: string; detail: string; checked: boolean; disabled?: boolean; onChange: () => void }) {
  return <label className="setting"><span><strong>{label}</strong><small>{detail}</small></span><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={onChange}/><span className="toggle" aria-hidden="true"/></label>;
}
function Preferences({ workspace, compact = false }: { workspace: Workspace; compact?: boolean }) {
  const prefs = workspace.overview.settings;
  const locked = workspace.busy || workspace.overview.session.phase !== 'idle';
  const update = (settings: Partial<Settings>) => workspace.action('SETTINGS', { settings });
  if (compact) return <div className="preferences compact"><div className="setting"><span><strong>Record any browser tab</strong><small>Meet also has a small record button in its bottom-left corner.</small></span><Video size={17}/></div></div>;
  return <div className="preferences">
    <Toggle label="Download when finished" detail="Also keep a copy in your library" checked={prefs.autoDownload} disabled={locked} onChange={() => update({ autoDownload: !prefs.autoDownload })}/>
    <Toggle label="Include my microphone" detail="Records your mic independently of Meet’s mute button" checked={prefs.includeMic} disabled={locked} onChange={() => prefs.includeMic ? update({ includeMic: false }) : openPage('permission.html')}/>
    <label className="setting quality"><span><strong>Video quality</strong><small>Applies to your next recording</small></span><select aria-label="Video quality" disabled={locked} value={prefs.quality} onChange={event => update({ quality: event.target.value as Settings['quality'] })}><option value="standard">720p · Smaller files</option><option value="high">1080p · More detail</option></select></label>
    {locked && <p className="muted tiny">Stop recording to change preferences.</p>}
  </div>;
}
function RecordingCard({ workspace }: { workspace: Workspace }) {
  const { overview: { session, tab, settings }, busy, loading, action, now } = workspace;
  const active = session.phase !== 'idle';
  const recording = session.phase === 'recording' || session.phase === 'paused';
  const working = busy || session.phase === 'arming' || session.phase === 'armed' || session.phase === 'saving' || loading;
  const title = { idle: 'A little less to remember.', arming: 'Getting everything ready.', armed: 'Getting everything ready.', recording: 'Recording your tab.', paused: 'Take your time.', saving: 'Keeping the good stuff.' }[session.phase];
  return <section className={`capture-card ${active ? 'is-active' : ''}`}>
    <div className="card-eyebrow"><span className={`status-dot ${session.phase === 'recording' ? 'pulse' : ''}`}/>{({ idle: 'FULL-TAB RECORDING', arming: 'PREPARING', armed: 'PREPARING', recording: 'RECORDING', paused: 'RECORDING PAUSED', saving: 'SAVING LOCALLY' })[session.phase]}<span className="local-pill"><HardDrive size={10}/> Local</span></div>
    <h1>{title}</h1>
    <p className="capture-description">{recording ? 'We’re keeping this tab. You can stay focused.' : active ? 'Your recording stays on this device.' : 'Keep the complete browser tab, including its video and audio.'}</p>
    <div className="waveform" aria-hidden="true">{Array.from({ length: 47 }, (_, i) => <i key={i} style={{ height: `${8 + (Math.sin(i * 1.7) + 1) * 13 + Math.sin(i * .4) ** 2 * 15}px`, animationDelay: `${i * -.07}s` }}/>)}</div>
    {recording ? <div className="timer" aria-label="Recording duration">{duration(elapsed(session, now))}<span>{settings.includeMic ? 'Tab video + audio + microphone' : 'Tab video + audio'}</span></div> : <div className="meeting-target"><span className="meet-mark"><Video size={17}/></span><span><strong>{active ? session.title : tab ? tab.title : 'No recordable tab'}</strong><small>{active ? 'This tab is connected' : tab ? isMeetUrl(tab.url) ? 'Click below or use Meet’s corner record button' : 'Click below to record this tab' : 'Open a website tab to get started'}</small></span>{tab || active ? <Check size={15}/> : <ExternalLink size={14}/>}</div>}
    <div className="capture-actions">
      {recording ? <><button className="button light secondary-control" disabled={working} onClick={() => action(session.phase === 'paused' ? 'RESUME' : 'PAUSE')}>{session.phase === 'paused' ? <Play size={15}/> : <Pause size={15}/>} {session.phase === 'paused' ? 'Resume' : 'Pause'}</button><button className="button light" disabled={working} onClick={() => action('STOP')}><Square size={13} fill="currentColor"/> Stop & save</button></>
      : active ? <button className="button light" disabled><LoaderCircle size={16} className="spin"/>{session.phase === 'saving' ? 'Saving your recording…' : 'Preparing your recording…'}</button>
      : tab ? <button className="button light" disabled={working} onClick={() => action('ARM', { tabId: tab.id })}>{working ? <LoaderCircle size={15} className="spin"/> : <Circle size={14} fill="currentColor"/>}{loading ? 'Connecting…' : 'Start recording'}<ArrowRight size={16}/></button>
      : <button className="button light" disabled><Circle size={14}/>Start recording</button>}
    </div>
    <p className="capture-footnote">{active ? 'Closing this popup won’t stop the recording.' : tab ? 'You choose when to record. Nothing starts automatically.' : 'Chrome’s internal and extension pages can’t be recorded.'}</p>
  </section>;
}
function RecordItem({ record, active, onPlay, onDownload, onManage, onTranscript, compact }: { record: Recording; active: boolean; onPlay: () => void; onDownload: () => void; onManage?: () => void; onTranscript?: () => void; compact?: boolean }) {
  const interrupted = record.status === 'recording' && !active || record.status === 'interrupted';
  return <div className={`record-item ${compact ? 'compact' : ''}`}>
    <button className="record-icon" aria-label={`Play ${record.title}`} onClick={onPlay} disabled={active || record.size === 0}><Play size={16} fill="currentColor"/></button>
    <div className="record-info"><strong>{record.title}</strong><small>{new Date(record.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} <span>·</span> {duration(record.duration).replace(/^00:/, '')} <span>·</span> {bytes(record.size)}</small>{interrupted && <span className="recovered-tag">Interrupted · saved portion available</span>}{active && <span className="recovered-tag">Recording in progress</span>}</div>
    {onTranscript && <button className="icon-button" title="English transcript / SRT" aria-label={`Transcript for ${record.title}`} disabled={active || record.size === 0} onClick={onTranscript}><FileText size={17}/></button>}
    <button className="icon-button" title="Download recording" aria-label={`Download ${record.title}`} disabled={active || record.size === 0} onClick={onDownload}><ArrowDownToLine size={17}/></button>
    {onManage && <button className="icon-button" aria-label={`Manage ${record.title}`} onClick={onManage} disabled={active}><MoreHorizontal size={18}/></button>}
  </div>;
}
function usePlayback(workspace: Workspace) {
  const [playing, setPlaying] = useState<{ record: Recording; url: string }>();
  const [preparing, setPreparing] = useState('');
  useEffect(() => () => { if (playing) URL.revokeObjectURL(playing.url); }, [playing]);
  async function play(record: Recording) { setPreparing(record.title); try { const file = await recordingFile(record); if (file.warning) workspace.setError(file.warning); setPlaying({ record: file.recording, url: URL.createObjectURL(file.blob) }); } catch (error) { workspace.setError(errorMessage(error)); } finally { setPreparing(''); } }
  async function download(record: Recording) {
    setPreparing(record.title);
    try {
      const file = await recordingFile(record);
      if (file.warning) workspace.setError(file.warning);
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement('a'); link.href = url; link.download = filename(record).split('/').pop()!; link.click();
      // Leave time for Chrome to resolve the Blob before releasing the link.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { workspace.setError(errorMessage(error)); }
    finally { setPreparing(''); }
  }
  const modal = playing && <div className="modal-backdrop" onClick={() => setPlaying(undefined)}><section className="player-modal" role="dialog" aria-modal="true" aria-label={playing.record.title} onClick={event => event.stopPropagation()}><div className="modal-heading"><strong>{playing.record.title}</strong><button className="icon-button" aria-label="Close player" onClick={() => setPlaying(undefined)}><X size={20}/></button></div><video src={playing.url} controls autoPlay/><p className="muted tiny">{playing.record.status !== 'saved' ? 'Recovered recordings may have an incomplete ending.' : 'Kept on your device. Yours to revisit.'}</p></section></div>;
  return { play, download, modal, preparing };
}
function Popup() {
  const workspace = useWorkspace();
  const { records, overview, error } = workspace;
  return <main className="popup"><header className="popup-header"><Brand/><button className="icon-button" title="Open recording library" aria-label="Open recording library" onClick={() => openPage('library.html')}><Library size={19}/></button></header>
    <RecordingCard workspace={workspace}/>
    {(error || overview.session.error) && <Notice kind="error">{error || overview.session.error}</Notice>}
    {overview.session.warning && <Notice>{overview.session.warning}</Notice>}
    <Preferences workspace={workspace} compact/>
    <div className="section-label"><h2>Recently kept</h2><button className="text-button" onClick={() => openPage('library.html')}>View library <ChevronRight size={13}/></button></div>
    {records.length ? records.slice(0, 2).map(record => <button key={record.id} className="recent-link" onClick={() => openPage(`library.html?play=${record.id}`)}><span className="record-icon"><Play size={14}/></span><span className="record-info"><strong>{record.title}</strong><small>{new Date(record.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {duration(record.duration).replace(/^00:/, '')}</small></span><ChevronRight size={14}/></button>) : <div className="popup-empty"><Folder size={20}/><p>Your next meeting belongs here.<small>Recordings will appear in your local library.</small></p></div>}
    <footer className="popup-footer"><ShieldCheck size={13}/><span>On your device. Under your control.</span><button aria-label="Recording settings" className="icon-button" onClick={() => openPage('library.html?settings=1')}><SlidersHorizontal size={14}/></button></footer>
  </main>;
}
function LibraryApp() {
  const workspace = useWorkspace();
  const { overview, records, error, loading } = workspace;
  const [section, setSection] = useState(new URLSearchParams(location.search).has('settings') ? 'settings' : 'recordings');
  const [query, setQuery] = useState('');
  const [managing, setManaging] = useState<Recording>();
  const [transcribing, setTranscribing] = useState<Recording>();
  const closeTranscript = useCallback(() => setTranscribing(undefined), []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState('');
  const playback = usePlayback(workspace);
  const [autoPlayed, setAutoPlayed] = useState(false);
  const saved = records.filter(record => record.id !== overview.session.recordingId);
  useEffect(() => {
    if (loading || autoPlayed) return;
    const record = records.find(record => record.id === new URLSearchParams(location.search).get('play'));
    if (record && record.id !== overview.session.recordingId) playback.play(record);
    setAutoPlayed(true);
  }, [loading]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setManaging(undefined); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  const filtered = records.filter(record => record.title.toLowerCase().includes(query.toLowerCase()));
  async function rename() { if (!managing || !name.trim()) return; try { await putRecording({ ...managing, title: name.trim() }); setManaging(undefined); await workspace.refresh(); } catch (error) { workspace.setError(errorMessage(error)); } }
  async function remove() { if (!managing) return; try { await deleteRecording(managing.id); setManaging(undefined); setConfirmDelete(false); await workspace.refresh(); } catch (error) { workspace.setError(errorMessage(error)); } }
  return <div className="app-shell"><aside className="sidebar"><Brand/><div className="workspace-label">YOUR WORKSPACE</div><nav><button className={section === 'recordings' ? 'selected' : ''} onClick={() => setSection('recordings')}><Library size={18}/>Recordings<span>{records.length}</span></button><button className={section === 'settings' ? 'selected' : ''} onClick={() => setSection('settings')}><SlidersHorizontal size={18}/>Preferences</button></nav><div className="sidebar-bottom"><span className="privacy-icon"><ShieldCheck size={23}/></span><strong>A little more present.</strong><p>A little less note-taking.<br/>Your meetings stay with you.</p><div><span className="small-dot"/> Local storage only</div></div></aside>
    <main className="workspace-main"><header className="workspace-header"><span>Personal workspace <ChevronRight size={13}/> {section === 'recordings' ? 'Recordings' : 'Preferences'}</span><a className="subtle-link" href="https://meet.google.com/" target="_blank" rel="noreferrer">Open Google Meet <ExternalLink size={13}/></a></header>
      <div className="workspace-content"><div className="page-title"><div className="eyebrow">LESS TO REMEMBER. MORE TO BE THERE FOR.</div><h1>{section === 'recordings' ? 'Your meetings, kept.' : 'Make it work for you.'}</h1><p>{section === 'recordings' ? 'A place for the conversations worth coming back to.' : 'Simple preferences for your next conversation.'}</p></div>
      {(error || overview.session.error) && <Notice kind="error">{error || overview.session.error}</Notice>}{overview.session.warning && <Notice>{overview.session.warning}</Notice>}
      {playback.preparing && <Notice>Preparing “{playback.preparing}”…</Notice>}
      {!inExtension && <Notice>Browser preview · To record meetings, build Meetkeep and load the dist folder as an unpacked Chrome extension.</Notice>}
      <div className="library-grid"><div className="library-primary">
      {section === 'recordings' ? <>
        <div className="stats"><div><span><Video size={15}/> Meetings kept</span><strong>{saved.length.toString().padStart(2, '0')}</strong></div><div><span><Clock3 size={15}/> Time captured</span><strong>{duration(saved.reduce((sum, record) => sum + record.duration, 0)).replace(/:\d{2}$/, '')}<small> hrs</small></strong></div><div><span><HardDrive size={15}/> On this device</span><strong>{bytes(records.reduce((sum, record) => sum + record.size, 0))}</strong></div></div>
        <section className="recordings-panel"><div className="recordings-heading"><h2>All recordings <span>{records.length}</span></h2><label className="search"><Search size={15}/><input aria-label="Search recordings" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a conversation…"/></label></div>
          {loading ? <div className="large-empty"><LoaderCircle className="spin" size={24}/><h3>Opening your library…</h3></div> : filtered.length ? <div className="record-list">{filtered.map(record => <RecordItem key={record.id} record={record} active={record.id === overview.session.recordingId} onPlay={() => playback.play(record)} onDownload={() => playback.download(record)} onTranscript={() => setTranscribing(record)} onManage={() => { setManaging(record); setName(record.title); setConfirmDelete(false); }}/>)}</div> : <div className="large-empty"><div className="empty-illustration"><span/><Video size={35} strokeWidth={1.3}/><span/></div><span className="eyebrow">{query ? 'NOTHING HERE YET' : 'THE START OF SOMETHING WORTH KEEPING'}</span><h3>{query ? 'No matching conversations.' : 'Be there. We’ll remember.'}</h3><p>{query ? 'Try a different meeting name.' : 'Click the small record button in the bottom-left of Meet to keep the complete tab.'}</p>{query ? <button className="button outline" onClick={() => setQuery('')}>Clear search</button> : <a className="button green" href="https://meet.google.com/" target="_blank" rel="noreferrer"><Video size={15}/> Open Google Meet <ArrowRight size={15}/></a>}</div>}
        </section><p className="library-note"><ShieldCheck size={14}/> Saved in this Chrome profile. Download a copy to keep outside your browser.</p>
      </> : <section className="settings-panel"><h2>Recording preferences</h2><p className="muted">A few small choices. Set them once.</p><Preferences workspace={workspace}/><div className="audio-note"><Headphones size={21}/><div><strong>Everyone’s voice, including yours.</strong><p>Tab audio captures other participants. Enable your microphone to include your voice too. Microphone recording is independent of Meet’s mute button.</p><button className="text-button" onClick={() => openPage('permission.html')}>Microphone setup <ArrowRight size={13}/></button></div></div></section>}
      </div><aside className="library-aside"><div className="how-card"><span className="how-icon"><CircleHelp size={20}/></span><h2>A meeting in three steps.</h2><ol><li><span>01</span><div><strong>Open your Google Meet</strong><p>Join your meeting as usual.</p></div></li><li><span>02</span><div><strong>Click the corner record button</strong><p>Choose this Meet tab and share its audio.</p></div></li><li><span>03</span><div><strong>Click again to stop and save</strong><p>Find your recording here or in your downloads.</p></div></li></ol><div className="how-footer"><ShieldCheck size={14}/><p>Let everyone know you’re recording. Meetkeep doesn’t notify participants.</p></div></div><div className="tip-card"><Mic size={17}/><p><strong>Your voice matters, too.</strong>Enable your microphone in Preferences to include your side of the conversation.</p><button className="text-button" onClick={() => setSection('settings')}>Set up audio <ArrowRight size={13}/></button></div></aside></div>
      </div><footer className="workspace-footer"><span>Made for being present.</span><span><span className="small-dot"/> No cloud. No account. Just your meetings.</span></footer>
    </main>{playback.modal}{transcribing && <TranscriptDialog recording={transcribing} onClose={closeTranscript}/>}
    {managing && <div className="modal-backdrop" onClick={() => setManaging(undefined)}><section className="manage-modal" role="dialog" aria-modal="true" aria-label="Manage recording" onClick={event => event.stopPropagation()}><div className="modal-heading"><h2>{confirmDelete ? 'Delete this recording?' : 'A name to remember.'}</h2><button className="icon-button" aria-label="Close" onClick={() => setManaging(undefined)}><X size={19}/></button></div>{confirmDelete ? <><p>This removes the local copy of “{managing.title}”. Downloaded copies stay on your device.</p><div className="modal-actions"><button className="button outline" onClick={() => setConfirmDelete(false)}>Keep it</button><button className="button danger" onClick={remove}><Trash2 size={15}/>Delete recording</button></div></> : <form onSubmit={event => { event.preventDefault(); rename(); }}><label className="field-label">Meeting name<input autoFocus maxLength={160} value={name} onChange={event => setName(event.target.value)}/></label><div className="modal-actions"><button type="button" className="text-button danger-text" onClick={() => setConfirmDelete(true)}><Trash2 size={14}/>Delete</button><button className="button green" disabled={!name.trim()}><Check size={15}/>Save name</button></div></form>}</section></div>}
  </div>;
}
function PermissionApp() {
  const [status, setStatus] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState('');
  async function allow() {
    setStatus('busy'); setError('');
    try {
      if (!inExtension) throw new Error('Open this setup page from the installed Chrome extension.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
      stream.getTracks().forEach(track => track.stop());
      await request('SETTINGS', { settings: { includeMic: true } });
      setStatus('done');
    } catch (error) { setError(`${errorMessage(error)} If access was blocked, allow the microphone in this page’s site settings and try again.`); setStatus('idle'); }
  }
  return <main className="permission-page"><Brand/><section><span className="permission-icon">{status === 'done' ? <Check size={30}/> : <Mic size={30}/>}</span><span className="eyebrow">YOUR SIDE OF THE CONVERSATION</span><h1>{status === 'done' ? 'You’re all set.' : 'Let your voice be heard.'}</h1><p>{status === 'done' ? 'Your microphone is enabled for future recordings. Return to your Meet tab to continue.' : 'Allow microphone access once to include your own voice alongside the meeting audio.'}</p>{error && <Notice kind="error">{error}</Notice>}{status === 'done' ? <button className="button green" onClick={() => { location.href = 'library.html?settings=1'; }}>Back to preferences <ArrowRight size={16}/></button> : <button className="button green" disabled={status === 'busy'} onClick={allow}>{status === 'busy' ? <LoaderCircle size={17} className="spin"/> : <Mic size={17}/>} {status === 'busy' ? 'Waiting for permission…' : 'Allow microphone'}</button>}<div className="permission-note"><ShieldCheck size={16}/><p>Audio stays on your device. When enabled, your microphone is recorded even if you mute yourself in Meet. You can turn it off in Preferences.</p></div><a className="text-button" href="library.html"><ArrowLeft size={13}/> Back to library</a></section></main>;
}
const page = location.pathname.split('/').pop();
createRoot(document.getElementById('root')!).render(page === 'popup.html' ? <Popup/> : page === 'permission.html' ? <PermissionApp/> : <LibraryApp/>);
