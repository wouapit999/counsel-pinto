"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/*
 * Web Speech API wrappers.
 *
 * Recognition is Chromium-only in practice (webkitSpeechRecognition); Firefox
 * ships nothing and Safari's support is partial. Both hooks report their own
 * availability so the UI can hide the controls rather than offer a dead button.
 *
 * Capability is read through useSyncExternalStore rather than an effect: it is
 * a fixed property of the environment, false on the server and constant on the
 * client, so this gives a correct hydration pass with no cascading render.
 */

type RecognitionAlternative = { transcript: string };
type RecognitionResult = {
  0: RecognitionAlternative;
  isFinal: boolean;
  length: number;
};
type RecognitionEvent = {
  resultIndex: number;
  results: { length: number; [i: number]: RecognitionResult };
};
type RecognitionErrorEvent = { error: string };

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type RecognitionCtor = new () => SpeechRecognitionLike;

/** Stable no-op subscription — these capabilities never change at runtime. */
const neverChanges = () => () => {};
const serverFalse = () => false;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Dictation.
 *
 * Transcribed text is pushed straight into the caller's input via
 * `onTranscript` — it is never held here. Speech fills the box; sending stays
 * the user's decision.
 *
 * Chrome ends a recognition session after a few seconds of silence even with
 * `continuous = true`, so a session that is meant to keep listening has to be
 * restarted from `onend`. Without that, the mic appears to switch itself off
 * moments after being switched on.
 */
export function useDictation(locale: string, onTranscript: (text: string) => void) {
  const supported = useSyncExternalStore(
    neverChanges,
    () => recognitionCtor() !== null,
    serverFalse,
  );

  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const emitRef = useRef(onTranscript);
  /** Whether the user still wants to be listening — drives auto-restart. */
  const wantRef = useRef(false);
  /** Text already in the box when dictation started; speech appends to it. */
  const baseRef = useRef("");
  /** Everything finalised so far this session, across restarts. */
  const settledRef = useRef("");
  /** Guards against a restart loop when the mic yields nothing at all. */
  const emptyRestartsRef = useRef(0);

  useEffect(() => {
    emitRef.current = onTranscript;
  }, [onTranscript]);

  const emit = useCallback((extra: string) => {
    const parts = [baseRef.current.trim(), (settledRef.current + extra).trim()];
    emitRef.current(parts.filter(Boolean).join(" "));
  }, []);

  const stop = useCallback(() => {
    wantRef.current = false;
    recRef.current?.stop();
    setListening(false);
  }, []);

  const begin = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;

    const rec = new Ctor();
    rec.lang = locale;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    // Only trust the engine's own start event — rec.start() resolves later,
    // and the permission prompt can sit in front of it for a while.
    rec.onstart = () => {
      setListening(true);
      setError(null);
    };

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) settledRef.current += chunk;
        else interim += chunk;
      }
      emptyRestartsRef.current = 0;
      emit(interim);
    };

    rec.onerror = (e) => {
      // Silence and self-inflicted aborts are normal punctuation in a long
      // dictation, not failures — the restart in onend handles them.
      if (e.error === "no-speech" || e.error === "aborted") return;

      wantRef.current = false;
      setError(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone access is blocked. Allow it for this site in your browser settings, then try again."
          : e.error === "audio-capture"
            ? "No microphone was found. Check that one is connected and enabled."
            : e.error === "network"
              ? "Speech recognition needs a network connection and could not reach the service."
              : `Speech recognition failed (${e.error}).`,
      );
      setListening(false);
    };

    rec.onend = () => {
      if (!wantRef.current) {
        setListening(false);
        return;
      }
      // Chrome's idle timeout. Pick the session back up.
      emptyRestartsRef.current += 1;
      if (emptyRestartsRef.current > 4) {
        wantRef.current = false;
        setListening(false);
        setError("I didn't catch anything. Check the microphone and try again.");
        return;
      }
      try {
        rec.start();
      } catch {
        wantRef.current = false;
        setListening(false);
      }
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch {
      wantRef.current = false;
      setListening(false);
      setError("Could not start the microphone. Close anything else using it and try again.");
    }
  }, [locale, emit]);

  /** `base` is the text already typed; dictation is appended to it. */
  const start = useCallback(
    (base = "") => {
      recRef.current?.abort();
      setError(null);
      baseRef.current = base;
      settledRef.current = "";
      emptyRestartsRef.current = 0;
      wantRef.current = true;
      begin();
    },
    [begin],
  );

  useEffect(
    () => () => {
      wantRef.current = false;
      recRef.current?.abort();
    },
    [],
  );

  return { supported, listening, error, start, stop };
}

/**
 * Reduce markdown to something worth hearing. Screen-reading raw markdown is
 * unbearable — asterisks, pipes and URLs all get spoken literally.
 */
export function toSpeech(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?```/g, " ") // fenced code
      .replace(/^\s*\|.*\|\s*$/gm, " ") // table rows
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → their text
      .replace(/^#{1,6}\s+/gm, "") // headings
      .replace(/^\s*[-*+]\s+/gm, "") // bullets
      .replace(/^\s*\d+\.\s+/gm, "") // numbered items
      .replace(/^\s*>\s?/gm, "") // block quotes
      .replace(/^\s*[-*_]{3,}\s*$/gm, " ") // rules
      .replace(/(\*\*|__|\*|_|`)/g, "") // inline emphasis
      .replace(/https?:\/\/\S+/g, " ") // bare URLs
      // Every remaining line break was a sentence or list boundary; give the
      // synthesiser a full stop so items don't run together.
      .replace(/\n+/g, ". ")
      .replace(/(?:\s*\.){2,}/g, ".")
      .replace(/\s+/g, " ")
      .replace(/\s+([.,;:!?])/g, "$1")
      .trim()
  );
}

/** Reading answers aloud, in the reply language. */
export function useNarration(locale: string) {
  const supported = useSyncExternalStore(
    neverChanges,
    () => typeof window !== "undefined" && "speechSynthesis" in window,
    serverFalse,
  );

  const [speaking, setSpeaking] = useState(false);

  // Voices don't drive rendering, so a ref avoids both a render pass and the
  // async-population race (Chromium fills the list after first paint).
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;

    const load = () => {
      voicesRef.current = window.speechSynthesis.getVoices();
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", load);
      window.speechSynthesis.cancel();
    };
  }, []);

  const cancel = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback(
    (markdown: string) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      const text = toSpeech(markdown);
      if (!text) return;

      window.speechSynthesis.cancel();

      const voices = voicesRef.current;
      const prefix = locale.slice(0, 2).toLowerCase();
      const voice =
        voices.find((v) => v.lang.replace("_", "-") === locale) ??
        voices.find((v) => v.lang.toLowerCase().startsWith(prefix));

      // Long answers can exceed engine limits; batch on sentence boundaries.
      const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
      const batches: string[] = [];
      let buf = "";
      for (const s of sentences) {
        if ((buf + s).length > 220) {
          if (buf) batches.push(buf);
          buf = s;
        } else {
          buf += s;
        }
      }
      if (buf) batches.push(buf);

      batches.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part);
        u.lang = locale;
        if (voice) u.voice = voice;
        u.rate = 0.98;
        u.pitch = 1;
        if (i === 0) u.onstart = () => setSpeaking(true);
        if (i === batches.length - 1) {
          u.onend = () => setSpeaking(false);
          u.onerror = () => setSpeaking(false);
        }
        window.speechSynthesis.speak(u);
      });
    },
    [locale],
  );

  return { supported, speaking, speak, cancel };
}
