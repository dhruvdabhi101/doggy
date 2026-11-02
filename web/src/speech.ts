import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice capture via the browser's built-in speech recognition (Chrome, Edge, Safari incl. iOS).
 * No API key needed. Requires a secure context (https or localhost).
 * Next step: record audio with MediaRecorder and transcribe server-side (Deepgram/Whisper) for higher accuracy.
 */
type Rec = {
  continuous: boolean; interimResults: boolean; lang: string;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null;
};

const Ctor: (new () => Rec) | undefined =
  typeof window !== "undefined" ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) : undefined;

export const speechSupported = Boolean(Ctor) && (typeof window === "undefined" || window.isSecureContext);

export function useSpeech(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Rec | null>(null);
  const finalText = useRef("");
  const cb = useRef(onFinal);
  cb.current = onFinal;

  const start = useCallback(() => {
    if (!Ctor) return setError("Voice isn't supported in this browser. Try Chrome or Safari.");
    if (!window.isSecureContext) return setError("Voice needs HTTPS (or localhost). See README → phone access.");
    setError(null); setTranscript(""); finalText.current = "";
    const r = new Ctor();
    r.continuous = true; r.interimResults = true; r.lang = navigator.language || "en-US";
    r.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText.current += res[0].transcript + " ";
        else interim += res[0].transcript;
      }
      setTranscript((finalText.current + interim).trim());
    };
    r.onerror = (e: any) => { if (e.error !== "aborted" && e.error !== "no-speech") setError(`Voice error: ${e.error}`); };
    r.onend = () => {
      setListening(false);
      const text = finalText.current.trim();
      if (text) cb.current(text);
      rec.current = null;
    };
    rec.current = r;
    r.start();
    setListening(true);
  }, []);

  const stop = useCallback(() => rec.current?.stop(), []);
  const cancel = useCallback(() => { finalText.current = ""; rec.current?.abort(); setTranscript(""); }, []);
  useEffect(() => () => rec.current?.abort(), []);

  return { listening, transcript, error, start, stop, cancel };
}
