import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SVGProps } from "react";
import { Link } from "react-router-dom";

import { MarkdownContent } from "../../components/MarkdownContent";
import type { KnowledgeSourceRef, KnowledgeToolTrace } from "../../types";

export type KnowledgeChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  sources?: KnowledgeSourceRef[];
  tools?: KnowledgeToolTrace[];
  status?: "streaming" | "completed" | "error";
};

type AskPanelProps = {
  query: string;
  onQueryChange(value: string): void;
  onSubmit(): void;
  onStop(): void;
  onNewConversation(): void;
  onPickSuggestion(value: string): void;
  disabled: boolean;
  loading: boolean;
  hasContext: boolean;
  messages: KnowledgeChatMessage[];
  recentQueries: string[];
};

const DEFAULT_SUGGESTIONS = [
  "我最近主要在学什么主题？",
  "帮我串一下答题卡识别这条知识线。",
  "有哪些视频反复讲 OpenCV / 深度学习？",
  "把最近内容整理成一份复习提纲。",
];

function renderToolMeta(meta: KnowledgeToolTrace["meta"]) {
  if (!meta) {
    return null;
  }
  const sourceItems = Array.isArray(meta.sources) ? meta.sources : [];
  const pairs = Object.entries(meta).filter(([key]) => key !== "sources" && key !== "reasoning_character_count");
  const reasoningCharacterCount = Number(meta.reasoning_character_count || 0);
  return (
    <div className="knowledge-tool-meta">
      {reasoningCharacterCount > 0 ? (
        <span className="helper-chip">已收到推理流</span>
      ) : null}
      {pairs.map(([key, value]) => (
        <span key={key} className="helper-chip">
          {key.replace(/_/g, " ")} {String(value)}
        </span>
      ))}
      {sourceItems.length ? (
        <div className="knowledge-tool-source-preview">
          {sourceItems.slice(0, 3).map((item, index) => {
            if (!item || typeof item !== "object") {
              return null;
            }
            const label = String((item as { title?: string }).title || `来源 ${index + 1}`);
            const timestamp = String((item as { timestamp?: string }).timestamp || "").trim();
            return (
              <span key={`${label}-${timestamp || index}`} className="knowledge-tool-source-chip">
                {label}{timestamp ? ` · ${timestamp}` : ""}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function SummaryToolIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path className="knowledge-tool-summary-icon-page" d="M6.5 4.5h5.25L15 7.75v7.75H6.5a1.5 1.5 0 0 1-1.5-1.5v-8a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path className="knowledge-tool-summary-icon-fold" d="M11.75 4.5v3.25H15" />
      <path d="M8 10.25h4.25" />
      <path d="M8 12.75h3" />
    </svg>
  );
}

function formatSourceMeta(source: KnowledgeSourceRef) {
  const parts: string[] = [];
  if (source.page_number) {
    parts.push(`P${source.page_number}`);
  }
  if (source.video_title && source.video_title !== source.title) {
    parts.push(source.video_title);
  }
  parts.push(`${Math.round(source.relevance_score * 100)}%`);
  if (source.timestamp) {
    parts.push(source.timestamp);
  }
  return parts.join(" · ");
}

function buildSourceCards(sources: KnowledgeSourceRef[] = []) {
  const sourceMap = new Map<string, KnowledgeSourceRef & { timestamps: string[] }>();
  sources.forEach((source) => {
    const key = source.video_id || source.title;
    const existing = sourceMap.get(key);
    const timestamps = source.timestamp ? [source.timestamp] : [];
    if (!existing) {
      sourceMap.set(key, { ...source, timestamps });
      return;
    }
    const nextTimestamps = [...existing.timestamps];
    timestamps.forEach((timestamp) => {
      if (!nextTimestamps.includes(timestamp)) {
        nextTimestamps.push(timestamp);
      }
    });
    if (source.relevance_score > existing.relevance_score) {
      sourceMap.set(key, { ...source, timestamps: nextTimestamps });
      return;
    }
    existing.timestamps = nextTimestamps;
  });
  return [...sourceMap.values()].slice(0, 4);
}

function ToolTimeline({ tools = [] }: { tools?: KnowledgeToolTrace[] }) {
  if (!tools.length) {
    return null;
  }
  const runningCount = tools.filter((tool) => tool.status === "running").length;
  const errorCount = tools.filter((tool) => tool.status === "error").length;
  const completedCount = tools.filter((tool) => tool.status === "completed").length;
  const runningTool = tools.find((tool) => tool.status === "running") || null;
  const runningToolIndex = runningTool ? tools.findIndex((tool) => tool.id === runningTool.id) : -1;
  const traceStatus = runningCount ? "running" : errorCount ? "error" : "completed";
  const titleText = runningTool
    ? `正在调用：${runningTool.label}`
    : errorCount
      ? "工具链需要注意"
      : "工具链";
  const statusText = runningCount
    ? `第 ${runningToolIndex + 1 || completedCount + 1}/${tools.length} 步`
    : errorCount
      ? `${errorCount} 个工具失败`
      : `已完成 ${completedCount} 个工具`;
  return (
    <details className={`knowledge-tool-trace is-${traceStatus}`}>
      <summary>
        <span className="knowledge-tool-summary-main">
          <span className="knowledge-tool-summary-icon">
            <SummaryToolIcon />
          </span>
          <span className="knowledge-tool-summary-title">{titleText}</span>
          {runningTool ? (
            <span className="knowledge-tool-summary-progress" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          ) : null}
        </span>
        <span className="knowledge-tool-summary-status" aria-live="polite">{statusText}</span>
      </summary>
      <div className="knowledge-tool-list">
        {tools.map((tool, index) => (
          <article key={tool.id} className={`knowledge-tool-card is-${tool.status}`}>
            <div className="knowledge-tool-head">
              <div className="knowledge-tool-status">
                <span className="knowledge-tool-status-dot" />
                <span className="knowledge-tool-step-index">{index + 1}</span>
                <strong>{tool.label}</strong>
              </div>
              <span className="knowledge-tool-status-text">
                {tool.status === "running" ? "运行中" : tool.status === "error" ? "失败" : "完成"}
              </span>
            </div>
            {tool.detail ? <p>{tool.detail}</p> : null}
            {renderToolMeta(tool.meta)}
          </article>
        ))}
      </div>
    </details>
  );
}

export function AskPanel({
  query,
  onQueryChange,
  onSubmit,
  onStop,
  onNewConversation,
  onPickSuggestion,
  disabled,
  loading,
  hasContext,
  messages,
  recentQueries,
}: AskPanelProps) {
  const threadRef = useRef<HTMLDivElement | null>(null);
  const threadContentRef = useRef<HTMLDivElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const suggestionItems = useMemo(() => {
    const seen = new Set<string>();
    const merged = [...recentQueries, ...DEFAULT_SUGGESTIONS];
    return merged.filter((item) => {
      const cleaned = item.trim();
      if (!cleaned || seen.has(cleaned)) {
        return false;
      }
      seen.add(cleaned);
      return true;
    }).slice(0, 6);
  }, [recentQueries]);

  const hasMessages = messages.length > 0;
  const lastMessage = hasMessages ? messages[messages.length - 1] : null;
  const lastToolSignature = useMemo(() => {
    return (lastMessage?.tools || [])
      .map((tool) => `${tool.id}:${tool.status}:${tool.detail || ""}`)
      .join("|");
  }, [lastMessage?.tools]);
  const latestAssistantIsStreaming = lastMessage?.role === "assistant" && lastMessage.status === "streaming";

  const updateScrollState = useCallback(() => {
    const element = threadRef.current;
    if (!element) {
      return;
    }
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const isNearBottom = distanceFromBottom < 160;
    shouldAutoScrollRef.current = isNearBottom;
    setShowScrollBottom(hasMessages && !isNearBottom);
  }, [hasMessages]);

  const scrollThreadToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = threadRef.current;
    if (!element) {
      return;
    }
    element.scrollTo({ top: element.scrollHeight, behavior });
    shouldAutoScrollRef.current = true;
    setShowScrollBottom(false);
  }, []);

  useLayoutEffect(() => {
    if (!hasMessages) {
      previousMessageCountRef.current = 0;
      return;
    }
    const hasNewMessage = messages.length > previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;
    if (hasNewMessage) {
      shouldAutoScrollRef.current = true;
    }
    if (shouldAutoScrollRef.current || hasNewMessage) {
      scrollThreadToBottom(latestAssistantIsStreaming ? "auto" : "smooth");
    } else {
      updateScrollState();
    }
  }, [
    hasMessages,
    latestAssistantIsStreaming,
    lastMessage?.id,
    lastMessage?.content,
    lastMessage?.reasoning,
    lastMessage?.sources?.length,
    lastMessage?.status,
    lastMessage?.role,
    lastToolSignature,
    messages.length,
    scrollThreadToBottom,
    updateScrollState,
  ]);

  useEffect(() => {
    if (!latestAssistantIsStreaming) {
      return;
    }
    const contentElement = threadContentRef.current;
    if (!contentElement) {
      return;
    }
    let frameId = 0;
    const scheduleScroll = () => {
      if (!shouldAutoScrollRef.current) {
        updateScrollState();
        return;
      }
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        scrollThreadToBottom("auto");
        updateScrollState();
      });
    };
    scheduleScroll();
    const observer = new ResizeObserver(scheduleScroll);
    observer.observe(contentElement);
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [latestAssistantIsStreaming, lastMessage?.id, scrollThreadToBottom, updateScrollState]);

  return (
    <div className={`knowledge-chat-shell knowledge-chat-shell-gpt ${hasMessages ? "has-thread" : "is-empty"}`}>
      <div ref={threadRef} className="knowledge-chat-scroll" onScroll={updateScrollState}>
        {!hasMessages ? (
          <div className="knowledge-chat-welcome">
            <span className="library-kicker">Knowledge Chat</span>
            <h2>直接问你的知识库</h2>
            <p>搜索、整理和追问你的视频知识库。</p>
            <div className="knowledge-chat-suggestion-grid">
              {suggestionItems.map((item) => (
                <button key={item} className="knowledge-chat-suggestion-card" type="button" onClick={() => onPickSuggestion(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div ref={threadContentRef} className="knowledge-chat-thread">
            {messages.map((message) => (
              <article key={message.id} className={`knowledge-chat-message-row ${message.role === "user" ? "is-user" : "is-assistant"}`}>
                <div className={`knowledge-chat-bubble ${message.role === "user" ? "is-user" : "is-assistant"}`}>
                  {message.role === "assistant" ? (
                    <div className="knowledge-chat-message-meta">
                      <strong>知识库助手</strong>
                      {message.status === "streaming" ? (
                        <span className="knowledge-streaming-indicator">正在输出</span>
                      ) : null}
                    </div>
                  ) : null}
                  {message.role === "assistant" ? (
                    <>
                      <div className={`knowledge-chat-answer-card ${message.status === "error" ? "is-error" : ""}`}>
                        <ToolTimeline tools={message.tools} />
                        {message.reasoning ? (
                          <details className="knowledge-chat-reasoning" open={message.status === "streaming"}>
                            <summary>
                              <span>思考</span>
                              <small>{message.status === "streaming" ? "正在更新" : "已完成"}</small>
                            </summary>
                            <pre>{message.reasoning}</pre>
                          </details>
                        ) : null}
                        <MarkdownContent className="knowledge-chat-markdown" content={message.content || (message.status === "streaming" ? "正在整理回答..." : "")} />
                      </div>
                    </>
                  ) : (
                    <p className="knowledge-chat-user-text">{message.content}</p>
                  )}
                  {message.role === "assistant" && message.sources?.length ? (
                    <details className="knowledge-chat-source-drawer">
                      <summary>
                        <span>参考来源</span>
                        <strong>{buildSourceCards(message.sources).length}</strong>
                      </summary>
                      <div className="knowledge-chat-sources">
                        {buildSourceCards(message.sources).map((source) => (
                          <Link key={source.video_id || source.title} className="knowledge-chat-source-card" to={`/videos/${source.video_id}`}>
                            <strong>{source.title}</strong>
                            <span>{formatSourceMeta(source)}</span>
                            {source.timestamps.length ? <small>{source.timestamps.slice(0, 3).join(" / ")}</small> : null}
                          </Link>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              </article>
            ))}
            <div ref={threadEndRef} className="knowledge-chat-thread-end" aria-hidden="true" />
          </div>
        )}
      </div>

      {showScrollBottom ? (
        <button
          className="knowledge-chat-scroll-bottom"
          type="button"
          onClick={() => scrollThreadToBottom("smooth")}
          aria-label="滚动到底部"
          title="滚动到底部"
        >
          <span aria-hidden="true">↓</span>
        </button>
      ) : null}

      <div className="knowledge-chat-composer-dock">
        <div className="knowledge-chat-composer-surface">
          <textarea
            className="textarea-field knowledge-chat-textarea"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="有问题，尽管问"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
          <div className="knowledge-chat-composer-footer">
            <div className="knowledge-chat-composer-hint">
              Enter 发送，Shift + Enter 换行
            </div>
            <div className="knowledge-chat-action-row">
              <button
                className="secondary-button knowledge-chat-new-session"
                type="button"
                onClick={onNewConversation}
                disabled={loading || !hasContext}
                title="清空当前会话上下文"
              >
                新会话
              </button>
              {loading ? (
                <button className="secondary-button" type="button" onClick={onStop}>
                  停止回答
                </button>
              ) : null}
              <button className="primary-button knowledge-chat-submit" type="button" onClick={onSubmit} disabled={disabled || loading}>
                {loading ? "回答中..." : "发送"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
