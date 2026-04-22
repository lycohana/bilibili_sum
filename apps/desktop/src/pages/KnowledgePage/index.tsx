import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../../api";
import { AskPanel, type KnowledgeChatMessage } from "./AskPanel";
import { SearchPanel } from "./SearchPanel";
import { TagManager } from "./TagManager";
import { TagNetwork } from "./TagNetwork";
import type {
  KnowledgeChatHistoryItem,
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
  const [maintenanceMenuOpen, setMaintenanceMenuOpen] = useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const maintenanceMenuRef = useRef<HTMLDivElement | null>(null);
  const pendingDeltaRef = useRef<{ messageId: string; text: string }>({ messageId: "", text: "" });
  const pendingDeltaTimerRef = useRef<number | null>(null);

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

  useEffect(() => {
    if (!maintenanceMenuOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && maintenanceMenuRef.current?.contains(target)) {
        return;
      }
      setMaintenanceMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [maintenanceMenuOpen]);

  useEffect(() => {
    return () => {
      if (pendingDeltaTimerRef.current !== null) {
        window.clearTimeout(pendingDeltaTimerRef.current);
      }
    };
  }, []);

  function toggleTag(tag: string) {
    setSelectedTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]);
  }

  function pushRecentQuery(value: string) {
    setRecentQueries((current) => [value, ...current.filter((item) => item !== value)].slice(0, 6));
  }

  function updateMessage(messageId: string, updater: (message: KnowledgeChatMessage) => KnowledgeChatMessage) {
    setChatMessages((current) => current.map((message) => message.id === messageId ? updater(message) : message));
  }

  function flushPendingAssistantDelta() {
    if (pendingDeltaTimerRef.current !== null) {
      window.clearTimeout(pendingDeltaTimerRef.current);
      pendingDeltaTimerRef.current = null;
    }
    const pending = pendingDeltaRef.current;
    if (!pending.messageId || !pending.text) {
      return;
    }
    const { messageId, text } = pending;
    pendingDeltaRef.current = { messageId, text: "" };
    updateMessage(messageId, (message) => ({ ...message, content: `${message.content}${text}` }));
  }

  function enqueueAssistantDelta(messageId: string, delta: string) {
    if (!delta) {
      return;
    }
    const pending = pendingDeltaRef.current;
    if (pending.messageId !== messageId) {
      flushPendingAssistantDelta();
      pendingDeltaRef.current = { messageId, text: "" };
    }
    pendingDeltaRef.current.text += delta;
    if (pendingDeltaTimerRef.current === null) {
      pendingDeltaTimerRef.current = window.setTimeout(flushPendingAssistantDelta, 48);
    }
  }

  function buildAskHistory(): KnowledgeChatHistoryItem[] {
    return chatMessages
      .filter((message) => message.content.trim() && message.status !== "streaming")
      .slice(-8)
      .map((message) => ({
        role: message.role,
        content: message.content.trim().slice(0, 1200),
      }));
  }

  function handleNewConversation() {
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    flushPendingAssistantDelta();
    setAsking(false);
    setAskQuery("");
    setChatMessages([]);
    setStatus("");
  }

  async function handleAsk(seedQuery?: string) {
    const effectiveQuery = String(seedQuery ?? askQuery).trim();
    if (!effectiveQuery || asking) {
      return;
    }
    const history = buildAskHistory();
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
        { query: effectiveQuery, context_limit: 5, history },
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
            enqueueAssistantDelta(assistantMessage.id, delta);
          },
          onSources: (sources) => {
            flushPendingAssistantDelta();
            updateMessage(assistantMessage.id, (message) => ({ ...message, sources }));
          },
          onDone: (payload) => {
            flushPendingAssistantDelta();
            updateMessage(assistantMessage.id, (message) => ({
              ...message,
              content: payload.answer || message.content,
              sources: payload.sources,
              status: "completed",
            }));
          },
          onError: (message) => {
            flushPendingAssistantDelta();
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
        flushPendingAssistantDelta();
        updateMessage(assistantMessage.id, (message) => ({
          ...message,
          content: message.content || "已停止本轮回答。",
          status: "completed",
        }));
        return;
      }
      const detail = error instanceof Error ? error.message : "问答失败";
      flushPendingAssistantDelta();
      setStatus(detail);
      updateMessage(assistantMessage.id, (message) => ({
        ...message,
        content: message.content || `知识库助手暂时没有顺利完成回答。\n\n${detail}`,
        status: "error",
      }));
    } finally {
      flushPendingAssistantDelta();
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
    if (maintenanceBusy) {
      return;
    }
    setStatus("正在为未标记视频自动打标...");
    try {
      setMaintenanceBusy(true);
      const payload = await api.autoTagKnowledge();
      setStatus(`已处理 ${payload.items.length} 个视频`);
      await refreshBase();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "自动打标失败");
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function handleRebuild() {
    if (maintenanceBusy) {
      return;
    }
    setStatus("正在重建知识库索引...");
    try {
      setMaintenanceBusy(true);
      const payload = await api.rebuildKnowledgeIndex();
      setStatus(`索引已重建，共处理 ${payload.indexed_videos} 个视频`);
      await refreshBase();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "索引重建失败");
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function handleAutoTagAndRebuild() {
    if (maintenanceBusy) {
      return;
    }
    setStatus("正在自动打标并重建知识库索引...");
    try {
      setMaintenanceBusy(true);
      const tagPayload = await api.autoTagKnowledge();
      const indexPayload = await api.rebuildKnowledgeIndex();
      setStatus(`已处理 ${tagPayload.items.length} 个标签任务，索引已重建 ${indexPayload.indexed_videos} 个视频`);
      await refreshBase();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "知识库维护失败");
    } finally {
      setMaintenanceBusy(false);
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
          <div className={`knowledge-maintenance-menu ${maintenanceMenuOpen ? "is-open" : ""}`} ref={maintenanceMenuRef}>
            <button
              className="secondary-button knowledge-maintenance-trigger"
              type="button"
              aria-haspopup="menu"
              aria-expanded={maintenanceMenuOpen}
              disabled={maintenanceBusy}
              onClick={() => setMaintenanceMenuOpen((current) => !current)}
            >
              {maintenanceBusy ? "维护中..." : "知识库维护"}
              <span className="knowledge-maintenance-caret" aria-hidden="true" />
            </button>
            {maintenanceMenuOpen ? (
              <div className="knowledge-maintenance-popover" role="menu" aria-label="知识库维护设置">
                <button
                  className="knowledge-maintenance-item"
                  type="button"
                  role="menuitem"
                  disabled={maintenanceBusy}
                  onClick={() => {
                    setMaintenanceMenuOpen(false);
                    void handleRebuild();
                  }}
                >
                  <strong>重建索引</strong>
                  <span>重新扫描已有结果并刷新检索索引。</span>
                </button>
                <button
                  className="knowledge-maintenance-item"
                  type="button"
                  role="menuitem"
                  disabled={maintenanceBusy || !stats?.knowledge_llm_available}
                  onClick={() => {
                    setMaintenanceMenuOpen(false);
                    void handleAutoTag();
                  }}
                >
                  <strong>自动打标未标记视频</strong>
                  <span>使用知识库 LLM 为未标记内容补充标签。</span>
                </button>
                <button
                  className="knowledge-maintenance-item"
                  type="button"
                  role="menuitem"
                  disabled={maintenanceBusy || !stats?.knowledge_llm_available}
                  onClick={() => {
                    setMaintenanceMenuOpen(false);
                    void handleAutoTagAndRebuild();
                  }}
                >
                  <strong>打标后重建索引</strong>
                  <span>先补齐标签，再一次性刷新索引。</span>
                </button>
              </div>
            ) : null}
          </div>
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
          onNewConversation={handleNewConversation}
          onPickSuggestion={(value) => {
            setAskQuery(value);
            void handleAsk(value);
          }}
          disabled={!stats?.knowledge_llm_available}
          loading={asking}
          hasContext={chatMessages.length > 0 || Boolean(askQuery.trim())}
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
