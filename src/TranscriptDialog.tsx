import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, FileText, LoaderCircle, Square, X } from 'lucide-react';
import { getTranscript } from './db';
import { duration, errorMessage, type Recording, type Transcript } from './shared';
import { englishAvailability, installEnglish, transcribeRecording, type SpeechAvailability, type SpeechProgress } from './speech';
import { srtFilename, toSrt } from './subtitles';

export function TranscriptDialog({ recording, onClose }: { recording: Recording; onClose: () => void }) {
  const [availability, setAvailability] = useState<SpeechAvailability | 'checking'>('checking');
  const [transcript, setTranscript] = useState<Transcript>();
  const [progress, setProgress] = useState<SpeechProgress>();
  const [working, setWorking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    getTranscript(recording.id).then(saved => { if (mounted.current) setTranscript(saved); })
      .catch(problem => { if (mounted.current) setError(errorMessage(problem)); });
    englishAvailability().then(available => { if (mounted.current) setAvailability(available); })
      .catch(problem => { if (mounted.current) { setError(errorMessage(problem)); setAvailability('unavailable'); } });
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const controls = closeButton.current?.closest('section')?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex="0"]');
        if (!controls?.length) return;
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
        else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => { mounted.current = false; controller.current?.abort(); window.removeEventListener('keydown', key); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [recording.id, onClose]);

  async function install() {
    setInstalling(true); setError('');
    try {
      const installed = await installEnglish();
      const available = await englishAvailability();
      if (mounted.current) {
        setAvailability(available);
        if (!installed || available !== 'available') setError('The English pack is not ready yet. Check your internet connection and try again.');
      }
    } catch (problem) { if (mounted.current) setError(errorMessage(problem)); }
    finally { if (mounted.current) setInstalling(false); }
  }
  async function transcribe() {
    if (controller.current) return;
    const task = new AbortController(); controller.current = task;
    setWorking(true); setError(''); setProgress({ phase: 'loading', processedMs: 0, durationMs: recording.duration, cues: [] });
    try {
      const saved = await transcribeRecording(recording, task.signal, value => { if (mounted.current) setProgress(value); });
      const stored = await getTranscript(recording.id);
      if (mounted.current) setTranscript(stored ?? saved);
    } catch (problem) {
      if (mounted.current) {
        if (!(problem instanceof DOMException && problem.name === 'AbortError')) setError(errorMessage(problem));
        try { const saved = await getTranscript(recording.id); if (mounted.current) setTranscript(saved); } catch { /* Keep the transcription error visible. */ }
      }
    } finally {
      controller.current = undefined;
      if (mounted.current) { setWorking(false); setProgress(undefined); }
    }
  }
  function download() {
    if (!transcript?.cues.length) return;
    const url = URL.createObjectURL(new Blob([toSrt(transcript.cues)], { type: 'application/x-subrip;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = srtFilename(recording); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  const cues = progress?.cues ?? transcript?.cues ?? [];
  const percent = progress?.durationMs ? Math.min(100, Math.round(progress.processedMs / progress.durationMs * 100)) : 0;
  return <div className="modal-backdrop"><section className="transcript-modal" role="dialog" aria-modal="true" aria-labelledby="transcript-title">
    <div className="modal-heading"><h2 id="transcript-title"><FileText size={20}/> English transcript</h2><button ref={closeButton} className="icon-button" aria-label="Close transcript" onClick={onClose}><X size={20}/></button></div>
    <p className="transcript-recording">{recording.title}</p>
    <p className="muted tiny">Chrome transcribes on your device. Keep this tab open; it takes roughly the recording’s length. Subtitle timing is approximate.</p>
    {error && <div className="notice error" role="alert">{error}</div>}
    {availability === 'checking' && <p role="status" className="transcript-status"><LoaderCircle size={16} className="spin"/> Checking Chrome’s speech tools…</p>}
    {availability === 'unavailable' && <div className="notice">Local transcription needs desktop Chrome 139 or newer with on-device speech recognition available. Update Chrome or check whether your browser supports it.</div>}
    {(availability === 'downloadable' || availability === 'downloading') && <div className="transcript-install"><p>Chrome needs a one-time English language pack download. Your recordings stay on this device.</p><button className="button outline" onClick={install} disabled={installing}>{installing ? <LoaderCircle size={16} className="spin"/> : <ArrowDownToLine size={16}/>} {installing ? 'Downloading English pack…' : 'Download English language pack'}</button></div>}
    {working && progress && <div className="transcript-progress" role="status"><div><span><LoaderCircle size={15} className="spin"/>{progress.phase === 'loading' ? 'Preparing audio…' : progress.phase === 'finishing' ? 'Finishing transcript…' : 'Transcribing…'}</span><span>{duration(progress.processedMs)} / {duration(progress.durationMs)}</span></div><progress max={100} value={percent} aria-label="Transcription progress"/></div>}
    <div className="transcript-cues" tabIndex={0} aria-label="Transcript preview">{cues.length ? cues.map((cue, index) => <p key={index}><time>{duration(cue.startMs)}</time><span>{cue.text}</span></p>) : <div className="transcript-empty"><FileText size={27}/><p>{working ? 'Recognized speech will appear here.' : transcript?.status === 'completed' ? 'No English speech was detected in the saved audio.' : 'Turn your saved meeting into English subtitles.'}</p></div>}</div>
    <div className="transcript-actions"><span className="muted tiny">{!working && transcript && (transcript.status === 'partial' ? 'Partial transcript saved' : 'Transcript saved on this device')}</span><div>
      {working ? <button className="button outline" onClick={() => controller.current?.abort()}><Square size={13}/> Stop</button> : availability === 'available' && <button className="button outline" onClick={transcribe}>{transcript ? 'Transcribe again' : 'Transcribe in English'}</button>}
      {!working && !!transcript?.cues.length && <button className="button green" onClick={download}><ArrowDownToLine size={15}/>{transcript.status === 'partial' ? 'Download partial SRT' : 'Download SRT'}</button>}
    </div></div>
  </section></div>;
}
