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

/** Dictation. `transcript` updates live; `onFinal` fires once per utterance. */
export function useDictation(locale: string, onFinal: (text: string) => void) {
  const supported = useSyncExternalStore(
    neverChanges,
    () => recognitionCtor() !== null,
    serverFalse,
  );

  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const ref = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef(onFinal);

  // Keep the callback current without re-creating the recogniser.
  useEffect(() => {
    finalRef.current = onFinal;
  }, [onFinal]);

  const stop = useCallback(() => {
    ref.current?.stop();
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) return;

    ref.current?.abort();
    setError(null);
    setTranscript("");

    const rec = new Ctor();
    rec.lang = locale;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let settled = "";

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) settled += chunk;
        else interim += chunk;
      }
      setTranscript((settled + interim).trim());
    };

    rec.onerror = (e) => {
      setError(
        e.error === "not-allowed"
          ? "Microphone access was blocked. Allow it in your browser's site settings."
          : e.error === "no-speech"
            ? "I didn't catch anything — try again."
            : `Speech recognition failed (${e.error}).`,
      );
      setListening(false);
    };

    rec.onend = () => {
      setListening(false);
      const text = settled.trim();
      if (text) finalRef.current(text);
    };

    ref.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setError("Could not start the microphone.");
    }
  }, [locale]);

  useEffect(() => () => ref.current?.abort(), []);

  return { supported, listening, transcript, error, start, stop };
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
