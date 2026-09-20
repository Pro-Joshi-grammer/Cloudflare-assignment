import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ChatAgent } from "./server";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Switch,
  Text
} from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  BrainIcon,
  CaretDownIcon,
  BugIcon,
  MicrophoneIcon,
  BriefcaseIcon
} from "@phosphor-icons/react";

const JD_BUTTONS = [
  "ML Engineer",
  "Software Engineer",
  "Senior Software Engineer"
];
const SAMPLE_QUERIES = [
  "Find someone with MLOps and model deployment experience",
  "Find a backend engineer with Kubernetes and distributed-systems depth",
  "Find someone with AI Engineering experience"
];

// The DOM lib types SpeechRecognitionEvent but not the SpeechRecognition
// class / constructors, so describe the surface we use.
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: (e: SpeechRecognitionEvent) => void;
  onerror: (e: SpeechRecognitionErrorEvent) => void;
  onend: () => void;
  start: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);
  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

// ── Tool rendering ────────────────────────────────────────────────────

function ToolIO({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return (
    <div className="mt-1">
      <Text size="xs" variant="secondary" bold>
        {label}
      </Text>
      <pre className="mt-0.5 font-mono text-xs text-kumo-subtle whitespace-pre-wrap overflow-auto max-h-64">
        {text}
      </pre>
    </div>
  );
}

function ToolPartView({ part }: { part: UIMessage["parts"][number] }) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);

  if (part.state === "output-available") {
    const out = part.output as
      | {
          shortlist?: {
            summary: string;
            candidates: {
              rank: number;
              name: string;
              category:
                | "VERY STRONG MATCH"
                | "STRONG MATCH"
                | "PARTIAL MATCH"
                | "NOT SUITABLE";
              title: string;
              evidence: string[];
            }[];
          };
        }
      | undefined;
    const sl = out?.shortlist;
    // Recruiter-facing: render the schema-valid shortlist as one bubble per
    // candidate (rank/name/category/title/evidence) — never raw JSON.
    if (sl && Array.isArray(sl.candidates) && sl.candidates.length > 0) {
      const catColor: Record<string, string> = {
        "VERY STRONG MATCH": "text-kumo-success",
        "STRONG MATCH": "text-kumo-brand",
        "PARTIAL MATCH": "text-kumo-subtle",
        "NOT SUITABLE": "text-kumo-danger"
      };
      return (
        <>
          <div className="flex justify-start">
            <div className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line bg-kumo-base">
              <div className="flex items-center gap-2 mb-1">
                <GearIcon size={14} className="text-kumo-inactive" />
                <Text size="xs" variant="secondary" bold>
                  {toolName}
                </Text>
                <Badge variant="secondary">Done</Badge>
              </div>
              {part.input !== undefined && part.input !== null && (
                <ToolIO label="Input" value={part.input} />
              )}
            </div>
          </div>
          {sl.summary ? (
            <div className="flex justify-start">
              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default text-sm leading-relaxed">
                {sl.summary}
              </div>
            </div>
          ) : null}
          {sl.candidates.map((c) => (
            <div key={c.rank} className="flex justify-start">
              <div className="max-w-[85%] w-full px-4 py-3 rounded-2xl rounded-bl-md ring ring-kumo-line bg-kumo-base text-kumo-default leading-relaxed">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-bold tabular-nums text-kumo-brand">
                    #{c.rank}
                  </span>
                  <span className="font-semibold text-sm">{c.name}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span
                    className={`text-xs font-semibold ${catColor[c.category] ?? "text-kumo-subtle"}`}
                  >
                    {c.category}
                  </span>
                  <span className="text-xs text-kumo-subtle truncate">
                    — {c.title}
                  </span>
                </div>
                <ul className="mt-2 space-y-1 text-xs text-kumo-default">
                  {c.evidence.map((e, i) => (
                    <li key={i} className="flex gap-1.5">
                      <span className="text-kumo-brand mt-px">•</span>
                      <span>{e}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </>
      );
    }
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line bg-kumo-base">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          {part.input !== undefined && part.input !== null && (
            <ToolIO label="Input" value={part.input} />
          )}
          <ToolIO label="Output" value={part.output} />
        </div>
      </div>
    );
  }

  if (part.state === "output-error") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] px-4 py-2.5 rounded-xl ring-2 ring-kumo-danger bg-kumo-base">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="destructive">Error</Badge>
          </div>
          <div className="font-mono">
            <Text size="xs" variant="secondary">
              {part.errorText || "Tool call failed"}
            </Text>
          </div>
        </div>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line bg-kumo-base">
          <div className="flex items-center gap-2">
            <GearIcon size={14} className="text-kumo-inactive animate-spin" />
            <Text size="xs" variant="secondary">
              Running {toolName}...
            </Text>
          </div>
          <ToolIO label="Input" value={part.input} />
        </div>
      </div>
    );
  }

  return null;
}

// ── Main chat ─────────────────────────────────────────────────────────

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [listening, setListening] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recRef = useRef<{ abort: () => void } | null>(null);
  const toasts = useKumoToastManager();

  const agent = useAgent<ChatAgent>({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => {
        console.error("WebSocket error:", error);
        toasts.add({
          title: "Connection error",
          description: "Reconnecting…",
          timeout: 4000
        });
      },
      [toasts]
    )
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) textareaRef.current.focus();
  }, [isStreaming]);

  useEffect(() => () => recRef.current?.abort(), []);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  const shortlistFor = useCallback(
    (title: string) => {
      if (isStreaming) return;
      sendMessage({
        role: "user",
        parts: [
          {
            type: "text",
            text: `Shortlist the top candidates for the ${title} JD.`
          }
        ]
      });
    },
    [isStreaming, sendMessage]
  );

  const toggleMic = useCallback(() => {
    if (listening) {
      recRef.current?.abort();
      recRef.current = null;
      setListening(false);
      return;
    }
    const SR =
      (
        window as unknown as {
          SpeechRecognition?: SpeechRecognitionCtor;
          webkitSpeechRecognition?: SpeechRecognitionCtor;
        }
      ).SpeechRecognition?.bind(window) ??
      (
        window as unknown as {
          SpeechRecognition?: SpeechRecognitionCtor;
          webkitSpeechRecognition?: SpeechRecognitionCtor;
        }
      ).webkitSpeechRecognition?.bind(window);
    if (!SR) {
      toasts.add({
        title: "Voice not supported",
        description: "Use Chrome or Edge for speech input.",
        timeout: 4000
      });
      return;
    }
    const rec: SpeechRecognitionLike = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    let finalText = "";
    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interim += t;
      }
      setInput(finalText + interim);
    };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      setListening(false);
      toasts.add({
        title: "Mic error",
        description: e.error || "Unknown",
        timeout: 4000
      });
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
    };
    recRef.current = rec;
    setListening(true);
    rec.start();
  }, [listening, toasts]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              AI Talent Shortlister
            </h1>
            <Badge variant="secondary">
              <ChatCircleDotsIcon size={12} weight="bold" className="mr-1" />
              Pool of 100
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <div className="flex items-center gap-1.5">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <ThemeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={clearHistory}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<ChatCircleDotsIcon size={32} />}
              title="Shortlist candidates from the pool"
              contents={
                <div className="flex flex-col items-center gap-3">
                  <p className="text-sm text-kumo-subtle max-w-md text-center">
                    Pick a JD from the floating buttons to recall one of the
                    precomputed roles, or describe the role in your own words.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {SAMPLE_QUERIES.map((p) => (
                      <Button
                        key={p}
                        variant="outline"
                        size="sm"
                        disabled={isStreaming}
                        onClick={() =>
                          sendMessage({
                            role: "user",
                            parts: [{ type: "text", text: p }]
                          })
                        }
                      >
                        {p}
                      </Button>
                    ))}
                  </div>
                </div>
              }
            />
          )}

          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;
            // When a shortlist already rendered as schema-valid candidate
            // cards, the agent's post-tool prose is a redundant (and, on
            // fp8-fast, often stuttered) echo — drop those text bubbles.
            const hasShortlist = message.parts.some(
              (
                p
              ): p is Extract<UIMessage["parts"][number], { state: string }> =>
                isToolUIPart(p) &&
                p.state === "output-available" &&
                Array.isArray(
                  (p.output as { shortlist?: { candidates?: unknown } })
                    ?.shortlist?.candidates
                ) &&
                ((p.output as { shortlist?: { candidates?: unknown[] } })
                  ?.shortlist?.candidates?.length ?? 0) > 0
            );

            return (
              <div key={message.id} className="space-y-2">
                {showDebug && (
                  <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                    {JSON.stringify(message, null, 2)}
                  </pre>
                )}

                {message.parts.map((part, i) => {
                  const key = `${message.id}-${i}`;

                  if (isToolUIPart(part)) {
                    return <ToolPartView key={key} part={part} />;
                  }

                  if (part.type === "reasoning") {
                    if (!part.text.trim()) return null;
                    const isDone = part.state === "done" || !isStreaming;
                    return (
                      <div key={key} className="flex justify-start">
                        <details className="max-w-[85%] w-full" open={!isDone}>
                          <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                            <BrainIcon size={14} className="text-purple-400" />
                            <span className="font-medium text-kumo-default">
                              Reasoning
                            </span>
                            {isDone ? (
                              <span className="text-xs text-kumo-success">
                                Complete
                              </span>
                            ) : (
                              <span className="text-xs text-kumo-brand">
                                Thinking...
                              </span>
                            )}
                            <CaretDownIcon
                              size={14}
                              className="ml-auto text-kumo-inactive"
                            />
                          </summary>
                          <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                            {part.text}
                          </pre>
                        </details>
                      </div>
                    );
                  }

                  if (part.type === "text") {
                    if (!part.text) return null;
                    if (isUser) {
                      return (
                        <div key={key} className="flex justify-end">
                          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                            {part.text}
                          </div>
                        </div>
                      );
                    }
                    if (hasShortlist) return null;
                    return (
                      <div key={key} className="flex justify-start">
                        <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          <Streamdown
                            className="sd-theme rounded-2xl rounded-bl-md p-3"
                            plugins={{ code }}
                            controls={false}
                            isAnimating={isLastAssistant && isStreaming}
                          >
                            {part.text}
                          </Streamdown>
                        </div>
                      </div>
                    );
                  }

                  return null;
                })}
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-base">
        {/* JD shortcuts — centered, just above the chat input */}
        <div className="max-w-3xl mx-auto px-5 pt-4 flex flex-wrap justify-center gap-2">
          {JD_BUTTONS.map((title) => (
            <Button
              key={title}
              variant="secondary"
              size="sm"
              icon={<BriefcaseIcon size={14} />}
              disabled={isStreaming}
              onClick={() => shortlistFor(title)}
            >
              {title}
            </Button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder={
                listening
                  ? "Listening…"
                  : "Describe the role or ask for a shortlist…"
              }
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            <Button
              type="button"
              variant={listening ? "primary" : "ghost"}
              shape="square"
              aria-label="Toggle voice input"
              icon={
                <MicrophoneIcon
                  size={18}
                  weight={listening ? "fill" : "regular"}
                />
              }
              onClick={toggleMic}
              disabled={!connected}
              className="mb-0.5"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !connected}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex flex-col items-center justify-center h-screen gap-2 text-kumo-inactive">
            <div className="flex items-center gap-2">
              <CircleIcon
                size={10}
                weight="fill"
                className="animate-pulse text-kumo-brand"
              />
              Connecting to the agent…
            </div>
          </div>
        }
      >
        <Chat />
      </Suspense>
    </Toasty>
  );
}
