"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CounselBot, { type BotState } from "@/components/CounselBot";
import { useDictation, useNarration } from "@/lib/speech";
import {
  DEVELOPER,
  DISCLAIMER,
  EFFORTS,
  GREETING,
  JURISDICTIONS,
  LANGUAGES,
  SPEECH_LOCALE,
  SUGGESTIONS,
  TASKS,
  VOICE_UI,
  resolveLocale,
  type EffortId,
  type JurisdictionId,
  type LanguageId,
  type Source,
  type TaskId,
} from "@/lib/counsel";
import type { ProviderStatus } from "@/lib/providers/types";

type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  /** Names of documents that were attached to this request, for display. */
  documents?: { name: string; chars: number }[];
  task?: TaskId;
  /** "Groq · openai/gpt-oss-120b" — whichever provider in the chain answered. */
  provider?: string;
};

/** A file the user attached, already reduced to text by /api/extract. */
type Attachment = {
  id: string;
  name: string;
  text: string;
  chars: number;
  pages?: number;
};

const STORAGE_KEY = "counsel-pinto/session-v2";

type Persisted = {
  turns: Turn[];
  jurisdiction: JurisdictionId;
  language: LanguageId;
  effort: EffortId;
  research: boolean;
  autoSpeak: boolean;
  task: TaskId;
};

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

/* False during SSR and the hydration pass, true thereafter. Until it flips we
 * render a neutral shell, so restoring the saved session in a lazy state
 * initialiser cannot produce a hydration mismatch — and no effect has to call
 * setState to bring the session back. */
const neverChanges = () => () => {};
const onClient = () => true;
const onServer = () => false;

function loadPersisted(): Partial<Persisted> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
  } catch {
    return {}; // corrupted storage — start fresh
  }
}

export default function Page() {
  const [boot] = useState<Partial<Persisted>>(loadPersisted);
  const [turns, setTurns] = useState<Turn[]>(boot.turns ?? []);
  const [input, setInput] = useState("");
  const [jurisdiction, setJurisdiction] = useState<JurisdictionId>(
    boot.jurisdiction ?? "auto",
  );
  const [language, setLanguage] = useState<LanguageId>(boot.language ?? "auto");
  const [effort, setEffort] = useState<EffortId>(boot.effort ?? "high");
  const [research, setResearch] = useState(boot.research ?? true);
  const [autoSpeak, setAutoSpeak] = useState(boot.autoSpeak ?? false);
  const [task, setTask] = useState<TaskId>(boot.task ?? "consult");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const hydrated = useSyncExternalStore(neverChanges, onClient, onServer);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const spoken = resolveLocale(language);
  const locale = SPEECH_LOCALE[spoken];
  const copy = VOICE_UI[spoken];

  const narration = useNarration(locale);

  // Speech fills the composer; sending stays a deliberate act, so the user can
  // correct a misheard word before it becomes a legal question.
  const dictation = useDictation(locale, setInput);

  useEffect(() => {
    if (!hydrated) return;
    const payload: Persisted = {
      turns,
      jurisdiction,
      language,
      effort,
      research,
      autoSpeak,
      task,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota exceeded — not fatal */
    }
  }, [hydrated, turns, jurisdiction, language, effort, research, autoSpeak, task]);

  // Ask the server which provider is live and what it can do, so the controls
  // reflect reality instead of failing when the user presses them.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => (r.ok ? (r.json() as Promise<ProviderStatus>) : null))
      .then((s) => {
        if (!cancelled && s) setStatus(s);
      })
      .catch(() => {
        /* leave status null — the composer still works and the route reports */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Don't drag the empty state out of view on first paint — only follow
    // along once there is a conversation to follow.
    if (turns.length === 0) return;
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
      const typed = text.trim();
      if ((!typed && attachments.length === 0) || busy) return;

      // A document with no instruction is still a clear request in most modes.
      const taskLabel = TASKS.find((t) => t.id === task)!.label.toLowerCase();
      const question =
        typed || `Please ${taskLabel === "consultation" ? "review" : taskLabel} the attached document.`;

      narration.cancel();
      setError(null);
      setNotice(null);
      setProgress(null);
      setInput("");

      const docs = attachments;
      setAttachments([]);

      const userTurn: Turn = {
        id: newId(),
        role: "user",
        content: question,
        task,
        documents: docs.length ? docs.map((d) => ({ name: d.name, chars: d.chars })) : undefined,
      };
      const assistantId = newId();
      const history = [...turns, userTurn];

      setTurns([...history, { id: assistantId, role: "assistant", content: "", task }]);
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      let spokenText = "";

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
            research,
            task,
            documents: docs.map((d) => ({ name: d.name, text: d.text })),
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
            | { type: "meta"; provider: string; model: string; search: string; parts: number; chain?: string[] }
            | { type: "provider"; label: string; model: string }
            | { type: "progress"; text: string; step?: number; total?: number }
            | { type: "searching"; active: boolean }
            | { type: "sources"; sources: Source[] }
            | { type: "notice"; text: string }
            | { type: "error"; message: string }
            | { type: "done" };

          if (evt.type === "text") {
            spokenText += evt.text;
            setProgress(null);
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId ? { ...t, content: t.content + evt.text } : t,
              ),
            );
          } else if (evt.type === "progress") {
            setProgress(evt.text);
          } else if (evt.type === "provider") {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId ? { ...t, provider: `${evt.label} · ${evt.model}` } : t,
              ),
            );
          } else if (evt.type === "meta") {
            if (evt.parts > 1) {
              setProgress(`Long document — reading it in ${evt.parts} parts.`);
            }
          } else if (evt.type === "searching") {
            setSearching(evt.active);
          } else if (evt.type === "sources") {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId ? { ...t, sources: evt.sources } : t,
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

        if (autoSpeak && spokenText.trim()) narration.speak(spokenText);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : "Something went wrong.");
        }
      } finally {
        setBusy(false);
        setSearching(false);
        setProgress(null);
        abortRef.current = null;
        setTurns((prev) =>
          prev.filter((t) => !(t.id === assistantId && t.content === "")),
        );
      }
    },
    [busy, turns, jurisdiction, language, effort, research, autoSpeak, narration, task, attachments],
  );

  /** Send files to /api/extract and keep the text client-side until sent. */
  const attach = async (files: FileList | File[]) => {
    setError(null);
    setUploading(true);
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch("/api/extract", { method: "POST", body: form });
        const data = (await res.json()) as {
          error?: string;
          name: string;
          text: string;
          chars: number;
          pages?: number;
          warning?: string;
        };
        if (!res.ok) throw new Error(data.error ?? `Could not read ${file.name}.`);
        setAttachments((prev) => [
          ...prev,
          { id: newId(), name: data.name, text: data.text, chars: data.chars, pages: data.pages },
        ]);
        if (data.warning) setNotice(data.warning);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Could not read ${file.name}.`);
      }
    }
    setUploading(false);
  };

  /**
   * Word opens an HTML file saved as .doc and keeps the formatting, which is
   * enough for a lawyer to take a redline or a draft into their own template.
   * The rendered markup is lifted straight from the page.
   */
  const exportWord = (turn: Turn) => {
    const el = document.querySelector<HTMLElement>(`[data-turn="${turn.id}"] .legal-prose`);
    const body = el?.innerHTML ?? `<pre>${turn.content}</pre>`;
    const html = [
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">',
      '<head><meta charset="utf-8"><title>Counsel Pinto</title><style>',
      "body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;color:#111}",
      "h1,h2,h3,h4{font-family:Cambria,Georgia,serif;color:#1f4d3d}",
      "blockquote{margin:6pt 0 6pt 18pt;padding-left:8pt;border-left:2pt solid #999}",
      "del{color:#b42318} blockquote strong{color:#1f4d3d}",
      "table{border-collapse:collapse} td,th{border:1pt solid #999;padding:3pt 6pt}",
      "a{color:#1f4d3d}",
      "</style></head><body>",
      body,
      `<p style="margin-top:24pt;font-size:9pt;color:#666">${DISCLAIMER}<br/>${DEVELOPER.credit}</p>`,
      "</body></html>",
    ].join("");
    const blob = new Blob(["﻿", html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `counsel-pinto-${turn.task ?? "answer"}-${new Date().toISOString().slice(0, 10)}.doc`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const stop = () => {
    abortRef.current?.abort();
    narration.cancel();
  };

  const reset = () => {
    stop();
    dictation.stop();
    setTurns([]);
    setAttachments([]);
    setError(null);
    setNotice(null);
    setProgress(null);
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
      .map((t) => {
        const head = `## ${t.role === "user" ? "Question" : "Counsel Pinto"}\n\n${t.content}`;
        if (!t.sources?.length) return head;
        const list = t.sources
          .map((s) => `- [${s.title}](${s.url}) — ${s.host}`)
          .join("\n");
        return `${head}\n\n**Sources**\n\n${list}`;
      })
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

  const botState: BotState = dictation.listening
    ? "listening"
    : searching
      ? "searching"
      : busy
        ? "thinking"
        : narration.speaking
          ? "speaking"
          : "idle";

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
    task,
    setTask,
    research,
    setResearch,
    autoSpeak,
    setAutoSpeak,
    narrationSupported: narration.supported,
    status,
    reset,
    exportTranscript,
    canExport: turns.length > 0,
  };

  // Server render and hydration pass: a neutral frame that does not depend on
  // restored session state, so the two markups always agree.
  if (!hydrated) return <Shell />;

  return (
    <div className="flex h-dvh flex-col">
      <Header
        botState={botState}
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
              {status && !status.ready && (
                <SetupNotice status={status} className="mb-6" />
              )}

              {turns.length === 0 ? (
                <EmptyState
                  botState={botState}
                  greeting={GREETING[language]}
                  jurisdictionBlurb={activeJurisdiction.blurb}
                  suggestions={suggestions}
                  onPick={(p) => void send(p)}
                />
              ) : (
                <div className="space-y-6">
                  {turns.map((t) => (
                    <Message
                      key={t.id}
                      turn={t}
                      botState={botState}
                      canSpeak={narration.supported}
                      speaking={narration.speaking}
                      onSpeak={() =>
                        narration.speaking
                          ? narration.cancel()
                          : narration.speak(t.content)
                      }
                      onExport={() => exportWord(t)}
                    />
                  ))}
                  {busy && <Working searching={searching} progress={progress} />}
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
            dictation={dictation}
            copy={copy}
            task={task}
            attachments={attachments}
            uploading={uploading}
            onAttach={(files) => void attach(files)}
            onRemoveAttachment={(id) =>
              setAttachments((prev) => prev.filter((a) => a.id !== id))
            }
          />
        </main>
      </div>
    </div>
  );
}

/* ---------------- pieces ---------------- */

/** Pre-hydration frame. Same on the server and the first client render. */
function Shell() {
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2.5 sm:px-6">
        <CounselBot state="idle" size={34} />
        <span className="font-serif text-lg font-semibold tracking-tight">
          Counsel Pinto
        </span>
        <span className="hidden truncate text-xs text-muted sm:inline">
          AI Legal Counsel · Cameroon · Mozambique · CEMAC
        </span>
      </header>
      <div className="flex-1" />
      <div className="shrink-0 border-t border-line bg-surface">
        <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6">
          <div className="h-[46px] rounded-2xl border border-line bg-background" />
          <p className="mt-2 text-center text-[11px] text-muted">{DISCLAIMER}</p>
        </div>
      </div>
    </div>
  );
}

function Header({
  botState,
  jurisdictionLabel,
  onTogglePanel,
  panelOpen,
}: {
  botState: BotState;
  jurisdictionLabel: string;
  onTogglePanel: () => void;
  panelOpen: boolean;
}) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2.5 sm:px-6">
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

      <CounselBot state={botState} size={34} />

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

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg px-1 py-1.5 text-left hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition ${
          checked ? "bg-accent" : "bg-line"
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-surface transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-[11px] leading-relaxed text-muted">{hint}</span>
      </span>
    </button>
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
  task,
  setTask,
  research,
  setResearch,
  autoSpeak,
  setAutoSpeak,
  narrationSupported,
  status,
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
  task: TaskId;
  setTask: (v: TaskId) => void;
  research: boolean;
  setResearch: (v: boolean) => void;
  autoSpeak: boolean;
  setAutoSpeak: (v: boolean) => void;
  narrationSupported: boolean;
  status: ProviderStatus | null;
  reset: () => void;
  exportTranscript: () => void;
  canExport: boolean;
  onNavigate?: () => void;
}) {
  const canSearch = status?.supportsSearch ?? true;
  return (
    <aside className={`flex-col overflow-y-auto bg-surface ${className}`}>
      <div className="flex flex-1 flex-col gap-5 p-4">
        <Field label="Task">
          <div className="space-y-1">
            {TASKS.map((t) => (
              <button
                key={t.id}
                title={t.blurb}
                onClick={() => {
                  setTask(t.id);
                  onNavigate?.();
                }}
                className={`w-full rounded-lg px-3 py-1.5 text-left text-sm transition ${
                  task === t.id
                    ? "bg-accent-soft font-medium text-accent"
                    : "text-foreground hover:bg-surface-muted"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </Field>

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

        <Field label="Behaviour">
          <Toggle
            label="Search the web"
            hint={
              canSearch
                ? `Check current figures and instruments against official sources, and cite them${
                    status?.search.mode && status.search.mode !== "native"
                      ? ` — ${status.search.label}`
                      : ""
                  }.`
                : `No web access — ${status?.label ?? "this provider"} cannot search and no search key is set. Answers come from training data and will say what to verify.`
            }
            checked={canSearch && research}
            onChange={setResearch}
            disabled={!canSearch}
          />
          <Toggle
            label="Read answers aloud"
            hint={
              narrationSupported
                ? "Speak each reply in the selected language."
                : "This browser has no speech synthesis."
            }
            checked={autoSpeak}
            onChange={setAutoSpeak}
            disabled={!narrationSupported}
          />
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
          {status && (
            <p className="pt-2 text-[11px] leading-relaxed text-muted">
              {status.ready ? (
                <>
                  Answering with <span className="text-foreground">{status.label}</span>{" "}
                  <span className="font-mono text-[10px]">{status.model}</span>
                  {" · "}
                  {status.search.mode ? `web search ${status.search.label}` : "no web access"}
                  {status.chain.length > 1 && (
                    <>
                      <br />
                      Failover: {status.chain.map((c) => c.label).join(" → ")}
                    </>
                  )}
                </>
              ) : (
                <>No AI provider configured.</>
              )}
            </p>
          )}
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
  botState,
  greeting,
  jurisdictionBlurb,
  suggestions,
  onPick,
}: {
  botState: BotState;
  greeting: string;
  jurisdictionBlurb: string;
  suggestions: { title: string; prompt: string }[];
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="py-6">
      <div className="flex items-start gap-4">
        <CounselBot state={botState} size={78} />
        <div className="min-w-0 flex-1 pt-2">
          <h1 className="font-serif text-2xl font-semibold tracking-tight sm:text-3xl">
            Counsel Pinto
          </h1>
          <p className="mt-2 max-w-xl text-[0.95rem] leading-relaxed">{greeting}</p>
          <p className="mt-2 max-w-xl text-sm text-muted">{jurisdictionBlurb}</p>
        </div>
      </div>

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
                className="rounded-xl border border-line bg-surface p-3 text-left transition hover:-translate-y-0.5 hover:border-accent hover:shadow-sm"
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

/** Shown when no provider key is present — setup guidance, not an error. */
function SetupNotice({
  status,
  className = "",
}: {
  status: ProviderStatus;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-accent/40 bg-accent-soft/60 px-4 py-3.5 ${className}`}
    >
      <p className="text-sm font-medium">Almost there — no AI provider is configured.</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
        Set <span className="font-mono text-[11px]">{status.envKey}</span> to a key
        from{" "}
        <a
          href={status.console}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-2"
        >
          {status.label}
        </a>{" "}
        — {status.pricing.toLowerCase()} Any other supported provider&apos;s key works
        too; the app picks up whichever it finds.
      </p>
    </div>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Sources consulted
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {sources.map((s, i) => (
          <a
            key={s.url}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            title={s.title}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-background px-2.5 py-1 text-[11px] text-muted transition hover:border-accent hover:text-accent"
          >
            <span className="font-mono text-[10px] opacity-60">{i + 1}</span>
            <span className="truncate">{s.host}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function Message({
  turn,
  botState,
  canSpeak,
  speaking,
  onSpeak,
  onExport,
}: {
  turn: Turn;
  botState: BotState;
  canSpeak: boolean;
  speaking: boolean;
  onSpeak: () => void;
  onExport: () => void;
}) {
  if (turn.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {turn.documents && turn.documents.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {turn.documents.map((d) => (
              <span
                key={d.name}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted"
              >
                <PaperclipIcon size={12} />
                <span className="max-w-[220px] truncate">{d.name}</span>
              </span>
            ))}
          </div>
        )}
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[0.9375rem] leading-relaxed text-accent-contrast">
          {turn.content}
        </div>
      </div>
    );
  }

  const taskLabel = turn.task ? TASKS.find((t) => t.id === turn.task)?.short : undefined;

  return (
    <article data-turn={turn.id}>
      <div className="mb-2 flex items-center gap-2">
        <CounselBot state={botState} size={26} />
        <span className="text-xs font-medium text-muted">Counsel Pinto</span>
        {taskLabel && taskLabel !== "Consult" && (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">
            {taskLabel}
          </span>
        )}
        {turn.content && (
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={onExport}
              title="Open in Word"
              className="rounded-md px-2 py-1 text-[11px] font-medium text-muted transition hover:bg-surface-muted hover:text-accent"
            >
              ⤓ Word
            </button>
            {canSpeak && (
              <button
                onClick={onSpeak}
                className="rounded-md px-2 py-1 text-[11px] font-medium text-muted transition hover:bg-surface-muted hover:text-accent"
              >
                {speaking ? "■ Stop" : "▶ Listen"}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="legal-prose rounded-2xl border border-line bg-surface px-4 py-4 sm:px-5">
        <Markdown remarkPlugins={[remarkGfm]}>{turn.content}</Markdown>
        {turn.sources && turn.sources.length > 0 && (
          <Sources sources={turn.sources} />
        )}
      </div>
      {turn.provider && (
        <p className="mt-1.5 pl-1 text-[10px] text-muted">Answered by {turn.provider}</p>
      )}
    </article>
  );
}

function Working({
  searching,
  progress,
}: {
  searching: boolean;
  progress: string | null;
}) {
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
      {progress ?? (searching ? "Checking official sources…" : "Researching the position…")}
    </div>
  );
}

function PaperclipIcon({ size = 17 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
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

function MicIcon({ off }: { off?: boolean }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
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
  dictation,
  copy,
  task,
  attachments,
  uploading,
  onAttach,
  onRemoveAttachment,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onStop: () => void;
  busy: boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  jurisdictionLabel: string;
  dictation: ReturnType<typeof useDictation>;
  copy: (typeof VOICE_UI)["en"];
  task: TaskId;
  attachments: Attachment[];
  uploading: boolean;
  onAttach: (files: FileList) => void;
  onRemoveAttachment: (id: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const activeTask = TASKS.find((t) => t.id === task)!;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value, textareaRef]);

  const canSend = value.trim().length > 0 || attachments.length > 0;

  return (
    <div className="shrink-0 border-t border-line bg-surface">
      <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6">
        {/* Anchored to the composer, not the transcript: a microphone failure
            that scrolls out of view reads as the button doing nothing. */}
        {dictation.error && (
          <div className="mb-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-200">
            {dictation.error}
          </div>
        )}
        {dictation.listening && (
          <div className="mb-2 flex items-center gap-2 px-1 text-[12px] text-accent">
            <span className="relative flex h-2 w-2">
              <span className="bot-ring absolute inline-flex h-full w-full rounded-full bg-accent opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            {copy.listening} Tap the mic again when you have finished.
          </div>
        )}
        {(attachments.length > 0 || uploading) && (
          <div className="mb-2 flex flex-wrap gap-1.5 px-1">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-background py-1 pl-2.5 pr-1 text-[11px]"
              >
                <PaperclipIcon size={12} />
                <span className="max-w-[200px] truncate">{a.name}</span>
                <span className="text-muted">
                  {a.pages ? `${a.pages} pp · ` : ""}
                  {Math.round(a.chars / 1000)}k chars
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(a.id)}
                  aria-label={`Remove ${a.name}`}
                  className="ml-0.5 rounded-full px-1.5 text-muted hover:bg-surface-muted hover:text-foreground"
                >
                  ×
                </button>
              </span>
            ))}
            {uploading && (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted">
                Reading document…
              </span>
            )}
          </div>
        )}
        {activeTask.wantsDocument && attachments.length === 0 && !uploading && (
          <p className="mb-2 px-1 text-[12px] text-muted">
            Attach the contract to review — PDF, Word or text, up to 4 MB.
          </p>
        )}
        <div
          className={`flex items-end gap-2 rounded-2xl border bg-background p-2 transition ${
            dictation.listening
              ? "border-accent ring-2 ring-accent/25"
              : "border-line focus-within:border-accent"
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) onAttach(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy || uploading}
            aria-label="Attach a document"
            title="Attach a contract or document (PDF, Word, text)"
            className="shrink-0 rounded-xl p-2.5 text-muted transition hover:bg-surface-muted hover:text-accent disabled:opacity-40"
          >
            <PaperclipIcon />
          </button>
          {dictation.supported && (
            <button
              type="button"
              onClick={() =>
                dictation.listening ? dictation.stop() : dictation.start(value)
              }
              aria-label={dictation.listening ? copy.listening : copy.dictate}
              title={dictation.listening ? copy.listening : copy.dictate}
              className={`shrink-0 rounded-xl p-2.5 transition ${
                dictation.listening
                  ? "bg-accent text-accent-contrast"
                  : "text-muted hover:bg-surface-muted hover:text-accent"
              }`}
            >
              <MicIcon />
            </button>
          )}

          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              dictation.listening
                ? copy.listening
                : `${activeTask.placeholder} — ${jurisdictionLabel}…`
            }
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
              disabled={!canSend || uploading}
              className="shrink-0 rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-accent-contrast transition disabled:cursor-not-allowed disabled:opacity-35"
            >
              {task === "consult" ? "Ask" : activeTask.short}
            </button>
          )}
        </div>

        <p className="mt-2 text-center text-[11px] text-muted">
          {dictation.supported
            ? "Enter to send · Shift + Enter for a new line · tap the mic to speak."
            : "Enter to send · Shift + Enter for a new line."}{" "}
          {DISCLAIMER}
        </p>
        <p className="mt-1 text-center text-[11px] text-muted lg:hidden">
          {DEVELOPER.credit}
        </p>
      </div>
    </div>
  );
}
