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
  VOICE_UI,
  resolveLocale,
  type EffortId,
  type JurisdictionId,
  type LanguageId,
  type Source,
} from "@/lib/counsel";

type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

const STORAGE_KEY = "counsel-pinto/session-v2";

type Persisted = {
  turns: Turn[];
  jurisdiction: JurisdictionId;
  language: LanguageId;
  effort: EffortId;
  research: boolean;
  autoSpeak: boolean;
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
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const hydrated = useSyncExternalStore(neverChanges, onClient, onServer);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const spoken = resolveLocale(language);
  const locale = SPEECH_LOCALE[spoken];
  const copy = VOICE_UI[spoken];

  const narration = useNarration(locale);

  // Keep the latest settings reachable from the dictation callback without
  // re-creating the recogniser on every keystroke.
  const sendRef = useRef<(text: string) => void>(() => {});
  const dictation = useDictation(locale, (text) => sendRef.current(text));

  useEffect(() => {
    if (!hydrated) return;
    const payload: Persisted = {
      turns,
      jurisdiction,
      language,
      effort,
      research,
      autoSpeak,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota exceeded — not fatal */
    }
  }, [hydrated, turns, jurisdiction, language, effort, research, autoSpeak]);

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
      const question = text.trim();
      if (!question || busy) return;

      narration.cancel();
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
            | { type: "searching"; active: boolean }
            | { type: "sources"; sources: Source[] }
            | { type: "notice"; text: string }
            | { type: "error"; message: string }
            | { type: "done" };

          if (evt.type === "text") {
            spokenText += evt.text;
            setTurns((prev) =>
              prev.map((t) =>
                t.id === assistantId ? { ...t, content: t.content + evt.text } : t,
              ),
            );
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
        abortRef.current = null;
        setTurns((prev) =>
          prev.filter((t) => !(t.id === assistantId && t.content === "")),
        );
      }
    },
    [busy, turns, jurisdiction, language, effort, research, autoSpeak, narration],
  );

  useEffect(() => {
    sendRef.current = (text: string) => void send(text);
  }, [send]);

  const stop = () => {
    abortRef.current?.abort();
    narration.cancel();
  };

  const reset = () => {
    stop();
    dictation.stop();
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
    research,
    setResearch,
    autoSpeak,
    setAutoSpeak,
    narrationSupported: narration.supported,
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
                    />
                  ))}
                  {busy && <Working searching={searching} />}
                </div>
              )}

              {dictation.error && (
                <Banner tone="notice" className="mt-6">
                  {dictation.error}
                </Banner>
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
            value={dictation.listening ? dictation.transcript || input : input}
            onChange={setInput}
            onSubmit={() => void send(input)}
            onKeyDown={onKeyDown}
            onStop={stop}
            busy={busy}
            textareaRef={textareaRef}
            jurisdictionLabel={activeJurisdiction.short}
            dictation={dictation}
            copy={copy}
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
  research,
  setResearch,
  autoSpeak,
  setAutoSpeak,
  narrationSupported,
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
  research: boolean;
  setResearch: (v: boolean) => void;
  autoSpeak: boolean;
  setAutoSpeak: (v: boolean) => void;
  narrationSupported: boolean;
  reset: () => void;
  exportTranscript: () => void;
  canExport: boolean;
  onNavigate?: () => void;
}) {
  return (
    <aside className={`flex-col overflow-y-auto bg-surface ${className}`}>
      <div className="flex flex-1 flex-col gap-5 p-4">
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
            hint="Check current figures and instruments against official sources, and cite them."
            checked={research}
            onChange={setResearch}
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
}: {
  turn: Turn;
  botState: BotState;
  canSpeak: boolean;
  speaking: boolean;
  onSpeak: () => void;
}) {
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
        <CounselBot state={botState} size={26} />
        <span className="text-xs font-medium text-muted">Counsel Pinto</span>
        {canSpeak && turn.content && (
          <button
            onClick={onSpeak}
            className="ml-auto rounded-md px-2 py-1 text-[11px] font-medium text-muted transition hover:bg-surface-muted hover:text-accent"
          >
            {speaking ? "■ Stop" : "▶ Listen"}
          </button>
        )}
      </div>
      <div className="legal-prose rounded-2xl border border-line bg-surface px-4 py-4 sm:px-5">
        <Markdown remarkPlugins={[remarkGfm]}>{turn.content}</Markdown>
        {turn.sources && turn.sources.length > 0 && (
          <Sources sources={turn.sources} />
        )}
      </div>
    </article>
  );
}

function Working({ searching }: { searching: boolean }) {
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
      {searching ? "Checking official sources…" : "Researching the position…"}
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
        <div
          className={`flex items-end gap-2 rounded-2xl border bg-background p-2 transition ${
            dictation.listening
              ? "border-accent ring-2 ring-accent/25"
              : "border-line focus-within:border-accent"
          }`}
        >
          {dictation.supported && (
            <button
              onClick={() =>
                dictation.listening ? dictation.stop() : dictation.start()
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
            readOnly={dictation.listening}
            placeholder={
              dictation.listening
                ? copy.listening
                : `Describe the facts and your question — ${jurisdictionLabel}…`
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
              disabled={!value.trim()}
              className="shrink-0 rounded-xl bg-accent px-3.5 py-2 text-sm font-medium text-accent-contrast transition disabled:cursor-not-allowed disabled:opacity-35"
            >
              Ask
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
