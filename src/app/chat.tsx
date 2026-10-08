"use client";

import { useEffect, useRef, useState } from "react";
import {
  CLARIFICATION_LABEL,
  DECLINED_LABEL,
  FORMAT_MISMATCH_MESSAGE,
  NOT_IN_CORPUS_LABEL,
  RETRY_MESSAGE,
} from "../lib/copy";
import { answerFromClaims } from "../lib/presentClaims";
import type {
  ChatResponse,
  Claim,
  ConversationResponse,
  ConversationUserMessage,
  Coverage,
} from "../lib/types";
import { IconBook, IconSend, IconVerified } from "./icons";
import { SourcesPanel } from "./sources-panel";

type AssistantTurn = ChatResponse["message"];

type Notice = {
  id: string;
  kind: "notice";
  text: string;
};

type ThreadEntry = ConversationUserMessage | AssistantTurn | Notice;

function isNotice(entry: ThreadEntry): entry is Notice {
  return "kind" in entry && entry.kind === "notice";
}

function isAssistant(entry: ThreadEntry): entry is AssistantTurn {
  return "role" in entry && entry.role === "assistant";
}

function isUser(entry: ThreadEntry): entry is ConversationUserMessage {
  return "role" in entry && entry.role === "user";
}

function coverageLabel(coverage: Coverage): string | null {
  if (coverage === "declined") return DECLINED_LABEL;
  if (coverage === "not_in_corpus") return NOT_IN_CORPUS_LABEL;
  if (coverage === "clarify") return CLARIFICATION_LABEL;
  return null;
}

function selectionKey(conversationId: string): string {
  return `dietary-rag-selected:${conversationId}`;
}

function rememberSelection(conversationId: string, messageId: string): void {
  sessionStorage.setItem(selectionKey(conversationId), messageId);
}

function recalledSelection(conversationId: string): string | null {
  return sessionStorage.getItem(selectionKey(conversationId));
}

function writeConversationQuery(conversationId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("c", conversationId);
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

function sourcesFor(entries: ThreadEntry[], selectedId: string | null): Claim["source"][] {
  const selected = entries.find((entry) => entry.id === selectedId);
  if (!selected || !isAssistant(selected)) return [];
  return selected.claims.map((claim) => claim.source);
}

function shownAnswer(entry: AssistantTurn): string {
  if (entry.claims.length === 0) return entry.answer;
  return answerFromClaims(entry.claims);
}

function latestAssistantId(entries: ThreadEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && isAssistant(entry)) return entry.id;
  }
  return null;
}

function AnswerText({ text }: { text: string }) {
  const blocks = text.split("\n\n");
  return (
    <div className="answer">
      {blocks.map((block, index) => (
        <p key={index}>{renderInline(block)}</p>
      ))}
    </div>
  );
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

export function Chat() {
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("c");
    if (!id) {
      setReady(true);
      return;
    }

    let cancelled = false;
    fetch(`/api/conversations/${encodeURIComponent(id)}`)
      .then(async (response) => {
        if (!response.ok) {
          if (!cancelled) {
            setLoadError("This conversation could not be found.");
            setReady(true);
          }
          return;
        }
        const body = (await response.json()) as ConversationResponse;
        if (cancelled) return;
        setConversationId(body.conversationId);
        setEntries(body.messages);
        const remembered = recalledSelection(body.conversationId);
        const rememberedExists = body.messages.some((message) => message.id === remembered);
        setSelectedId(
          rememberedExists ? remembered : latestAssistantId(body.messages),
        );
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(RETRY_MESSAGE);
          setReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries, pending]);

  function select(entry: ThreadEntry): void {
    if (isNotice(entry)) return;
    setSelectedId(entry.id);
    if (conversationId) rememberSelection(conversationId, entry.id);
  }

  async function send(): Promise<void> {
    const message = draft;
    if (pending || message.trim() === "") return;
    setPending(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(conversationId ? { conversationId } : {}),
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
        setEntries((current) => [...current, userEntry, body.message]);
        setSelectedId(body.message.id);
        if (body.conversationId) rememberSelection(body.conversationId, body.message.id);
        setDraft("");
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
        setEntries((current) => [...current, userEntry, notice]);
        setSelectedId(null);
        setDraft("");
        return;
      }

      setLoadError(typeof body.error === "string" ? body.error : RETRY_MESSAGE);
    } catch {
      setLoadError(RETRY_MESSAGE);
    } finally {
      setPending(false);
    }
  }

  const sources = sourcesFor(entries, selectedId);
  const showEmpty = ready && entries.length === 0 && !loadError;

  return (
    <main className="page">
      <div className="frame">
        <div className="protocol">
          <div className="protocol-group">
            <IconVerified />
            <span>Institutional Retrieval Protocol</span>
            <span className="scope-badge">Verified Scope</span>
          </div>
          <p className="protocol-note">
            <IconBook />
            <span>
              Restricted domain: searches solely <strong>4 published guidance documents</strong>
            </span>
          </p>
        </div>

        <div className="workspace">
          <section className="thread-card" aria-label="Conversation">
            {!ready ? <p className="status">Loading conversation…</p> : null}

            {ready && loadError && entries.length === 0 ? (
              <p className="status" role="alert">
                {loadError}
              </p>
            ) : null}

            {showEmpty ? (
              <p className="thread-empty">
                Ask about population dietary guidance or how long food keeps in the fridge.
              </p>
            ) : null}

            <ol className="messages">
              {entries.map((entry) => {
                if (isNotice(entry)) {
                  return (
                    <li key={entry.id} className="notice" role="status">
                      {entry.text}
                    </li>
                  );
                }
                if (isAssistant(entry)) {
                  const label = coverageLabel(entry.coverage);
                  const selected = entry.id === selectedId;
                  return (
                    <li key={entry.id} className="turn">
                      {label ? <p className="coverage-label">{label}</p> : null}
                      <button
                        type="button"
                        className={selected ? "bubble assistant selected" : "bubble assistant"}
                        onClick={() => select(entry)}
                        aria-pressed={selected}
                      >
                        <AnswerText text={shownAnswer(entry)} />
                      </button>
                    </li>
                  );
                }
                if (!isUser(entry)) return null;
                const selected = entry.id === selectedId;
                return (
                  <li key={entry.id} className="turn turn-user">
                    <span className="turn-label">Citizen inquiry</span>
                    <button
                      type="button"
                      className={selected ? "bubble user selected" : "bubble user"}
                      onClick={() => select(entry)}
                      aria-pressed={selected}
                    >
                      {entry.content}
                    </button>
                  </li>
                );
              })}
            </ol>
            <div ref={threadEndRef} />

            {loadError && entries.length > 0 ? (
              <p className="status" role="alert">
                {loadError}
              </p>
            ) : null}

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
                Ask about diet or cold storage
              </label>
              <div className="composer-row">
                <textarea
                  id="message"
                  name="message"
                  rows={1}
                  value={draft}
                  disabled={pending || !ready}
                  placeholder="Ask about diet or cold storage"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <button type="submit" disabled={pending || !ready || draft.trim() === ""}>
                  {pending ? "Sending…" : "Send"}
                  <IconSend />
                </button>
              </div>
              <p className="composer-note">
                Each claim is cited from the published documents
              </p>
            </form>
          </section>
          <SourcesPanel sources={sources} />
        </div>
      </div>
    </main>
  );
}
