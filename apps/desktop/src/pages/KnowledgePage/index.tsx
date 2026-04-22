import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../../api";
import { AskPanel, type KnowledgeChatMessage } from "./AskPanel";
import { SearchPanel } from "./SearchPanel";
import { TagManager } from "./TagManager";
import { TagNetwork } from "./TagNetwork";
import type {
  KnowledgeNetworkResponse,
  KnowledgeSearchResult,
  KnowledgeStatsResponse,
  KnowledgeTagItem,
} from "../../types";

type KnowledgeView = "chat" | "workspace";

function createMessage(
  role: "user" | "assistant",
  content: string,
  options: Partial<Pick<KnowledgeChatMessage, "sources" | "tools" | "status">> = {},
) {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    sources: options.sources || [],
    tools: options.tools || [],
    status: options.status,
  } satisfies KnowledgeChatMessage;
}

export function KnowledgePage() {
  const navigate = useNavigate();
  const askAbortRef = useRef<AbortController | null>(null);
  const [activeView, setActiveView] = useState<KnowledgeView>("chat");
  const [stats, setStats] = useState<KnowledgeStatsResponse | null>(null);
  const [tags, setTags] = useState<KnowledgeTagItem[]>([]);
  const [network, setNetwork] = useState<KnowledgeNetworkResponse>({ nodes: [], links: [], selected_tags: [] });
  const [networkExpanded, setNetworkExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [askQuery, setAskQuery] = useState("");
  const [chatMessages, setChatMessages] = useState<KnowledgeChatMessage[]>([]);
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState("");
  const [managingVideoId, setManagingVideoId] = useState<string | null>(null);

  const videoTitleMap = useMemo(() => {
    return Object.fromEntries(
      network.nodes
        .filter((node) => node.type === "video")
        .map((node) => [String(node.id).replace(/^video_/, ""), node.label]),
    );
  }, [network.nodes]);

  const statsSummary = useMemo(() => ([
    { label: "视频", value: stats?.video_count ?? 0 },
    { label: "标签", value: stats?.tag_count ?? 0 },
    { label: "索引片段", value: stats?.indexed_chunk_count ?? 0 },
    { label: "未标记", value: stats?.untagged_video_count ?? 0 },
  ]), [stats]);

  async function refreshBase(nextSelectedTags: string[] = selectedTags, expanded: boolean = networkExpanded) {
    const [tagPayload, networkPayload, statsPayload] = await Promise.all([
      api.getKnowledgeTags(),
      api.getKnowledgeNetwork({
        selectedTags: nextSelectedTags,
        maxTags: expanded ? 20 : 12,
        maxVideos: expanded ? 10 : 8,
      }),
      api.getKnowledgeStats(),
    ]);
    if ("items" in tagPayload) {
      setTags(tagPayload.items as KnowledgeTagItem[]);
    }
    setNetwork(networkPayload);
    setStats(statsPayload);
    setStatus("");
  }

  useEffect(() => {
    void refreshBase().catch((error) => {
      setStatus(error instanceof Error ? error.message : "知识库初始化失败");
    });
  }, []);

  useEffect(() => {
    void refreshBase(selectedTags, networkExpanded).catch((error) => {
      setStatus(error instanceof Error ? error.message : "刷新知识库概览失败");
    });
  }, [selectedTags, networkExpanded]);

  useEffect(() => {
    if (activeView !== "workspace") {
      return;
    }
    const trimmed = query.trim();
    const timer = window.setTimeout(() => {
      if (!trimmed) {
        setResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      void api.searchKnowledge({
        query: trimmed,
        limit: 12,
        filters: selectedTags.length ? { tags: selectedTags } : undefined,
      }).then((payload) => {
        setResults(payload.results);
      }).catch((error) => {
        setStatus(error instanceof Error ? error.message : "搜索失败");
      }).finally(() => {
        setSearching(false);
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeView, query, selectedTags]);

  function toggleTag(tag: string) {
    setSelectedTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]);
  }

  function pushRecentQuery(value: string) {
    setRecentQueries((current) => [value, ...current.filter((item) => item !== value)].slice(0, 6));
  }

  function updateMessage(messageId: string, updater: (message: KnowledgeChatMessage) => KnowledgeChatMessage) {
    setChatMessages((current) => current.map((message) => message.id === messageId ? updater(message) : message));
  }

  async function handleAsk(seedQuery?: string) {
    const effectiveQuery = String(seedQuery ?? askQuery).trim();
    if (!effectiveQuery || asking) {
      return;
    }
    setAsking(true);
    setAskQuery("");
    setStatus("");
    const controller = new AbortController();
    askAbortRef.current = controller;
    const userMessage = createMessage("user", effectiveQuery);
    const assistantMessage = createMessage("assistant", "", {
      status: "streaming",
      tools: [],
      sources: [],
    });
    setChatMessages((current) => [...current, userMessage, assistantMessage]);
    pushRecentQuery(effectiveQuery);
    try {
      await api.streamKnowledgeAsk(
        { query: effectiveQuery, context_limit: 5 },
        {
          onTool: (tool) => {
            updateMessage(assistantMessage.id, (message) => {
              const existing = message.tools || [];
              const nextTools = existing.some((item) => item.id === tool.id)
                ? existing.map((item) => item.id === tool.id ? { ...item, ...tool } : item)
                : [...existing, tool];
              return { ...message, tools: nextTools };
            });
          },
          onTextDelta: (delta) => {
            if (!delta) {
              return;
            }
            updateMessage(assistantMessage.id, (message) => ({ ...message, content: `${message.content}${delta}` }));
          },
          onSources: (sources) => {
            updateMessage(assistantMessage.id, (message) => ({ ...message, sources }));
          },
          onDone: (payload) => {
            updateMessage(assistantMessage.id, (message) => ({
              ...message,
              content: payload.answer || message.content,
              sources: payload.sources,
              status: "completed",
            }));
          },
          onError: (message) => {
            setStatus(message);
            updateMessage(assistantMessage.id, (current) => ({
              ...current,
              content: current.content || `知识库助手暂时没有顺利完成回答。\n\n${message}`,
              status: "error",
            }));
          },
        },
        { signal: controller.signal },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        updateMessage(assistantMessage.id, (message) => ({
          ...message,
          content: message.content || "已停止本轮回答。",
          status: "completed",
        }));
        return;
      }
      const detail = error instanceof Error ? error.message : "问答失败";
      setStatus(detail);
      updateMessage(assistantMessage.id, (message) => ({
        ...message,
        content: message.content || `知识库助手暂时没有顺利完成回答。\n\n${detail}`,
        status: "error",
      }));
    } finally {
      askAbortRef.current = null;
      setAsking(false);
    }
  }

  function handleStopAsk() {
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    setAsking(false);
  }

  async function handleAutoTag() {
    setStatus("正在为未标记视频自动打标...");
    try {
      const payload = await api.autoTagKnowledge();
      setStatus(`已处理 ${payload.items.length} 个视频`);
      await refreshBase();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "自动打标失败");
    }
  }

  async function handleRebuild() {
    setStatus("正在重建知识库索引...");
    try {
      const payload = await api.rebuildKnowledgeIndex();
      setStatus(`索引已重建，共处理 ${payload.indexed_videos} 个视频`);
      await refreshBase();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "索引重建失败");
    }
  }

  return (
    <section className="knowledge-page knowledge-page-refined">
      <div className="knowledge-topbar">
        <div className="knowledge-view-tabs">
          <button className={`knowledge-view-tab ${activeView === "chat" ? "is-active" : ""}`} type="button" onClick={() => setActiveView("chat")}>
            AI 问答
          </button>
          <button className={`knowledge-view-tab ${activeView === "workspace" ? "is-active" : ""}`} type="button" onClick={() => setActiveView("workspace")}>
            工作台
          </button>
        </div>
        <div className="knowledge-topbar-actions">
          {statsSummary.map((item) => (
            <span key={item.label} className="helper-chip">{item.label} {item.value}</span>
          ))}
          <button className="secondary-button" type="button" onClick={() => void handleRebuild()}>重建索引</button>
          <button className="primary-button" type="button" onClick={() => void handleAutoTag()} disabled={!stats?.knowledge_llm_available}>
            自动打标未标记视频
          </button>
        </div>
      </div>

      {status ? <div className="knowledge-status-banner">{status}</div> : null}
      {!stats?.knowledge_llm_available ? <div className="knowledge-status-banner warning">知识库 LLM 未就绪，自动打标和问答暂不可用。</div> : null}

      {activeView === "chat" ? (
        <AskPanel
          query={askQuery}
          onQueryChange={setAskQuery}
          onSubmit={() => void handleAsk()}
          onStop={handleStopAsk}
          onPickSuggestion={(value) => {
            setAskQuery(value);
            void handleAsk(value);
          }}
          disabled={!stats?.knowledge_llm_available}
          loading={asking}
          messages={chatMessages}
          recentQueries={recentQueries}
        />
      ) : (
        <div className="knowledge-workbench-shell">
          <SearchPanel
            query={query}
            onQueryChange={setQuery}
            results={results}
            selectedTags={selectedTags}
            allTags={tags}
            onToggleTag={toggleTag}
            onManageTags={setManagingVideoId}
            searching={searching}
            statsSummary={statsSummary}
          />
          <TagNetwork
            network={network}
            selectedTags={selectedTags}
            expanded={networkExpanded}
            onToggleExpanded={() => setNetworkExpanded((current) => !current)}
            onToggleTag={toggleTag}
            onSelectVideo={(videoId) => navigate(`/videos/${videoId}`)}
          />
        </div>
      )}

      <TagManager
        videoId={managingVideoId}
        title={managingVideoId ? (videoTitleMap[managingVideoId] || managingVideoId) : ""}
        onClose={() => setManagingVideoId(null)}
        onUpdated={() => void refreshBase()}
      />
    </section>
  );
}
