# Meetkeep

A manual browser-tab recorder with a small Google Meet control, built with React, TypeScript, Vite, and Chrome Manifest V3. Recordings stay on your device; no account, server, or cloud uploads.

## Install or update

Recording requires Chrome 116+. On-device English transcription requires desktop Chrome 139+ with its local speech service available. Development requires Node.js 22.12+.

Download `Meetkeep-extension.zip` from the [latest GitHub release](https://github.com/mesutrk95/chrome-recorder-extension/releases/latest) and unpack it. To build from source instead, run `npm ci` and `npm run build`.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the folder containing `manifest.json` (`dist` for source builds). To update an existing installation, replace the contents of its current extension folder with the new build and click **Reload**.
3. Refresh existing Meet tabs **after your call** to load the new recording control and remove older scripts. During a call, the popup can record without refreshing the meeting.
4. In a meeting, use the 28px icon-only button fixed **8px from the bottom-left edges**.

Keep the existing extension installed in the same folder when updating to preserve its local library.

## Record any tab from the popup

Open the website tab you want to record, click Meetkeep in Chrome’s toolbar, then click **Start recording**. The popup shows the current tab’s title. This works on ordinary HTTPS/HTTP websites, including other meeting services, videos, and presentations; it does not require Google Meet or a page script. File tabs depend on Chrome’s file-access setting. Chrome’s internal and extension pages are excluded.

Use **Pause**, **Resume**, and **Stop & save** in the popup. Closing the popup does not stop recording. A generic tab recording continues through page navigation/reloads until you stop it, close the captured tab, or Chrome ends the capture. Date/time and the original tab title are used for naming. Videos get the same local library, seek index, downloads, and optional English SRT transcription as Meet recordings.

The popup uses the existing `activeTab` and `tabCapture` permissions after your toolbar click. Meetkeep does not request access to all websites or inject its corner button outside Meet. The Meet-specific leave detection still applies when recording a recognized Meet meeting.

## Record from the meeting page

- **Outlined dot**: click to start. Chrome opens its sharing chooser with the current tab preferred. Select **this Meet tab**, enable **Share tab audio**, and click **Share**.
- **Red stop icon**: recording is running. Click to **stop and save**.
- **Amber pause icon**: if you pause from the extension popup, click to resume.
- A small spinner shows when starting or saving. Status and elapsed time are available on hover; the button has no visible text.

Nothing starts automatically, including when you join a meeting. The previous automatic media-stream recorder has been removed. If another tab is being recorded, the corner control indicates that and prevents a second simultaneous recording.

The recording captures the tab's **visible page content**, including participant tiles, presentations, chat, captions, controls, and the recording indicator itself. Content that is closed, scrolled out of view, or never shown is not captured. It does not record other tabs or your desktop when you choose the Meet tab.

Selecting a tab in Chrome's chooser is required for starting from the page. Chrome does not let a page button silently authorize a new full-tab capture. Canceling the chooser leaves the button idle. If tab audio is missing, Meetkeep explains how to enable it rather than saving a silent recording.

You can also open Meetkeep from Chrome's toolbar and click **Start recording**. Invoking the extension grants tab-capture access, so that path starts directly without the page sharing chooser. Both paths record the complete tab; both update the meeting-page indicator. Pause/resume and Stop & save are available in the popup.

Both `https://meet.google.com/abc-defg-hij` and `https://meet.google.com/meet/abc-defg-hij` are recognized. Switching between these URL forms for the same meeting does not stop an active recording.

If an extension update disconnected the corner button in an already-open tab, manual popup recording still works using the active Meet tab. Use **Stop & save** in the popup; automatic stop based on the leave button is unavailable until the page control reconnects. Closing the Meet tab still stops and saves the recording. Refresh the Meet tab after the call to restore the corner button.

Once you have started recording, leaving a detected meeting stops and saves after about 8–10 seconds. Brief Meet interface redraws are tolerated. If you start in the lobby, leaving is tracked after you actually join. Manually stopping never starts another recording automatically.

## Audio, quality, and names

- Tab audio includes other participants. **Include my microphone** is off by default; enable it in Preferences to include your voice.
- Microphone capture is independent of Meet's mute button. Turn it off in Preferences if you do not want your side recorded.
- Toolbar recording uses extension microphone permission, configured on the **Microphone setup** page. Starting from the in-meeting button uses microphone permission for Meet, which is usually already granted for the call; Chrome can ask for it if necessary.
- Video targets up to 720p or 1080p at 30 fps. Actual dimensions depend on the tab, Chrome, and available resources.
- New recordings are named with local start date/time and the full tab title: `2026-10-15 15:30 — Meet - Team sync`. Download filenames replace characters such as `:` for filesystem compatibility.
- Videos are WebM. **Download when finished** saves a copy under `Downloads/Meetkeep`, subject to Chrome's download settings. Recordings also remain in the library.
- Meetkeep does not notify participants. Let everyone know before recording.

## Library and recovery

The library supports playback, search, rename, download, and delete. Video chunks are saved to extension-owned IndexedDB roughly every three seconds. Preferences use `chrome.storage.local`; session metadata uses `chrome.storage.session`.

Recording from the page transfers chunks to the offscreen document for storage and download preparation. Closing or reloading that tab can lose its final chunk; already-saved chunks are recovered and marked interrupted. Toolbar recordings run entirely in the offscreen document. Abrupt browser termination can interrupt either mode. Recovery cannot guarantee a playable file after every interruption.

Download and playback assembly create a complete Blob, so very large recordings need available memory as well as disk space. Uninstalling the extension or clearing its data deletes the local library. Keep downloaded copies of important recordings.

## Video loading and seeking

After recording stops, Meetkeep writes the media duration, a `SeekHead`, and a video-keyframe `Cues` index **before the media clusters**. Players can read the timeline and jump directly to another point without first scanning the complete recording. The media clusters remain byte-for-byte unchanged; this is metadata finalization, with no audio/video decoding, re-encoding, quality loss, or server upload.

Finalization runs once at save time, including when automatic downloads are disabled. Older saved library recordings are repaired on their first playback, download, or transcription and then retained in that form. **Download older videos again from the library** to get the improved file; copies already saved outside Chrome do not change automatically.

There is a one-time CPU and disk-I/O cost when saving or preparing an older file. Processing time grows with file size. The parser uses a bounded 1 MiB read cache and Blob slices instead of copying the entire encoded video into a JavaScript ArrayBuffer, and yields during long scans to keep the page responsive. The small metadata index adds little to the video size. Browser-managed Blob storage and an atomic IndexedDB replacement can still need temporary storage space while both versions exist.

If a recovered file is incomplete or storage cannot commit the prepared version, Meetkeep keeps the original recording and shows a warning. It does not replace a saved video with a partially processed result. A prepared file remains available for that download even if caching it fails.

## English transcripts and SRT

1. Open the recording library and click the **document icon** beside a saved video.
2. If prompted, click **Download English language pack**. Chrome downloads its on-device recognition model once; a connection is required for this download.
3. Click **Transcribe in English** and keep the library tab open. The saved recording is decoded silently and fed directly to Chrome’s speech recognizer at normal playback speed. A one-hour meeting takes roughly one hour to transcribe.
4. Click **Download SRT** to save an English `.en.srt` subtitle file with the same base filename as the video. Transcripts remain in the library for later downloads.

Transcription uses `SpeechRecognition` with `processLocally: true` and an explicit saved-audio track. It does not listen to your microphone, upload the recording, or fall back to cloud recognition. Chrome availability varies by desktop installation and policy; unsupported browsers show an explanation. Recording itself remains available on older supported Chrome versions.

Chrome does not return word timestamps. Subtitle times are **approximate**, estimated from playback and speech events; long passages are split into readable cues. Review subtitles before publishing. Recognition accuracy depends on the recorded audio and English speech; missing voices cannot be recovered from a video whose audio was not captured.

Use **Stop** to keep a partial transcript and download a partial SRT. Closing the panel also stops transcription and preserves recognized segments. You can transcribe again from the beginning. Deleting a recording deletes its locally saved transcript. Keep downloaded copies; uninstalling the extension removes both.

If Chrome’s model download stalls, the panel stops waiting after two minutes and explains how to retry. The readiness check also handles Chrome builds that miss their install-completion callback. Updating Chrome or enabling English Live Caption in Chrome’s Accessibility settings may help initialize its speech components.

## Development and checks

```sh
npm run dev             # UI preview only
npm run check           # Unit tests, TypeScript, production build
npx playwright install chromium
npm run test:browser    # Popup/library UI and offscreen recorder checks
npm run test:extension  # Built extension and persistent preferences
npm run test:meeting    # Actual full-tab capture through the corner control
npm run test:tab        # Actual popup recording of a non-Meet browser tab
npm run test:transcription:native # Optional actual English speech model test (Windows)
```

Open `http://127.0.0.1:5173/library.html` or `/popup.html` for the UI preview. Actual recording requires the installed extension on Meet.

## Publish a release

Update `package.json` and `package-lock.json` with `npm version <version> --no-git-tag-version`, then set the same version in `public/manifest.json`. Commit and push the version changes. Tag that commit with `v` followed by the version (for example, `v1.4.1`) and push the tag. GitHub Actions runs the unit tests and production build, then attaches `Meetkeep-extension.zip` to the release.

The meeting-control test uses a local simulated Meet page with distinct chat and control panels, generated tab audio, and Chrome's real tab-sharing capture. It checks that recording stays manual, the corner button changes status, pause/resume works, the downloaded video decodes with the chat/control pixels included, names contain the date and title, and closing the tab recovers saved chunks. Chrome's picker auto-selection flag is used **only in the isolated test browser**, never in the shipped extension.

The generic-tab test invokes the actual toolbar action through Chrome’s test automation protocol in a disposable browser profile. It runs the same built popup HTML in a background extension tab because headless Chrome does not expose toolbar popup windows as Playwright pages. It checks native tab capture on non-Meet sites, continuation through navigation/reload, popup stop/save, and tab-close saving. The unsafe-extension-debugging test flag is confined to that isolated test profile; it is not part of the extension or normal installation.

A short real Meet call is still useful to check your microphone and Google’s current leave-control detection. Start recording, speak with another participant, stop, and play the downloaded file.

Transcript browser tests use controlled speech-recognition results with real media decoding (including a recorded WebM video) to check local audio routing, saved results, cancellation, unsupported browsers, and SRT downloads. Unit checks cover subtitle formatting, migration of existing libraries, and stalled language-pack downloads. These checks do not measure speech-recognition accuracy.

Video finalization checks independently inspect `SeekHead` and every cue destination in a real Chrome recording, confirm the index precedes media, compare SHA-256 hashes of the original and finalized media clusters, and jump to 80% before playing. Unit checks cover unknown-sized clusters, duration scales, audio-only files, repeated processing, large packets, and incomplete recordings.

The optional native test synthesizes an English WAV locally with Windows System.Speech, launches an empty Chrome testing profile, downloads Chrome’s actual English model, and checks recognized text plus SRT output. It requires internet access and a working Chrome component downloader. The initial native verification here was blocked by a stalled language-pack download; actual model recognition remains to be verified on a Chrome installation where the pack is available.

## Structure

- `src/content.ts`: compact meeting-page control, user-initiated full-tab sharing, MediaRecorder, and chunk transfer.
- `src/detection.ts`: semantic Meet join/leave detection.
- `src/background.ts`: routing, toolbar tab capture, status broadcasts, settings, and downloads.
- `src/offscreen.ts`: durable chunks, download preparation, and the toolbar recorder.
- `src/main.tsx` / `src/styles.css`: React popup, library, preferences, and microphone setup.
- `src/db.ts`: IndexedDB metadata and video chunks.
- `src/webm.ts`: bounded-memory WebM metadata finalization and front keyframe index.
- `src/speech.ts` / `src/TranscriptDialog.tsx`: on-device English transcription and its library panel.
- `src/subtitles.ts`: readable SRT serialization and matching subtitle filenames.

Meet host access enables the page control and call detection. `offscreen` supports persistent recording/storage and Blob downloads, `storage` keeps preferences/session metadata, `downloads` saves files, and `unlimitedStorage` avoids the normal extension storage quota while disk-space limits still apply. `activeTab` and `tabCapture` support starting from the toolbar.

References: [tabCapture and user invocation](https://developer.chrome.com/docs/extensions/reference/api/tabCapture), [display capture and its chooser](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).

Transcription references: [Chrome’s on-device speech API](https://developer.chrome.com/blog/new-in-chrome-139#on-device-web-speech-api), [recognizing a saved audio track](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start), [local recognition and language packs](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally).
