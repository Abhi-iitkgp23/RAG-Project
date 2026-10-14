"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  CLARIFICATION_ANSWER,
  GREETING_ANSWER,
  NONSENSE_ANSWER,
  PROFANITY_ANSWER,
  showsClarificationLabel,
} from "../lib/clarify";
import {
  CLARIFICATION_LABEL,
  DECLINED_LABEL,
  FORMAT_MISMATCH_MESSAGE,
  NOT_IN_CORPUS_LABEL,
  RETRY_MESSAGE,
} from "../lib/copy";
import { conversationTitle } from "../lib/threadTitle";
import type {
  ChatResponse,
  Claim,
  ConversationResponse,
  ConversationUserMessage,
  Coverage,
  Source,
} from "../lib/types";
import {
  IconBook,
  IconChat,
  IconClose,
  IconInfo,
  IconMenu,
  IconPlus,
  IconSend,
  IconTrash,
} from "./icons";
import { AboutAssistant, BrandLockup, HowItWorks } from "./site-chrome";
import { OfficialSources, SourceItem, SourcesChecked, UnsupportedAnswer } from "./sources-panel";

type AssistantTurn = ChatResponse["message"];

type Notice = {
  id: string;
  kind: "notice";
  text: string;
};

type ThreadEntry = ConversationUserMessage | AssistantTurn | Notice;

type ThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

const HISTORY_KEY = "dietary-rag-threads";
const HISTORY_LIMIT = 30;
const NARROW_QUERY = "(max-width: 719px)";
const WELCOME_PROMPTS = [
  "What should I eat daily?",
  "Daily water intake",
  "Food storage and leftovers",
  "Explore an official guide",
] as const;

function isNotice(entry: ThreadEntry): entry is Notice {
  return "kind" in entry && entry.kind === "notice";
}

function isAssistant(entry: ThreadEntry): entry is AssistantTurn {
  return "role" in entry && entry.role === "assistant";
}

function isUser(entry: ThreadEntry): entry is ConversationUserMessage {
  return "role" in entry && entry.role === "user";
}

function coverageLabel(coverage: Coverage, answer: string): string | null {
  if (coverage === "declined") return DECLINED_LABEL;
  if (coverage === "not_in_corpus") return NOT_IN_CORPUS_LABEL;
  if (coverage === "clarify" && showsClarificationLabel(answer)) return CLARIFICATION_LABEL;
  return null;
}

function writeConversationQuery(conversationId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("c", conversationId);
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function clearConversationQuery(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("c");
  const search = url.searchParams.toString();
  window.history.replaceState(null, "", search ? `${url.pathname}?${search}` : url.pathname);
}

function isSummary(value: unknown): value is ThreadSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ThreadSummary>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.title === "string" &&
    item.title.trim().length > 0 &&
    typeof item.updatedAt === "string"
  );
}

function readHistory(): ThreadSummary[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSummary).slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function latestStamp(entries: ThreadEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && "createdAt" in entry && typeof entry.createdAt === "string") {
      return entry.createdAt;
    }
  }
  return new Date().toISOString();
}

function summaryFrom(id: string, thread: ThreadEntry[]): ThreadSummary | null {
  const title = conversationTitle(thread.filter(isUser).map((entry) => entry.content));
  if (!title) return null;
  return { id, title, updatedAt: latestStamp(thread) };
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(
    undefined,
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}

function severalDocuments(claims: readonly Claim[]): boolean {
  return new Set(claims.map((claim) => claim.source.url)).size > 1;
}

function choiceLabel(text: string): string {
  const clean = text.trim().replace(/[.?!]+$/g, "");
  if (!clean) return "";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Split "a, b, or c" and drop the separate Something else control. */
function splitChoices(text: string): string[] {
  return text
    .split(/\s*,\s*or\s+|\s+or\s+|,\s*/i)
    .map(choiceLabel)
    .filter((item) => item.length > 1 && !/^something else$/i.test(item));
}

function exampleChoices(answer: string): string[] {
  const example = answer.match(/For example:\s*([\s\S]+)$/i)?.[1];
  return example ? splitChoices(example) : [];
}

/**
 * Chips come from the clarification already written. An answer that does
 * not offer a choice gets none.
 */
export function clarificationSuggestions(answer: string): string[] {
  const fromExample = exampleChoices(answer);
  if (fromExample.length > 0) return fromExample;

  if (answer === "Are you asking about honey's role in dietary guidance or how to store it?") {
    return ["Honey in a balanced diet", "Storing honey safely"];
  }

  const would = answer.match(/^Would you like to know about (.+)\?$/i)?.[1];
  if (would) {
    const choices = splitChoices(would);
    if (choices.length > 1) return choices;
  }

  const dashed = answer.match(/^What would you like to know about (.+?)—(.+)\?$/);
  if (dashed?.[1] && dashed[2]) {
    const topic = dashed[1].trim();
    const topicPattern = new RegExp(`\\b${topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return splitChoices(dashed[2]).map((option) => {
      if (topicPattern.test(option)) return option;
      if (/^hydration$/i.test(option)) return `Hydration and ${topic}`;
      return `${option} of ${topic}`;
    });
  }

  const topicOnly = answer.match(/^What would you like to know about ([a-z][a-z-]*)\?$/i)?.[1];
  if (topicOnly) {
    const titled = topicOnly.charAt(0).toUpperCase() + topicOnly.slice(1);
    return [`${titled} in a balanced diet`, `Storing ${topicOnly} safely`];
  }

  if (answer === GREETING_ANSWER || answer === NONSENSE_ANSWER || answer === PROFANITY_ANSWER) {
    return exampleChoices(CLARIFICATION_ANSWER);
  }

  return [];
}

function renderInline(block: string) {
  const parts = block.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}

function AnswerText({ text }: { text: string }) {
  const blocks = text.split(/\n\n+/);
  return (
    <div className="answer">
      {blocks.map((block, index) => {
        const lines = block.split("\n");
        const bullets =
          lines.length > 0 &&
          lines.every((line) => /^[-*]\s+\S/.test(line.trim()));
        if (bullets) {
          return (
            <ul key={index}>
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>{renderInline(line.trim().replace(/^[-*]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={index}>
            {lines.map((line, lineIndex) => (
              <span key={lineIndex}>
                {lineIndex > 0 ? <br /> : null}
                {renderInline(line)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

export function ClaimCitations({ claims }: { claims: Claim[] }) {
  if (claims.length === 0) return null;
  return (
    <div className="source-block">
      <p className="source-kicker">{claims.length === 1 ? "Source" : "Sources"}</p>
      <ul className="source-list">
        {claims.map((claim, index) => (
          <li key={`${claim.source.url}-${claim.source.sectionHeading}-${index}`}>
            <SourceItem source={claim.source} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocumentHeading({ source }: { source: Source }) {
  const name = source.documentName.trim();
  if (!name) return null;
  const publisher = source.publisher.trim();
  const year = Number.isFinite(source.year) ? String(source.year) : "";
  const tail = [publisher, year].filter((part) => part.length > 0).join(", ");
  return (
    <p className="doc-heading">
      <strong>{name}</strong>
      {tail ? <span> ({tail})</span> : null}
    </p>
  );
}

function Stamp({ iso }: { iso: string }) {
  const label = formatWhen(iso);
  if (!label) return null;
  return (
    <time className="msg-time" dateTime={iso}>
      {label}
    </time>
  );
}

function Dialog({
  open,
  dialogId,
  labelledBy,
  onClose,
  variant,
  className,
  children,
}: {
  open: boolean;
  dialogId: string;
  labelledBy: string;
  onClose: () => void;
  variant: "sheet" | "center" | "dock";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.querySelector<HTMLElement>("button, a[href], input, textarea")?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (variant === "dock" || event.key !== "Tab" || !dialog) return;
      const items = [
        ...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input, textarea"),
      ];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open, onClose, variant]);

  if (!open) return null;

  if (variant === "dock") {
    return (
      <div
        id={dialogId}
        className="sheet is-docked"
        role="dialog"
        aria-modal="false"
        aria-labelledby={labelledBy}
        ref={ref}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className={variant === "center" ? "overlay is-center" : "overlay"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        id={dialogId}
        className={[variant === "center" ? "dialog-card" : "sheet", className]
          .filter(Boolean)
          .join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={ref}
      >
        {children}
      </div>
    </div>
  );
}

export function Chat() {
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [history, setHistory] = useState<ThreadSummary[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [wide, setWide] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ThreadSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const newChatRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<ThreadSummary[]>([]);
  const loadSeq = useRef(0);

  const closeSources = useCallback(() => setSourcesOpen(false), []);
  const closeHow = useCallback(() => setHowOpen(false), []);
  const closeDelete = useCallback(() => {
    if (deleting) return;
    setPendingDelete(null);
    setDeleteError(null);
  }, [deleting]);

  const writeHistory = useCallback((next: ThreadSummary[]) => {
    historyRef.current = next;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    setHistory(next);
  }, []);

  const rememberThread = useCallback(
    (id: string, thread: ThreadEntry[]) => {
      const summary = summaryFrom(id, thread);
      if (!summary) {
        writeHistory(historyRef.current.filter((item) => item.id !== id));
        return;
      }
      const next = [summary, ...historyRef.current.filter((item) => item.id !== id)].slice(
        0,
        HISTORY_LIMIT,
      );
      writeHistory(next);
    },
    [writeHistory],
  );

  const forgetThread = useCallback(
    (id: string) => {
      writeHistory(historyRef.current.filter((item) => item.id !== id));
    },
    [writeHistory],
  );

  const applyConversation = useCallback(
    (body: ConversationResponse) => {
      setConversationId(body.conversationId);
      setEntries(body.messages);
      rememberThread(body.conversationId, body.messages);
      writeConversationQuery(body.conversationId);
      setLoadError(null);
    },
    [rememberThread],
  );

  useEffect(() => {
    const stored = readHistory();
    historyRef.current = stored;
    setHistory(stored);

    const stale = stored.filter((item) => conversationTitle([item.title]) === null);
    if (stale.length === 0) return;
    let cancelled = false;

    void (async () => {
      for (const item of stale) {
        if (cancelled || !historyRef.current.some((entry) => entry.id === item.id)) continue;
        try {
          const response = await fetch(`/api/conversations/${encodeURIComponent(item.id)}`);
          if (cancelled || !historyRef.current.some((entry) => entry.id === item.id)) continue;
          if (!response.ok) {
            forgetThread(item.id);
            continue;
          }
          const body = (await response.json()) as ConversationResponse;
          if (cancelled || !historyRef.current.some((entry) => entry.id === item.id)) continue;
          const summary = summaryFrom(item.id, body.messages);
          if (!summary) {
            forgetThread(item.id);
            continue;
          }
          writeHistory(
            historyRef.current.map((entry) =>
              entry.id === item.id ? { ...entry, title: summary.title } : entry,
            ),
          );
        } catch {
          // Keep the row when the thread cannot be read. A later open can retitle it.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [forgetThread, writeHistory]);

  useEffect(() => {
    const narrowMedia = window.matchMedia(NARROW_QUERY);
    const wideMedia = window.matchMedia("(min-width: 1100px)");
    const update = () => {
      const isNarrow = narrowMedia.matches;
      setNarrow(isNarrow);
      setWide(wideMedia.matches);
      if (!isNarrow) setNavOpen(false);
    };
    update();
    narrowMedia.addEventListener("change", update);
    wideMedia.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      narrowMedia.removeEventListener("change", update);
      wideMedia.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("c");
    if (!id) {
      setReady(true);
      return;
    }

    const seq = ++loadSeq.current;
    let cancelled = false;
    fetch(`/api/conversations/${encodeURIComponent(id)}`)
      .then(async (response) => {
        if (cancelled || seq !== loadSeq.current) return;
        if (!response.ok) {
          forgetThread(id);
          setLoadError("This conversation could not be found.");
          setReady(true);
          return;
        }
        const body = (await response.json()) as ConversationResponse;
        if (cancelled || seq !== loadSeq.current) return;
        applyConversation(body);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled && seq === loadSeq.current) {
          setLoadError(RETRY_MESSAGE);
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyConversation, forgetThread]);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [entries, pending, loadError]);

  useEffect(() => {
    const field = composerRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [draft]);

  function closeNav() {
    setNavOpen(false);
  }

  function openNav() {
    setNavOpen(true);
    requestAnimationFrame(() => newChatRef.current?.focus());
  }

  function resetToEmptyChat(): void {
    loadSeq.current += 1;
    setEntries([]);
    setConversationId(null);
    setLoadError(null);
    setDraft("");
    setSourcesOpen(false);
    clearConversationQuery();
    closeNav();
  }

  function startNewChat(): void {
    if (pending || switching) return;
    resetToEmptyChat();
    composerRef.current?.focus();
  }

  async function openThread(id: string): Promise<void> {
    if (pending || switching) return;
    closeNav();
    if (id === conversationId) return;
    const seq = ++loadSeq.current;
    setSwitching(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
      if (seq !== loadSeq.current) return;
      if (!response.ok) {
        forgetThread(id);
        setLoadError("This conversation could not be found.");
        return;
      }
      const body = (await response.json()) as ConversationResponse;
      if (seq !== loadSeq.current) return;
      applyConversation(body);
    } catch {
      if (seq === loadSeq.current) setLoadError(RETRY_MESSAGE);
    } finally {
      if (seq === loadSeq.current) setSwitching(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete || deleting) return;
    const id = pendingDelete.id;
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) {
        setDeleteError("This conversation could not be deleted. Please try again.");
        return;
      }
      forgetThread(id);
      if (conversationId === id) resetToEmptyChat();
      setPendingDelete(null);
    } catch {
      setDeleteError("This conversation could not be deleted. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  async function send(text?: string): Promise<void> {
    const message = text ?? draft;
    const fromComposer = text === undefined;
    if (pending || switching || !ready || message.trim() === "") return;
    const prior = entries;
    const activeId = conversationId;
    setPending(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(activeId ? { conversationId: activeId } : {}),
          message,
        }),
      });
      const body = (await response.json()) as ChatResponse & {
        error?: string;
        conversationId?: string;
      };

      if (body.conversationId) {
        setConversationId(body.conversationId);
        writeConversationQuery(body.conversationId);
      }

      if (response.status === 200 && body.message) {
        const userEntry: ConversationUserMessage = {
          id: `local-user-${body.message.id}`,
          role: "user",
          content: message,
          createdAt: body.message.createdAt,
        };
        const next = [...prior, userEntry, body.message];
        setEntries(next);
        if (body.conversationId) rememberThread(body.conversationId, next);
        if (fromComposer) setDraft("");
        return;
      }

      if (response.status === 422) {
        const stamp = crypto.randomUUID();
        const userEntry: ConversationUserMessage = {
          id: `local-user-${stamp}`,
          role: "user",
          content: message,
          createdAt: new Date().toISOString(),
        };
        const notice: Notice = {
          id: `notice-${stamp}`,
          kind: "notice",
          text: body.error ?? FORMAT_MISMATCH_MESSAGE,
        };
        const next = [...prior, userEntry, notice];
        setEntries(next);
        if (body.conversationId) rememberThread(body.conversationId, next);
        if (fromComposer) setDraft("");
        return;
      }

      setLoadError(typeof body.error === "string" ? body.error : RETRY_MESSAGE);
    } catch {
      setLoadError(RETRY_MESSAGE);
    } finally {
      setPending(false);
    }
  }

  const showEmpty = ready && entries.length === 0 && !loadError && !switching && !pending;
  const lastEntry = entries[entries.length - 1];
  const composerDisabled = pending || !ready || switching;
  const dialogOpen = howOpen || pendingDelete !== null || (sourcesOpen && !wide);
  const barTitle =
    history.find((item) => item.id === conversationId)?.title ?? "Dietary Guidance Assistant";

  return (
    <div className="app-shell">
      <div className="app-frame" inert={dialogOpen ? true : undefined}>
        {narrow && navOpen ? (
          <button type="button" className="backdrop" aria-label="Close menu" onClick={closeNav} />
        ) : null}

        <aside
          id="sidebar"
          className={navOpen ? "sidebar is-open" : "sidebar"}
          aria-label="Sidebar"
          inert={narrow && !navOpen ? true : undefined}
        >
          <div className="sidebar-top">
            <button
              type="button"
              className="icon-button sidebar-close"
              aria-label="Close menu"
              onClick={closeNav}
            >
              <IconClose />
            </button>
            <BrandLockup />
            <button
              ref={newChatRef}
              type="button"
              className="new-chat"
              onClick={startNewChat}
              disabled={pending || switching}
            >
              <IconPlus size={18} />
              New chat
            </button>
          </div>

          <div className="history">
            <h2 className="sidebar-label">Recent conversations</h2>
            {history.length === 0 ? (
              <p className="history-empty">Conversations you start appear here.</p>
            ) : (
              <ul className="history-list">
                {history.map((item) => {
                  const when = formatWhen(item.updatedAt);
                  const active = item.id === conversationId;
                  return (
                    <li key={item.id} className={active ? "history-row is-active" : "history-row"}>
                      <button
                        type="button"
                        className={active ? "history-item is-active" : "history-item"}
                        aria-current={active ? "true" : undefined}
                        disabled={pending || switching}
                        onClick={() => void openThread(item.id)}
                      >
                        <IconChat />
                        <span className="history-title">{item.title}</span>
                        {when ? (
                          <time className="history-time" dateTime={item.updatedAt}>
                            {when}
                          </time>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="history-delete"
                        aria-label={`Delete ${item.title}`}
                        disabled={pending || switching || deleting}
                        onClick={() => {
                          setDeleteError(null);
                          setPendingDelete(item);
                        }}
                      >
                        <IconTrash />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <AboutAssistant />
        </aside>

        <main className={sourcesOpen && wide ? "chat-main has-sources" : "chat-main"} inert={narrow && navOpen ? true : undefined}>
          <header className="chat-bar">
            <button
              type="button"
              className="icon-button menu-button"
              aria-label="Open menu"
              aria-expanded={navOpen}
              aria-controls="sidebar"
              onClick={openNav}
            >
              <IconMenu />
            </button>
            <p className="chat-bar-title">{barTitle}</p>
            <div className="chat-bar-actions">
              <button
                type="button"
                className="ghost-button"
                aria-label="Explore Official Sources"
                aria-expanded={sourcesOpen}
                aria-controls="sources-dialog"
                onClick={() => {
                  setHowOpen(false);
                  setPendingDelete(null);
                  setSourcesOpen(true);
                }}
              >
                <IconBook size={16} />
                <span className="bar-label-full">Explore Official Sources</span>
                <span className="bar-label-short" aria-hidden="true">
                  Sources
                </span>
              </button>
              <button
                type="button"
                className="ghost-button"
                aria-label="How it works"
                aria-expanded={howOpen}
                aria-controls="how-dialog"
                onClick={() => {
                  setSourcesOpen(false);
                  setPendingDelete(null);
                  setHowOpen(true);
                }}
              >
                <IconInfo size={16} />
                <span className="bar-label-full">How it works</span>
                <span className="bar-label-short" aria-hidden="true">
                  Guide
                </span>
              </button>
            </div>
          </header>

          <div className="thread-scroll" ref={threadRef}>
            <div className={showEmpty ? "thread-inner is-empty" : "thread-inner"}>
              {!ready ? <p className="status">Loading conversation…</p> : null}

              {ready && loadError && entries.length === 0 ? (
                <p className="status alert" role="alert">
                  {loadError}
                </p>
              ) : null}

              {switching ? <p className="status">Loading conversation…</p> : null}

              {showEmpty ? (
                <div className="empty-state">
                  <h2>Good guidance starts with a good question.</h2>
                  <p>
                    Ask about everyday dietary guidance or food safety. Answers should be grounded
                    in official public sources.
                  </p>
                  <div className="welcome-suggestions" role="group" aria-label="Suggested questions">
                    {WELCOME_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        className="suggestion welcome-suggestion"
                        disabled={composerDisabled}
                        onClick={() => void send(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <ol className="messages" aria-label="Conversation">
                {entries.map((entry) => {
                  if (isNotice(entry)) {
                    return (
                      <li key={entry.id} className="notice" role="status">
                        {entry.text}
                      </li>
                    );
                  }
                  if (isAssistant(entry)) {
                    const label = coverageLabel(entry.coverage, entry.answer);
                    const prompts =
                      entry.coverage === "clarify" && lastEntry?.id === entry.id
                        ? clarificationSuggestions(entry.answer)
                        : [];
                    const grouped = severalDocuments(entry.claims);
                    return (
                      <li key={entry.id} className="turn">
                        <div className="assistant-row">
                          <div className="assistant-main">
                            {label ? <p className="coverage-label">{label}</p> : null}
                            <div className="bubble assistant">
                              {entry.claims.length === 0 ? (
                                entry.coverage === "not_in_corpus" ? (
                                  <>
                                    <UnsupportedAnswer />
                                    <SourcesChecked answer={entry.answer} />
                                  </>
                                ) : (
                                  <AnswerText text={entry.answer} />
                                )
                              ) : (
                                entry.claims.map((claim, index) => {
                                  const previous = entry.claims[index - 1];
                                  const showHeading =
                                    grouped &&
                                    (!previous || previous.source.url !== claim.source.url);
                                  return (
                                    <div key={`${entry.id}-${index}`} className="recommendation">
                                      {showHeading ? <DocumentHeading source={claim.source} /> : null}
                                      <AnswerText text={claim.text} />
                                      <ClaimCitations claims={[claim]} />
                                    </div>
                                  );
                                })
                              )}
                              <Stamp iso={entry.createdAt} />
                            </div>
                            {prompts.length > 0 ? (
                              <div className="suggestions" role="group" aria-label="Suggested questions">
                                {prompts.map((prompt) => (
                                  <button
                                    key={prompt}
                                    type="button"
                                    className="suggestion"
                                    disabled={composerDisabled}
                                    onClick={() => void send(prompt)}
                                  >
                                    {prompt}
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  className="suggestion"
                                  disabled={composerDisabled}
                                  onClick={() => composerRef.current?.focus()}
                                >
                                  Something else
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  }
                  if (!isUser(entry)) return null;
                  return (
                    <li key={entry.id} className="turn turn-user">
                      <div className="bubble user">
                        {entry.content}
                        <Stamp iso={entry.createdAt} />
                      </div>
                    </li>
                  );
                })}
              </ol>

              {loadError && entries.length > 0 ? (
                <p className="status alert" role="alert">
                  {loadError}
                </p>
              ) : null}
            </div>
          </div>

          <div className="composer-dock">
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              {pending ? (
                <p className="looking" role="status">
                  <span className="looking-dot" aria-hidden="true" />
                  Looking in the guidance…
                </p>
              ) : null}
              <label className="sr-only" htmlFor="message">
                Ask a question about dietary guidance or food safety
              </label>
              <div className="composer-shell">
                <textarea
                  ref={composerRef}
                  id="message"
                  name="message"
                  rows={1}
                  value={draft}
                  disabled={composerDisabled}
                  placeholder="Ask about dietary guidance or food safety..."
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <button
                  type="submit"
                  className="send-button"
                  aria-label={pending ? "Sending" : "Send message"}
                  disabled={composerDisabled || draft.trim() === ""}
                >
                  <IconSend />
                </button>
              </div>
            </form>
          </div>
        </main>
      </div>

      <Dialog
        open={sourcesOpen}
        dialogId="sources-dialog"
        labelledBy="sources-title"
        onClose={closeSources}
        variant={wide ? "dock" : "sheet"}
      >
        <div className="dialog-head">
          <h2 id="sources-title">Official sources</h2>
          <button type="button" className="icon-button" aria-label="Close sources" onClick={closeSources}>
            <IconClose />
          </button>
        </div>
        <p className="library-intro">
          Approved public documents for dietary guidance and food safety.
        </p>
        <OfficialSources />
      </Dialog>

      <Dialog
        open={howOpen}
        dialogId="how-dialog"
        labelledBy="how-title"
        onClose={closeHow}
        variant="center"
        className="how-dialog"
      >
        <div className="dialog-head">
          <h2 id="how-title">How it works</h2>
          <button type="button" className="icon-button" aria-label="Close how it works" onClick={closeHow}>
            <IconClose />
          </button>
        </div>
        <HowItWorks
          onViewSources={() => {
            setHowOpen(false);
            setSourcesOpen(true);
          }}
        />
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        dialogId="delete-dialog"
        labelledBy="delete-title"
        onClose={closeDelete}
        variant="center"
        className="confirm-dialog"
      >
        <h2 id="delete-title">Delete this conversation?</h2>
        <p className="confirm-copy">This action cannot be undone.</p>
        {deleteError ? (
          <p className="confirm-error" role="alert">
            {deleteError}
          </p>
        ) : null}
        <div className="confirm-actions">
          <button type="button" className="ghost-button" onClick={closeDelete} disabled={deleting}>
            Cancel
          </button>
          <button type="button" className="danger-button" onClick={() => void confirmDelete()} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
