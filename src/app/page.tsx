"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DEVELOPER,
  DISCLAIMER,
  EFFORTS,
  GREETING,
  JURISDICTIONS,
  LANGUAGES,
  SUGGESTIONS,
  type EffortId,
  type JurisdictionId,
  type LanguageId,
} from "@/lib/counsel";

type Turn = { id: string; role: "user" | "assistant"; content: string };

const STORAGE_KEY = "counsel-pinto/session-v1";

type Persisted = {
  turns: Turn[];
  jurisdiction: JurisdictionId;
  language: LanguageId;
  effort: EffortId;
};

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

export default function Page() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [jurisdiction, setJurisdiction] = useState<JurisdictionId>("auto");
  const [language, setLanguage] = useState<LanguageId>("auto");
  const [effort, setEffort] = useState<EffortId>("high");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Restore the previous session.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Persisted>;
        if (Array.isArray(saved.turns)) setTurns(saved.turns);
        if (saved.jurisdiction) setJurisdiction(saved.jurisdiction);
        if (saved.language) setLanguage(saved.language);
        if (saved.effort) setEffort(saved.effort);
      }
    } catch {
      /* corrupted storage — start fresh */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const payload: Persisted = { turns, jurisdiction, language, effort };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota exceeded — not fatal */
    }
  }, [hydrated, turns, jurisdiction, language, effort]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns, busy]);

  const activeJurisdiction = useMemo(
    () => JURISDICTIONS.find((j) => j.id === jurisdiction)!,
    [jurisdiction],
  );

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busy) return;

      setError(null);
      setNotice(null);
      setInput("");

      const userTurn: Turn = { id: newId(), role: "user", content: question };
      const assistantId = newId();
      const history = [...turns, userTurn];

      setTurns([...history, { id: assistantId, role: "assistant", content: "" }]);
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            messages: history.map(({ role, content }) => ({ role, content })),
            jurisdiction,
            language,
            effort,
          }),
        });

        if (!res.ok || !res.body) {
          const detail = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(detail?.error ?? `Request failed (${res.status}).`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const consume = (raw: string) => {
          if (!raw.trim()) return;
          const evt = JSON.parse(raw) as
            | { type: "text"; text: string }
            | { type: "notice"; text: string }
            | { type: "error"; message: string }
            | { type: "done" };

          if (evt.type === "text") {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId ? { ...t, content: t.content + evt.text } : t,
              ),
            );
          } else if (evt.type === "notice") {
            setNotice(evt.text);
          } else if (evt.type === "error") {
            setError(evt.message);
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const l of lines) consume(l);
        }
        consume(buffer);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : "Something went wrong.");
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
        // Drop an assistant turn that never produced anything.
        setTurns((prev) =>
          prev.filter((t) => !(t.id === assistantId && t.content === "")),
        );
      }
    },
    [busy, turns, jurisdiction, language, effort],
  );

  const stop = () => abortRef.current?.abort();

  const reset = () => {
    stop();
    setTurns([]);
    setError(null);
    setNotice(null);
    setInput("");
    textareaRef.current?.focus();
  };

  const exportTranscript = () => {
    const header = [
      "# Counsel Pinto — consultation transcript",
      "",
      `- Jurisdiction: ${activeJurisdiction.label}`,
      `- Language: ${LANGUAGES.find((l) => l.id === language)!.label}`,
      `- Exported: ${new Date().toISOString()}`,
      "",
      `> ${DISCLAIMER}`,
      "",
      "---",
      "",
    ].join("\n");

    const body = turns
      .map(
        (t) => `## ${t.role === "user" ? "Question" : "Counsel Pinto"}\n\n${t.content}`,
      )
      .join("\n\n---\n\n");

    const footer = `\n\n---\n\n_${DEVELOPER.credit}._\n`;

    const blob = new Blob([header + body + footer], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `counsel-pinto-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const suggestions = SUGGESTIONS.filter(
    (s) => jurisdiction === "auto" || s.jurisdiction === jurisdiction,
  ).slice(0, 4);

  const sidebarProps = {
    jurisdiction,
    setJurisdiction,
    language,
    setLanguage,
    effort,
    setEffort,
    reset,
    exportTranscript,
    canExport: turns.length > 0,
  };

  return (
    <div className="flex h-dvh flex-col">
      <Header
        jurisdictionLabel={activeJurisdiction.short}
        onTogglePanel={() => setPanelOpen((v) => !v)}
        panelOpen={panelOpen}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          className="hidden w-72 shrink-0 border-r border-line lg:flex"
          {...sidebarProps}
        />

        {panelOpen && (
          <div className="fixed inset-0 z-30 lg:hidden">
            <button
              aria-label="Close settings"
              className="absolute inset-0 bg-black/40"
              onClick={() => setPanelOpen(false)}
            />
            <Sidebar
              className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] border-r border-line shadow-xl"
              onNavigate={() => setPanelOpen(false)}
              {...sidebarProps}
            />
          </div>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
              {turns.length === 0 ? (
                <EmptyState
                  greeting={GREETING[language]}
                  jurisdictionBlurb={activeJurisdiction.blurb}
                  suggestions={suggestions}
                  onPick={(p) => void send(p)}
                />
              ) : (
                <div className="space-y-6">
                  {turns.map((t) => (
                    <Message key={t.id} turn={t} />
                  ))}
                  {busy && <Thinking />}
                </div>
              )}

              {notice && (
                <Banner tone="notice" className="mt-6">
                  {notice}
                </Banner>
              )}
              {error && (
                <Banner tone="error" className="mt-6">
                  {error}
                </Banner>
              )}
            </div>
          </div>

          <Composer
            value={input}
            onChange={setInput}
            onSubmit={() => void send(input)}
            onKeyDown={onKeyDown}
            onStop={stop}
            busy={busy}
            textareaRef={textareaRef}
            jurisdictionLabel={activeJurisdiction.short}
          />
        </main>
      </div>
    </div>
  );
}

/* ---------------- pieces ---------------- */

function Header({
  jurisdictionLabel,
  onTogglePanel,
  panelOpen,
}: {
  jurisdictionLabel: string;
  onTogglePanel: () => void;
  panelOpen: boolean;
}) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-3 sm:px-6">
      <button
        onClick={onTogglePanel}
        aria-expanded={panelOpen}
        aria-label="Toggle settings"
        className="-ml-1 rounded-md p-2 text-muted hover:bg-surface-muted hover:text-foreground lg:hidden"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
        </svg>
      </button>

      <div className="flex min-w-0 items-baseline gap-2">
        <span className="font-serif text-lg font-semibold tracking-tight">
          Counsel Pinto
        </span>
        <span className="hidden truncate text-xs text-muted sm:inline">
          AI Legal Counsel · Cameroon · Mozambique · CEMAC
        </span>
      </div>

      <span className="ml-auto shrink-0 rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
        {jurisdictionLabel}
      </span>
    </header>
  );
}

function Sidebar({
  className = "",
  jurisdiction,
  setJurisdiction,
  language,
  setLanguage,
  effort,
  setEffort,
  reset,
  exportTranscript,
  canExport,
  onNavigate,
}: {
  className?: string;
  jurisdiction: JurisdictionId;
  setJurisdiction: (v: JurisdictionId) => void;
  language: LanguageId;
  setLanguage: (v: LanguageId) => void;
  effort: EffortId;
  setEffort: (v: EffortId) => void;
  reset: () => void;
  exportTranscript: () => void;
  canExport: boolean;
  onNavigate?: () => void;
}) {
  return (
    <aside className={`flex-col overflow-y-auto bg-surface ${className}`}>
      <div className="flex flex-1 flex-col gap-6 p-4">
        <Field label="Jurisdiction">
          <div className="space-y-1">
            {JURISDICTIONS.map((j) => (
              <button
                key={j.id}
                onClick={() => {
                  setJurisdiction(j.id);
                  onNavigate?.();
                }}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                  jurisdiction === j.id
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-foreground hover:bg-surface-muted"
                }`}
              >
                {j.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Reply language">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as LanguageId)}
            className="w-full rounded-lg border border-line bg-background px-3 py-2 text-sm outline-none focus:border-accent"
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.native === "Auto" ? l.label : `${l.native} — ${l.label}`}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Analysis depth">
          <div className="flex rounded-lg border border-line p-0.5">
            {EFFORTS.map((e) => (
              <button
                key={e.id}
                title={e.blurb}
                onClick={() => setEffort(e.id)}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition ${
                  effort === e.id
                    ? "bg-accent text-accent-contrast"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {e.label}
              </button>
            ))}
          </div>
        </Field>

        <div className="mt-auto space-y-2 pt-4">
          <button
            onClick={() => {
              reset();
              onNavigate?.();
            }}
            className="w-full rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-surface-muted"
          >
            New consultation
          </button>
          <button
            onClick={exportTranscript}
            disabled={!canExport}
            className="w-full rounded-lg border border-line px-3 py-2 text-sm font-medium hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            Export transcript
          </button>
          <p className="pt-2 text-[11px] leading-relaxed text-muted">{DISCLAIMER}</p>
          <p className="border-t border-line pt-3 text-[11px] font-medium text-muted">
            {DEVELOPER.credit}
          </p>
        </div>
      </div>
    </aside>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </h2>
      {children}
    </div>
  );
}

function EmptyState({
  greeting,
  jurisdictionBlurb,
  suggestions,
  onPick,
}: {
  greeting: string;
  jurisdictionBlurb: string;
  suggestions: { title: string; prompt: string }[];
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="py-8">
      <h1 className="font-serif text-2xl font-semibold tracking-tight sm:text-3xl">
        Counsel Pinto
      </h1>
      <p className="mt-3 max-w-xl text-[0.95rem] leading-relaxed">{greeting}</p>
      <p className="mt-2 max-w-xl text-sm text-muted">{jurisdictionBlurb}</p>

      {suggestions.length > 0 && (
        <div className="mt-8">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Start from a common question
          </h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {suggestions.map((s) => (
              <button
                key={s.title}
                onClick={() => onPick(s.prompt)}
                className="rounded-xl border border-line bg-surface p-3 text-left transition hover:border-accent"
              >
                <span className="block text-sm font-medium">{s.title}</span>
                <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-muted">
                  {s.prompt}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Message({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[0.9375rem] leading-relaxed text-accent-contrast">
          {turn.content}
        </div>
      </div>
    );
  }

  return (
    <article>
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-accent-soft font-serif text-[11px] font-semibold text-accent">
          CP
        </span>
        <span className="text-xs font-medium text-muted">Counsel Pinto</span>
      </div>
      <div className="legal-prose rounded-2xl border border-line bg-surface px-4 py-4 sm:px-5">
        <Markdown remarkPlugins={[remarkGfm]}>{turn.content}</Markdown>
      </div>
    </article>
  );
}

function Thinking() {
  return (
    <div className="flex items-center gap-2 pl-1 text-sm text-muted">
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="typing-dot h-1.5 w-1.5 rounded-full bg-accent"
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </span>
      Researching the position…
    </div>
  );
}

function Banner({
  tone,
  children,
  className = "",
}: {
  tone: "error" | "notice";
  children: React.ReactNode;
  className?: string;
}) {
  const styles =
    tone === "error"
      ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
      : "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200";
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${styles} ${className}`}>
      {children}
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  onKeyDown,
  onStop,
  busy,
  textareaRef,
  jurisdictionLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onStop: () => void;
  busy: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  jurisdictionLabel: string;
}) {
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value, textareaRef]);

  return (
    <div className="shrink-0 border-t border-line bg-surface">
      <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6">
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-background p-2 focus-within:border-accent">
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Describe the facts and your question — ${jurisdictionLabel}…`}
            className="max-h-[220px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[0.9375rem] leading-relaxed outline-none placeholder:text-muted"
          />
          {busy ? (
            <button
              onClick={onStop}
              className="shrink-0 rounded-xl border border-line px-3 py-2 text-sm font-medium hover:bg-surface-muted"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={onSubmit}
              disabled={!value.trim()}
              className="shrink-0 rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-accent-contrast transition disabled:cursor-not-allowed disabled:opacity-35"
            >
              Ask
            </button>
          )}
        </div>
        <p className="mt-2 text-center text-[11px] text-muted">
          Enter to send · Shift + Enter for a new line. {DISCLAIMER}
        </p>
        <p className="mt-1 text-center text-[11px] text-muted lg:hidden">
          {DEVELOPER.credit}
        </p>
      </div>
    </div>
  );
}
