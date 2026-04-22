import { useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";

import { MarkdownContent } from "../../components/MarkdownContent";
import type { KnowledgeSourceRef, KnowledgeToolTrace } from "../../types";

export type KnowledgeChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: KnowledgeSourceRef[];
  tools?: KnowledgeToolTrace[];
  status?: "streaming" | "completed" | "error";
};

type AskPanelProps = {
  query: string;
  onQueryChange(value: string): void;
  onSubmit(): void;
  onStop(): void;
  onPickSuggestion(value: string): void;
  disabled: boolean;
  loading: boolean;
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
  const pairs = Object.entries(meta).filter(([key]) => key !== "sources");
  return (
    <div className="knowledge-tool-meta">
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

function ToolTimeline({ tools = [] }: { tools?: KnowledgeToolTrace[] }) {
  if (!tools.length) {
    return null;
  }
  return (
    <details className="knowledge-tool-trace" open>
      <summary>查看本轮调用的工具</summary>
      <div className="knowledge-tool-list">
        {tools.map((tool) => (
          <article key={tool.id} className={`knowledge-tool-card is-${tool.status}`}>
            <div className="knowledge-tool-head">
              <div className="knowledge-tool-status">
                <span className="knowledge-tool-status-dot" />
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
  onPickSuggestion,
  disabled,
  loading,
  messages,
  recentQueries,
}: AskPanelProps) {
  const threadRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    const element = threadRef.current;
    if (!element) {
      return;
    }
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const hasMessages = messages.length > 0;

  return (
    <div className={`knowledge-chat-shell knowledge-chat-shell-gpt ${hasMessages ? "has-thread" : "is-empty"}`}>
      <div ref={threadRef} className="knowledge-chat-scroll">
        {!hasMessages ? (
          <div className="knowledge-chat-welcome">
            <span className="library-kicker">Knowledge Chat</span>
            <h2>直接问你的知识库</h2>
            <p>边检索、边生成、边展示工具轨迹。把视频、知识笔记和标签关系收束成一个真正能追问的助手。</p>
            <div className="knowledge-chat-suggestion-grid">
              {suggestionItems.map((item) => (
                <button key={item} className="knowledge-chat-suggestion-card" type="button" onClick={() => onPickSuggestion(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="knowledge-chat-thread">
            {messages.map((message) => (
              <article key={message.id} className={`knowledge-chat-message-row ${message.role === "user" ? "is-user" : "is-assistant"}`}>
                <div className={`knowledge-chat-bubble ${message.role === "user" ? "is-user" : "is-assistant"}`}>
                  <div className="knowledge-chat-message-meta">
                    <strong>{message.role === "user" ? "你" : "知识库助手"}</strong>
                    {message.role === "assistant" && message.status === "streaming" ? (
                      <span className="knowledge-streaming-indicator">正在输出</span>
                    ) : null}
                  </div>
                  {message.role === "assistant" ? (
                    <>
                      <ToolTimeline tools={message.tools} />
                      <MarkdownContent className="knowledge-chat-markdown" content={message.content || (message.status === "streaming" ? "正在整理回答..." : "")} />
                    </>
                  ) : (
                    <p className="knowledge-chat-user-text">{message.content}</p>
                  )}
                  {message.role === "assistant" && message.sources?.length ? (
                    <div className="knowledge-chat-sources">
                      {message.sources.map((source) => (
                        <Link key={`${source.video_id}-${source.timestamp || "na"}`} className="knowledge-chat-source-card" to={`/videos/${source.video_id}`}>
                          <strong>{source.title}</strong>
                          <span>{Math.round(source.relevance_score * 100)}%{source.timestamp ? ` · ${source.timestamp}` : ""}</span>
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="knowledge-chat-composer-dock">
        <div className="knowledge-chat-composer-surface">
          <textarea
            className="textarea-field knowledge-chat-textarea"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="问知识库任何问题，例如：我最近在学什么？把 OpenCV 相关内容帮我串起来。"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
          <div className="knowledge-chat-composer-footer">
            <div className="knowledge-chat-suggestion-row">
              {suggestionItems.slice(0, hasMessages ? 3 : 4).map((item) => (
                <button key={item} className="filter-pill" type="button" onClick={() => onPickSuggestion(item)}>
                  <span>{item}</span>
                </button>
              ))}
            </div>
            <div className="knowledge-chat-action-row">
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
