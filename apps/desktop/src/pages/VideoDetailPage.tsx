import { useEffect, useMemo, useRef, useState, type SVGProps } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { progressEventClass, stageLabel, taskStatusClass } from "../appModel";
import { api } from "../api";
import { MarkdownContent } from "../components/MarkdownContent";
import {
  buildChapterGroups,
  buildKnowledgeCards,
  describeMindMapPlaceholder,
  describeTaskContentState,
  pickDetailTaskId,
  resolveKnowledgeNoteMarkdown,
  type DetailTab,
  type KnowledgeCard,
  type TaskPanelState,
} from "../detailModel";
import type { TaskDetail, TaskEvent, TaskStatus, TaskSummary, VideoAssetDetail } from "../types";
import { formatDateTime, formatDuration, formatTaskDuration, formatTokenCount, summarizeEvents, taskStatusLabel } from "../utils";

type TaskContext = {
  detail: TaskDetail;
  events: TaskEvent[];
};

type TaskStreamPayload = {
  event: TaskEvent;
  status: TaskStatus;
  updated_at: string;
  result?: TaskDetail["result"] | null;
};

type HeroStat = {
  id: "progress" | "content";
  label: string;
  value: string;
  mono?: boolean;
};

type SnapshotMetric = {
  label: string;
  value: string;
};

type RefreshDetailOptions = {
  forceTaskIds?: string[];
  preferredTaskId?: string | null;
  syncLibrary?: boolean;
};

type PlayerSeekTarget = {
  nonce: number;
  seconds: number | null;
};

const detailTabs: Array<{ id: DetailTab; label: string; description: string }> = [
  { id: "knowledge", label: "知识卡片", description: "按概览、要点、章节整理当前任务结果。" },
  { id: "summary", label: "知识笔记", description: "查看当前任务的完整笔记、重点展开和转写全文。" },
  { id: "mindmap", label: "思维导图", description: "预留按主题组织的知识结构视图入口。" },
];

function compareTasksByRecent(left: TaskSummary, right: TaskSummary) {
  const updatedAtDelta = new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
  if (updatedAtDelta !== 0) {
    return updatedAtDelta;
  }
  return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
}

function hasGeneratedResult(task: TaskSummary) {
  return task.status === "completed";
}

function buildTaskSnapshot(task?: Pick<TaskSummary, "created_at" | "updated_at" | "llm_total_tokens" | "task_duration_seconds"> | null): SnapshotMetric[] {
  if (!task) {
    return [];
  }

  return [
    { label: "创建时间", value: formatDateTime(task.created_at) },
    { label: "更新时间", value: formatDateTime(task.updated_at) },
    { label: "LLM Token", value: formatTokenCount(task.llm_total_tokens) },
    { label: "任务耗时", value: formatTaskDuration(task.task_duration_seconds) },
  ];
}

function buildBilibiliEmbedUrl(sourceUrl?: string | null) {
  if (!sourceUrl) {
    return null;
  }

  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.toLowerCase();
    if (!host.includes("bilibili.com") && !host.includes("b23.tv")) {
      return null;
    }

    const bvidFromPath = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] ?? null;
    const aidFromPath = url.pathname.match(/\/video\/av(\d+)/i)?.[1] ?? null;
    const bvid = url.searchParams.get("bvid") ?? bvidFromPath;
    const aid = url.searchParams.get("aid") ?? aidFromPath;
    const page = url.searchParams.get("p") ?? "1";

    if (!bvid && !aid) {
      return null;
    }

    const embedUrl = new URL("https://player.bilibili.com/player.html");
    embedUrl.searchParams.set("isOutside", "true");
    embedUrl.searchParams.set("autoplay", "0");
    embedUrl.searchParams.set("p", page);
    if (bvid) {
      embedUrl.searchParams.set("bvid", bvid);
    }
    if (aid) {
      embedUrl.searchParams.set("aid", aid);
    }
    return embedUrl.toString();
  } catch {
    return null;
  }
}

function withBilibiliPlayerSeek(embedUrl: string, seconds: number | null, nonce: number) {
  const url = new URL(embedUrl);
  if (seconds != null && Number.isFinite(seconds) && seconds >= 0) {
    url.searchParams.set("t", String(Math.floor(seconds)));
  } else {
    url.searchParams.delete("t");
  }
  url.searchParams.set("_ts", String(nonce));
  return url.toString();
}

function omitRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) {
    return record;
  }
  const nextRecord = { ...record };
  delete nextRecord[key];
  return nextRecord;
}

async function loadTaskContext(taskId: string): Promise<TaskContext> {
  const [detail, events] = await Promise.all([api.getTaskResult(taskId), api.getTaskEvents(taskId)]);
  return { detail, events };
}

export function VideoDetailPage({ onRefresh }: { onRefresh(): void }) {
  const { videoId = "" } = useParams();
  const navigate = useNavigate();
  const [video, setVideo] = useState<VideoAssetDetail | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [taskContexts, setTaskContexts] = useState<Record<string, TaskContext>>({});
  const [taskContextErrors, setTaskContextErrors] = useState<Record<string, string>>({});
  const [taskContextLoading, setTaskContextLoading] = useState<Record<string, boolean>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>("knowledge");
  const [taskPanelState, setTaskPanelState] = useState<TaskPanelState>("collapsed");
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [selectedPageNumber, setSelectedPageNumber] = useState<number | null>(null);
  const [playerSeekTarget, setPlayerSeekTarget] = useState<PlayerSeekTarget>({ nonce: 0, seconds: null });
  const lastAutoRefreshEventRef = useRef<string | null>(null);
  const taskPopoverRef = useRef<HTMLDivElement | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const playerFrameRef = useRef<HTMLDivElement | null>(null);
  const activeVideoIdRef = useRef(videoId);
  const selectedTaskIdRef = useRef<string | null>(null);
  const refreshRequestRef = useRef(0);
  const taskContextCacheRef = useRef<Map<string, TaskContext>>(new Map());
  const taskContextPromiseRef = useRef<Map<string, Promise<TaskContext>>>(new Map());
  const taskContextSequenceRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    activeVideoIdRef.current = videoId;
  }, [videoId]);

  useEffect(() => {
    setPlayerSeekTarget({ nonce: 0, seconds: null });
  }, [videoId]);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  async function ensureTaskContext(taskId: string, options: { force?: boolean } = {}) {
    const { force = false } = options;
    const currentVideoId = activeVideoIdRef.current;

    if (!force) {
      const cachedContext = taskContextCacheRef.current.get(taskId);
      if (cachedContext) {
        setTaskContexts((current) => current[taskId] ? current : { ...current, [taskId]: cachedContext });
        setTaskContextErrors((current) => omitRecordKey(current, taskId));
        return cachedContext;
      }

      const pendingRequest = taskContextPromiseRef.current.get(taskId);
      if (pendingRequest) {
        return pendingRequest;
      }
    }

    const nextSequence = (taskContextSequenceRef.current.get(taskId) ?? 0) + 1;
    taskContextSequenceRef.current.set(taskId, nextSequence);
    setTaskContextLoading((current) => current[taskId] ? current : { ...current, [taskId]: true });
    setTaskContextErrors((current) => omitRecordKey(current, taskId));

    const taskContextRequest = loadTaskContext(taskId)
      .then((context) => {
        if (taskContextSequenceRef.current.get(taskId) !== nextSequence) {
          return taskContextCacheRef.current.get(taskId) ?? context;
        }

        taskContextCacheRef.current.set(taskId, context);
        if (activeVideoIdRef.current === currentVideoId) {
          setTaskContexts((current) => ({ ...current, [taskId]: context }));
        }
        return context;
      })
      .catch((error) => {
        if (taskContextSequenceRef.current.get(taskId) === nextSequence && activeVideoIdRef.current === currentVideoId) {
          const message = error instanceof Error ? error.message : "任务详情加载失败";
          setTaskContextErrors((current) => ({ ...current, [taskId]: message }));
        }
        throw error;
      })
      .finally(() => {
        if (taskContextPromiseRef.current.get(taskId) === taskContextRequest) {
          taskContextPromiseRef.current.delete(taskId);
        }
        if (taskContextSequenceRef.current.get(taskId) === nextSequence && activeVideoIdRef.current === currentVideoId) {
          setTaskContextLoading((current) => omitRecordKey(current, taskId));
        }
      });

    taskContextPromiseRef.current.set(taskId, taskContextRequest);
    return taskContextRequest;
  }

  async function refreshDetail(options: RefreshDetailOptions = {}) {
    const {
      forceTaskIds = [],
      preferredTaskId,
      syncLibrary = false,
    } = options;
    const requestId = ++refreshRequestRef.current;
    const currentVideoId = videoId;

    try {
      const [videoDetail, videoTasks] = await Promise.all([api.getVideo(currentVideoId), api.getVideoTasks(currentVideoId)]);
      if (activeVideoIdRef.current !== currentVideoId || refreshRequestRef.current !== requestId) {
        return;
      }

      const orderedVideoTasks = [...videoTasks].sort(compareTasksByRecent);
      const resolvedPreferredTaskId = preferredTaskId === undefined ? selectedTaskIdRef.current : preferredTaskId;
      const nextSelectedTaskId = pickDetailTaskId(orderedVideoTasks, resolvedPreferredTaskId);
      const latestTaskId = orderedVideoTasks[0]?.task_id ?? null;
      const requiredTaskIds = [...new Set([nextSelectedTaskId, latestTaskId].filter(Boolean))] as string[];
      const forcedTaskIds = new Set(forceTaskIds);
      const requiredContexts = new Map<string, TaskContext>();

      await Promise.all(
        requiredTaskIds.map(async (taskId) => {
          requiredContexts.set(taskId, await ensureTaskContext(taskId, { force: forcedTaskIds.has(taskId) }));
        }),
      );

      if (activeVideoIdRef.current !== currentVideoId || refreshRequestRef.current !== requestId) {
        return;
      }

      const visibleTaskIds = new Set(orderedVideoTasks.map((task) => task.task_id));
      selectedTaskIdRef.current = nextSelectedTaskId;
      setVideo(videoDetail);
      setTasks(videoTasks);
      setSelectedTaskId(nextSelectedTaskId);
      setTaskContexts((current) => {
        const nextContexts: Record<string, TaskContext> = {};
        for (const task of orderedVideoTasks) {
          const taskId = task.task_id;
          const context = requiredContexts.get(taskId) ?? current[taskId];
          if (context) {
            nextContexts[taskId] = context;
          }
        }
        return nextContexts;
      });
      setTaskContextErrors((current) => Object.fromEntries(
        Object.entries(current).filter(([taskId]) => visibleTaskIds.has(taskId)),
      ));
      setTaskContextLoading((current) => Object.fromEntries(
        Object.entries(current).filter(([taskId]) => visibleTaskIds.has(taskId)),
      ));

      if (syncLibrary) {
        onRefresh();
      }
    } catch (error) {
      if (activeVideoIdRef.current === currentVideoId && refreshRequestRef.current === requestId) {
        setStatus(error instanceof Error ? error.message : "视频详情加载失败");
      }
      throw error;
    }
  }

  function handleSelectTask(taskId: string) {
    selectedTaskIdRef.current = taskId;
    setSelectedTaskId(taskId);
    void ensureTaskContext(taskId).catch(() => undefined);
  }

  useEffect(() => {
    refreshRequestRef.current += 1;
    activeVideoIdRef.current = videoId;
    selectedTaskIdRef.current = null;
    setVideo(null);
    setTasks([]);
    setTaskContexts({});
    setTaskContextErrors({});
    setTaskContextLoading({});
    setSelectedTaskId(null);
    setActiveTab("knowledge");
    setTaskPanelState("collapsed");
    setActionMenuOpen(false);
    setStatus("");
    setSelectedPageNumber(null);
    void refreshDetail({ preferredTaskId: null }).catch(() => undefined);
  }, [videoId]);

  const orderedTasks = useMemo(() => [...tasks].sort(compareTasksByRecent), [tasks]);
  const availablePages = video?.pages ?? [];
  const pageGeneratedMap = useMemo(() => {
    const nextMap = new Map<number, boolean>();
    for (const task of orderedTasks) {
      const pageNumber = task.page_number ?? 1;
      nextMap.set(pageNumber, Boolean(nextMap.get(pageNumber)) || hasGeneratedResult(task));
    }
    return nextMap;
  }, [orderedTasks]);
  const effectivePageNumber = selectedPageNumber ?? availablePages[0]?.page ?? null;
  const currentPage = availablePages.find((page) => page.page === effectivePageNumber) ?? null;
  const pageTasks = useMemo(() => {
    if (!availablePages.length || effectivePageNumber == null) {
      return orderedTasks;
    }
    return orderedTasks.filter((task) => (task.page_number ?? 1) === effectivePageNumber);
  }, [availablePages.length, effectivePageNumber, orderedTasks]);
  const latestTaskId = pageTasks[0]?.task_id ?? null;
  const latestTaskSummary = pageTasks[0] ?? null;
  const latestTaskContext = latestTaskId ? taskContexts[latestTaskId] ?? null : null;
  const latestTaskDetail = latestTaskContext?.detail ?? null;
  const latestEvents = latestTaskContext?.events ?? [];
  const selectedTaskSummary = pageTasks.find((task) => task.task_id === selectedTaskId) ?? null;
  const selectedTaskContext = selectedTaskId ? taskContexts[selectedTaskId] ?? null : null;
  const selectedTaskDetail = selectedTaskContext?.detail ?? null;
  const isViewingLatest = Boolean(selectedTaskId && latestTaskId && selectedTaskId === latestTaskId);
  const isLatestTaskLoading = Boolean(latestTaskId && taskContextLoading[latestTaskId] && !latestTaskContext);
  const isSelectedTaskLoading = Boolean(selectedTaskId && taskContextLoading[selectedTaskId] && !selectedTaskContext);
  const latestTaskLoadError = latestTaskId ? taskContextErrors[latestTaskId] ?? null : null;
  const selectedTaskLoadError = selectedTaskId ? taskContextErrors[selectedTaskId] ?? null : null;

  useEffect(() => {
    lastAutoRefreshEventRef.current = null;
  }, [latestTaskId]);

  useEffect(() => {
    if (!availablePages.length) {
      if (selectedPageNumber !== null) {
        setSelectedPageNumber(null);
      }
      return;
    }
    if (selectedPageNumber && availablePages.some((page) => page.page === selectedPageNumber)) {
      return;
    }
    const preferredPage = orderedTasks.find((task) => task.page_number != null)?.page_number ?? availablePages[0]?.page ?? null;
    setSelectedPageNumber(preferredPage);
  }, [availablePages, orderedTasks, selectedPageNumber]);

  useEffect(() => {
    const nextSelectedTaskId = pickDetailTaskId(pageTasks, selectedTaskIdRef.current);
    if (nextSelectedTaskId === selectedTaskIdRef.current) {
      return;
    }
    selectedTaskIdRef.current = nextSelectedTaskId;
    setSelectedTaskId(nextSelectedTaskId);
    if (nextSelectedTaskId) {
      void ensureTaskContext(nextSelectedTaskId).catch(() => undefined);
    }
  }, [pageTasks]);

  useEffect(() => {
    if (!latestTaskId) {
      return;
    }

    const source = api.createTaskEventSource(latestTaskId, latestEvents.at(-1)?.created_at);
    source.addEventListener("progress", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as TaskStreamPayload;
      setTaskContexts((current) => {
        const existingContext = current[latestTaskId];
        if (!existingContext) {
          return current;
        }

        const nextEvents = existingContext.events.some((item) => item.event_id === payload.event.event_id)
          ? existingContext.events
          : [...existingContext.events, payload.event];
        const nextContext = {
          detail: {
            ...existingContext.detail,
            status: payload.status,
            updated_at: payload.updated_at,
            result: payload.result === undefined ? existingContext.detail.result : payload.result,
            llm_total_tokens: payload.result?.llm_total_tokens ?? existingContext.detail.llm_total_tokens,
          },
          events: nextEvents,
        };
        taskContextCacheRef.current.set(latestTaskId, nextContext);
        return { ...current, [latestTaskId]: nextContext };
      });
      setTasks((current) => current.map((task) => (
        task.task_id === latestTaskId
          ? {
            ...task,
            status: payload.status,
            updated_at: payload.updated_at,
            llm_total_tokens: payload.result?.llm_total_tokens ?? task.llm_total_tokens,
          }
          : task
      )));
      setVideo((current) => current ? {
        ...current,
        latest_status: payload.status,
        updated_at: payload.updated_at,
        latest_result: payload.result === undefined ? current.latest_result : payload.result,
      } : current);
    });
    source.onerror = () => source.close();
    return () => source.close();
  }, [latestTaskId]);

  useEffect(() => {
    if (!latestTaskId || !latestEvents.length) {
      return;
    }

    const terminalEvent = [...latestEvents].reverse().find((event) => (
      event.stage === "completed" || event.stage === "failed" || event.stage === "cancelled"
    ));
    if (!terminalEvent) {
      return;
    }

    const refreshKey = `${latestTaskId}:${terminalEvent.event_id}`;
    if (lastAutoRefreshEventRef.current === refreshKey) {
      return;
    }
    lastAutoRefreshEventRef.current = refreshKey;

    const timer = window.setTimeout(() => {
      void refreshDetail({
        forceTaskIds: [latestTaskId],
        preferredTaskId: selectedTaskIdRef.current,
        syncLibrary: true,
      }).catch(() => undefined);
    }, 300);

    return () => window.clearTimeout(timer);
  }, [latestEvents, latestTaskId]);

  useEffect(() => {
    if (taskPanelState !== "expanded" && !actionMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      const clickedTaskPopover = taskPopoverRef.current?.contains(target);
      const clickedActionMenu = actionMenuRef.current?.contains(target);

      if (!clickedTaskPopover) {
        setTaskPanelState("collapsed");
      }
      if (!clickedActionMenu) {
        setActionMenuOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setTaskPanelState("collapsed");
        setActionMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [actionMenuOpen, taskPanelState]);

  const selectedResult = selectedTaskDetail?.result ?? null;
  const liveProgress = useMemo(() => summarizeEvents(latestEvents), [latestEvents]);
  const contentState = useMemo(() => {
    if (isSelectedTaskLoading) {
      return {
        tone: "pending",
        title: "正在加载所选版本",
        description: "任务详情载入完成后，工作台会切换到对应的知识卡片和摘要内容。",
      } as const;
    }
    if (selectedTaskLoadError) {
      return {
        tone: "failed",
        title: "所选版本加载失败",
        description: "可以重新点击该版本重试，或先切换查看其他已完成任务。",
        detail: selectedTaskLoadError,
      } as const;
    }
    return describeTaskContentState(selectedTaskDetail);
  }, [isSelectedTaskLoading, selectedTaskDetail, selectedTaskLoadError]);
  const mindMapState = useMemo(() => {
    if (isSelectedTaskLoading) {
      return {
        tone: "pending",
        title: "主题树将在版本载入后可用",
        description: "当前正在同步所选内容版本的详细结果。",
        actionLabel: "加载中",
        actionEnabled: false,
      } as const;
    }
    if (selectedTaskLoadError) {
      return {
        tone: "failed",
        title: "当前版本暂时无法打开主题树",
        description: selectedTaskLoadError,
        actionLabel: "稍后重试",
        actionEnabled: false,
      } as const;
    }
    return describeMindMapPlaceholder(selectedTaskDetail);
  }, [isSelectedTaskLoading, selectedTaskDetail, selectedTaskLoadError]);
  const knowledgeCards = useMemo(() => buildKnowledgeCards(selectedResult), [selectedResult]);
  const overviewCard = knowledgeCards.find((item) => item.kind === "overview") ?? null;
  const keyPointCards = knowledgeCards.filter((item) => item.kind === "key-point");
  const chapterCards = knowledgeCards.filter((item) => item.kind === "chapter");
  const chapterGroups = useMemo(() => buildChapterGroups(chapterCards, selectedResult), [chapterCards, selectedResult]);
  const selectedKnowledgeNoteMarkdown = useMemo(() => resolveKnowledgeNoteMarkdown(selectedResult), [selectedResult]);
  const selectedTranscript = selectedResult?.transcript_text ?? "";
  const liveStatus = latestTaskDetail?.status ?? latestTaskSummary?.status ?? video?.latest_status;
  const liveMessage = latestTaskLoadError
    ?? liveProgress.failedEvent?.message
    ?? liveProgress.currentEvent?.message
    ?? latestTaskDetail?.error_message
    ?? (latestTaskSummary ? taskStatusLabel(latestTaskSummary.status) : "等待开始处理");
  const liveTaskCode = latestTaskId?.slice(0, 8) ?? null;
  const liveTaskTitle = latestTaskDetail?.title || latestTaskSummary?.title || video?.title || "当前任务";
  const liveTaskSnapshot = buildTaskSnapshot(latestTaskDetail ?? latestTaskSummary);
  const heroProgressSummary = latestTaskLoadError
    ? "同步失败"
    : liveProgress.failedEvent
    ? "处理失败"
    : liveProgress.currentEvent?.stage
      ? stageLabel(liveProgress.currentEvent.stage)
      : (latestTaskSummary ? taskStatusLabel(latestTaskSummary.status) : "等待开始");
  const selectedTaskCode = selectedTaskId ? selectedTaskId.slice(0, 8) : null;
  const selectedTaskSnapshot = buildTaskSnapshot(selectedTaskDetail ?? selectedTaskSummary);
  const selectedTaskTokenCount = selectedResult?.llm_total_tokens ?? selectedTaskDetail?.llm_total_tokens ?? selectedTaskSummary?.llm_total_tokens ?? null;
  const selectedTaskStatus = selectedTaskDetail?.status ?? selectedTaskSummary?.status;
  const canResummarize = Boolean(
    selectedTaskId
    && selectedTaskDetail?.result?.transcript_text?.trim()
    && selectedTaskDetail.result.artifacts?.summary_path,
  );
  const workspaceStatusLabel = isSelectedTaskLoading
    ? "加载中"
    : selectedTaskLoadError
      ? "加载失败"
      : contentState
        ? taskStatusLabel(selectedTaskStatus)
        : "已准备";
  const heroStats: HeroStat[] = [
    { id: "progress", label: "最新运行", value: heroProgressSummary },
    { id: "content", label: "当前查看", value: currentPage ? `P${currentPage.page}` : selectedTaskCode ? `任务 ${selectedTaskCode}` : "暂无任务", mono: true },
  ];
  const bilibiliEmbedBaseUrl = buildBilibiliEmbedUrl(currentPage?.source_url || video?.source_url);
  const bilibiliEmbedUrl = useMemo(() => {
    if (!bilibiliEmbedBaseUrl) {
      return null;
    }
    return withBilibiliPlayerSeek(bilibiliEmbedBaseUrl, playerSeekTarget.seconds, playerSeekTarget.nonce);
  }, [bilibiliEmbedBaseUrl, playerSeekTarget]);

  function handleSeekToChapter(seconds: number | null) {
    if (!bilibiliEmbedBaseUrl || seconds == null) {
      return;
    }
    setPlayerSeekTarget((current) => ({ nonce: current.nonce + 1, seconds }));
    playerFrameRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (!video) {
    return <section className="grid-card empty-state-card">正在加载视频详情...</section>;
  }

  return (
    <section className="video-detail-page">
      <div className="detail-page-shell">
        <div className="detail-page-toolbar">
          <Link className="detail-back-button" to="/library">
            <IconChevronLeft className="detail-back-icon" />
            返回视频库
          </Link>
        </div>

        <article className="video-detail-hero">
          <a className="video-detail-cover" href={currentPage?.source_url || video.source_url} target="_blank" rel="noreferrer">
            {video.cover_url ? <img src={video.cover_url} alt={video.title} loading="lazy" /> : <div className="video-detail-cover-placeholder">VIDEO</div>}
            <div className="video-detail-cover-overlay">
              <IconPlayCircle className="video-detail-play-icon" />
            </div>
            <div className="detail-duration-badge">{formatDuration(video.duration)}</div>
          </a>

          <div className="video-detail-copy">
            <div className="detail-hero-meta-row">
              <span className={`detail-status-badge ${taskStatusClass(liveStatus)}`}>{taskStatusLabel(liveStatus)}</span>
              <span className="detail-hero-meta-time">{formatDateTime(video.updated_at)}</span>
            </div>

            <h2 className="video-detail-title">{video.title}</h2>
            {availablePages.length ? (
              <div className="detail-page-switcher">
                <span className="detail-page-switcher-label">当前分 P</span>
                <select
                  className="detail-page-select"
                  value={effectivePageNumber ?? ""}
                  onChange={(event) => setSelectedPageNumber(Number(event.target.value) || null)}
                >
                  {availablePages.map((page) => (
                    <option key={page.page} value={page.page}>
                      {page.title}{pageGeneratedMap.get(page.page) ? " ✓" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="detail-task-float" ref={taskPopoverRef}>
              <div className={`detail-hero-capsule ${taskStatusClass(liveStatus)} ${taskPanelState === "expanded" ? "is-expanded" : ""}`}>
                <div className="detail-hero-capsule-grid">
                  {heroStats.map((item) => (
                    <div className="detail-hero-capsule-item" key={item.id}>
                      <span className="detail-hero-stat-label">{item.label}</span>
                      <div className="detail-hero-stat-value">
                        <strong className={item.mono ? "detail-hero-stat-mono" : ""}>{item.value}</strong>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="detail-hero-actions">
                  <div className="detail-action-menu" ref={actionMenuRef}>
                    <button
                      aria-label="更多操作"
                      aria-expanded={actionMenuOpen}
                      aria-haspopup="menu"
                      className={`detail-action-button secondary detail-action-button-compact detail-action-menu-trigger ${actionMenuOpen ? "is-open" : ""}`}
                      title="更多操作"
                      type="button"
                      onClick={() => setActionMenuOpen((current) => !current)}
                    >
                      <IconSettings className="detail-action-icon" />
                      <IconChevronDown className="detail-action-caret" />
                    </button>

                    {actionMenuOpen ? (
                      <div className="detail-action-popover" role="menu" aria-label="视频操作设置">
                        <button
                          className="detail-action-menu-item"
                          role="menuitem"
                          type="button"
                          disabled={!canResummarize}
                          onClick={async () => {
                            setActionMenuOpen(false);
                            setStatus("正在基于当前版本重新生成摘要...");
                            await api.resummarizeVideoTask(video.video_id, {
                              task_id: selectedTaskIdRef.current,
                              page_number: effectivePageNumber,
                            });
                            await refreshDetail({ preferredTaskId: null, syncLibrary: true });
                            setStatus("已开始新的摘要生成任务");
                          }}
                        >
                          <span className="detail-action-menu-item-icon" aria-hidden="true">
                            <IconSummaryRefresh className="detail-action-icon" />
                          </span>
                          <span className="detail-action-menu-copy">
                            <strong>重新生成摘要</strong>
                            <small>复用当前查看版本的转写与分段，仅重新调用 LLM 生成更完整的摘要结果。</small>
                          </span>
                        </button>
                        <button
                          className="detail-action-menu-item"
                          role="menuitem"
                          type="button"
                          onClick={async () => {
                            setActionMenuOpen(false);
                            setStatus("正在重新转写并生成摘要...");
                            await api.createVideoTask(video.video_id, { page_number: effectivePageNumber });
                            await refreshDetail({ preferredTaskId: null, syncLibrary: true });
                            setStatus("已开始新的转写摘要任务");
                          }}
                        >
                          <span className="detail-action-menu-item-icon" aria-hidden="true">
                            <IconTranscriptRefresh className="detail-action-icon" />
                          </span>
                          <span className="detail-action-menu-copy">
                            <strong>重新转写生成摘要</strong>
                            <small>重新抓取音频、执行转写，再生成一份新的完整摘要任务。</small>
                          </span>
                        </button>
                        <button
                          className="detail-action-menu-item"
                          role="menuitem"
                          type="button"
                          onClick={async () => {
                            setActionMenuOpen(false);
                            setStatus("正在刷新视频信息...");
                            await api.probeVideo({ url: video.source_url, force_refresh: true });
                            await refreshDetail({ preferredTaskId: selectedTaskIdRef.current, syncLibrary: true });
                            setStatus("视频信息已刷新");
                          }}
                        >
                          <span className="detail-action-menu-item-icon" aria-hidden="true">
                            <IconRefresh className="detail-action-icon" />
                          </span>
                          <span className="detail-action-menu-copy">
                            <strong>刷新视频信息</strong>
                            <small>重新拉取源站信息并同步当前视频元数据。</small>
                          </span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <button
                    aria-label="从视频库删除"
                    className="detail-action-button danger detail-action-button-compact"
                    title="从视频库删除"
                    type="button"
                    onClick={async () => {
                      if (!window.confirm("确定要从视频库删除这个视频吗？")) {
                        return;
                      }
                      await api.deleteVideo(video.video_id);
                      onRefresh();
                      navigate("/library");
                    }}
                  >
                    <IconTrash className="detail-action-icon" />
                  </button>
                  <button
                    aria-expanded={taskPanelState === "expanded"}
                    aria-label={taskPanelState === "expanded" ? "收起任务详情" : "展开任务详情"}
                    className={`detail-hero-capsule-toggle ${taskPanelState === "expanded" ? "is-expanded" : ""}`}
                    type="button"
                    onClick={() => setTaskPanelState((current) => current === "expanded" ? "collapsed" : "expanded")}
                  >
                    {taskPanelState === "expanded" ? "收起" : "展开"}
                    <IconChevronDown className="detail-task-toggle-icon" />
                  </button>
                </div>
              </div>

              {taskPanelState === "expanded" ? (
                <section
                  className="grid-card detail-task-panel"
                  role="dialog"
                  aria-label="任务进度与历史"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="detail-task-panel-header">
                    <div className="panel-header">
                      <h2>任务进度与历史</h2>
                    </div>
                    <button className="secondary-button" type="button" onClick={() => setTaskPanelState("collapsed")}>关闭</button>
                  </div>

                  <div className="detail-task-panel-body">
                    <article className="detail-task-panel-card detail-task-panel-card-live">
                      <div className="detail-task-section-head">
                        <div className="detail-task-section-copy">
                          <span className="detail-task-section-kicker">实时运行</span>
                          <h3>运行中任务</h3>
                        </div>
                        {liveTaskCode ? <span className="task-history-id">任务 {liveTaskCode}</span> : null}
                      </div>

                      {latestTaskSummary ? (
                        <div className="detail-task-live-grid">
                          <div className="detail-task-live-progress">
                            <div className="progress-bar-wrapper">
                              <div className="progress-bar-simple" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(liveProgress.progress)} aria-label="最新任务进度">
                                <div
                                  className={`progress-fill-simple ${liveProgress.hasError ? "error" : liveProgress.isCompleted ? "success" : ""}`}
                                  style={{ width: `${liveProgress.progress}%` }}
                                />
                              </div>
                              <div className="progress-info-simple">
                                <span className="progress-percent-simple">{Math.round(liveProgress.progress)}%</span>
                                <span className="progress-status-simple">{liveMessage}</span>
                              </div>
                            </div>

                            {latestTaskLoadError ? (
                              <div className="detail-error-banner" role="status">
                                <strong>运行详情同步失败</strong>
                                <span>{latestTaskLoadError}</span>
                              </div>
                            ) : null}

                            {liveProgress.filtered.length ? (
                              <details className="progress-stage-card">
                                <summary>
                                  <div>
                                    <strong>{stageLabel(liveProgress.currentEvent?.stage) || "阶段详情"}</strong>
                                    <span>{liveProgress.filtered.length} 条进度记录</span>
                                  </div>
                                  <span className="progress-stage-toggle">查看记录</span>
                                </summary>
                                <div className="progress-stage-list">
                                  {liveProgress.filtered.map((event) => (
                                    <article className={`progress-event-card ${progressEventClass(event.stage)}`} key={event.event_id}>
                                      <div className="progress-event-index">{stageLabel(event.stage)}</div>
                                      <div className="progress-event-copy">
                                        <div className="progress-event-topline">
                                          <strong>{event.message}</strong>
                                          <span>{formatDateTime(event.created_at)}</span>
                                        </div>
                                        <div className="progress-event-meta">阶段进度 {event.progress}%</div>
                                      </div>
                                    </article>
                                  ))}
                                </div>
                              </details>
                            ) : isLatestTaskLoading ? (
                              <div className="detail-inline-note detail-inline-note-pending" role="status">
                                正在同步该任务的实时进度。
                              </div>
                            ) : (
                              <div className="empty-placeholder">当前任务还没有生成进度记录。</div>
                            )}
                          </div>

                          <section className="detail-task-snapshot detail-task-snapshot-emphasis">
                            <div className="detail-task-snapshot-head">
                              <div className="detail-task-snapshot-copy">
                                <span className="detail-task-snapshot-kicker">当前任务概览</span>
                                <strong>{liveTaskTitle}</strong>
                                <small>{liveTaskCode ? `任务 ${liveTaskCode}` : "任务信息加载中"}</small>
                              </div>
                              <span className={`helper-chip ${taskStatusClass(liveStatus)}`}>{taskStatusLabel(liveStatus)}</span>
                            </div>
                            <div className="detail-task-snapshot-grid">
                              {liveTaskSnapshot.map((item) => (
                                <div className="detail-snapshot-metric" key={item.label}>
                                  <span>{item.label}</span>
                                  <strong>{item.value}</strong>
                                </div>
                              ))}
                            </div>
                          </section>
                        </div>
                      ) : (
                          <div className="empty-placeholder">当前分 P 还没有处理任务。</div>
                      )}
                    </article>

                    <div className="detail-task-panel-grid">
                      <article className="detail-task-panel-card detail-task-panel-card-history">
                        <div className="detail-task-section-head">
                          <div className="detail-task-section-copy">
                            <span className="detail-task-section-kicker">版本列表</span>
                            <h3>内容版本</h3>
                          </div>
                          <span className="detail-task-section-count">{pageTasks.length}</span>
                        </div>

                        {pageTasks.length ? (
                          <div className="detail-history-list">
                            {pageTasks.map((task) => {
                              const isSelected = task.task_id === selectedTaskId;
                              const isLatestTask = task.task_id === latestTaskId;
                              return (
                                <article className={`detail-history-item ${isSelected ? "active" : ""}`} key={task.task_id}>
                                  <button
                                    aria-pressed={isSelected}
                                    className="detail-history-trigger"
                                    type="button"
                                    onClick={() => handleSelectTask(task.task_id)}
                                  >
                                    <div className="detail-history-main">
                                      <div className="detail-history-topline">
                                        <span className={`task-status ${taskStatusClass(task.status)}`}>{taskStatusLabel(task.status)}</span>
                                        {isLatestTask ? <span className="helper-chip">最新任务</span> : null}
                                        {isSelected ? <span className="helper-chip status-success">当前查看</span> : null}
                                        {task.page_number ? <span className="helper-chip">P{task.page_number}</span> : null}
                                      </div>
                                      <strong>{task.title || video.title}</strong>
                                      <small>{formatDateTime(task.created_at)}</small>
                                    </div>
                                    <div className="detail-history-side">
                                      <span className="task-history-id">{task.task_id.slice(0, 8)}</span>
                                    </div>
                                  </button>
                                </article>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="empty-placeholder">当前分 P 还没有可切换的内容版本。</div>
                        )}
                      </article>

                      <article className="detail-task-panel-card detail-task-panel-card-selected">
                        <div className="detail-task-section-head">
                          <div className="detail-task-section-copy">
                            <span className="detail-task-section-kicker">当前查看</span>
                            <h3>查看中的内容版本</h3>
                          </div>
                          {selectedTaskSummary ? (
                            <span className={`helper-chip ${isViewingLatest ? "status-success" : "status-pending"}`}>
                              {isViewingLatest ? "最新版本" : "历史版本"}
                            </span>
                          ) : null}
                        </div>

                        {selectedTaskSummary ? (
                          <>
                            <section className={`detail-history-detail ${isViewingLatest ? "detail-history-detail-live" : ""}`}>
                              <div className="detail-history-detail-head">
                                <div className="detail-history-topline">
                                  <span className={`task-status ${taskStatusClass(selectedTaskSummary.status)}`}>{taskStatusLabel(selectedTaskSummary.status)}</span>
                                  {selectedTaskSummary.task_id === latestTaskId ? <span className="helper-chip">最新任务</span> : null}
                                  <span className="helper-chip status-success">当前查看</span>
                                </div>
                                <span className="task-history-id">{selectedTaskSummary.task_id.slice(0, 8)}</span>
                              </div>
                              <div className="detail-history-detail-copy">
                                <strong>{selectedTaskSummary.title || video.title}</strong>
                                <small>{formatDateTime(selectedTaskSummary.created_at)}</small>
                              </div>
                              <div className="detail-history-metrics">
                                {selectedTaskSnapshot.map((item) => (
                                  <div className="detail-snapshot-metric detail-history-metric" key={item.label}>
                                    <span>{item.label}</span>
                                    <strong>{item.value}</strong>
                                  </div>
                                ))}
                              </div>
                            </section>

                            {isSelectedTaskLoading ? (
                              <div className="detail-inline-note detail-inline-note-pending" role="status">
                                正在加载该版本的详细内容，下方工作台会在同步后切换。
                              </div>
                            ) : null}

                            {selectedTaskLoadError ? (
                              <div className="detail-error-banner" role="status">
                                <strong>版本详情加载失败</strong>
                                <span>{selectedTaskLoadError}</span>
                              </div>
                            ) : null}

                            {selectedTaskDetail?.error_message ? (
                              <div className="detail-error-banner" role="status">
                                <strong>任务错误</strong>
                                <span>{selectedTaskDetail.error_message}</span>
                              </div>
                            ) : null}

                            {!isSelectedTaskLoading && !selectedTaskLoadError ? (
                              <div className="detail-inline-note" role="status">
                                {selectedTaskDetail?.result
                                  ? "该版本的结果已同步到下方工作台。"
                                  : "该版本还没有可用结果，下方工作台会展示对应状态。"}
                              </div>
                            ) : null}

                            <div className="detail-history-actions">
                              <button
                                className="tertiary-button danger"
                                type="button"
                                onClick={async () => {
                                  if (!window.confirm("确定要删除这条任务记录吗？")) {
                                    return;
                                  }
                                  taskContextCacheRef.current.delete(selectedTaskSummary.task_id);
                                  taskContextPromiseRef.current.delete(selectedTaskSummary.task_id);
                                  setTaskContexts((current) => omitRecordKey(current, selectedTaskSummary.task_id));
                                  setTaskContextErrors((current) => omitRecordKey(current, selectedTaskSummary.task_id));
                                  setTaskContextLoading((current) => omitRecordKey(current, selectedTaskSummary.task_id));
                                  await api.deleteTask(selectedTaskSummary.task_id);
                                  await refreshDetail({
                                    preferredTaskId: selectedTaskSummary.task_id === selectedTaskIdRef.current ? null : selectedTaskIdRef.current,
                                    syncLibrary: true,
                                  });
                                }}
                              >
                                删除任务
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="empty-placeholder">选择一个任务版本后，这里会显示该版本的元信息与可用状态。</div>
                        )}
                      </article>
                    </div>
                  </div>
                </section>
              ) : null}
            </div>

            {status ? <div className="submit-status">{status}</div> : null}
          </div>
        </article>

        <section className="video-detail-main">
          <article className="detail-workspace-card">
            <div className="detail-workspace-header">
              <h3 className="detail-workspace-label">Knowledge Workspace</h3>
              <div className="detail-workspace-meta">
                <span className={`detail-workspace-signal ${contentState ? taskStatusClass(selectedTaskStatus) : "status-success"}`}>
                  <span className="detail-workspace-signal-dot" />
                  {workspaceStatusLabel}
                </span>
                {selectedTaskCode ? <span>任务 {selectedTaskCode}</span> : null}
                {selectedTaskTokenCount != null ? <span>{formatTokenCount(selectedTaskTokenCount)} tokens</span> : null}
              </div>
            </div>

            <nav className="detail-tab-row" role="tablist" aria-label="详情工作台视图">
              {detailTabs.map((tab) => (
                <button
                  key={tab.id}
                  className={`detail-tab ${activeTab === tab.id ? "active" : ""}`}
                  role="tab"
                  type="button"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <div className="detail-tab-topline">
                    <DetailTabIcon active={activeTab === tab.id} tab={tab.id} />
                    <span>{tab.label}</span>
                  </div>
                  <small>{tab.description}</small>
                </button>
              ))}
            </nav>

            {activeTab === "knowledge" ? (
              contentState ? (
                <TaskStatePanel state={contentState} />
              ) : (
                <section className="detail-tab-panel">
                  <div className="detail-knowledge-lead">
                    <section className="detail-content-section detail-content-section-overview">
                      <div className="detail-section-heading">
                        <h3 className="detail-section-label">Overview</h3>
                        {overviewCard?.meta ? <span className="detail-section-meta">{overviewCard.meta}</span> : null}
                      </div>
                      <h4 className="detail-section-title">{overviewCard?.title || "核心概览"}</h4>
                      {overviewCard?.content ? <MarkdownContent className="detail-section-body markdown-content-body" compact content={overviewCard.content} /> : <p className="detail-section-body">当前任务还没有生成核心概览。</p>}
                      {bilibiliEmbedUrl ? (
                        <div className="detail-overview-player" ref={playerFrameRef}>
                          <div className="detail-section-heading">
                            <h3 className="detail-section-label">Player</h3>
                            <a className="detail-section-meta detail-section-link" href={currentPage?.source_url || video.source_url} target="_blank" rel="noreferrer">在 Bilibili 打开</a>
                          </div>
                          <div className="detail-video-embed-frame">
                            <iframe
                              allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                              allowFullScreen
                              className="detail-video-embed"
                              referrerPolicy="strict-origin-when-cross-origin"
                              scrolling="no"
                              src={bilibiliEmbedUrl}
                              title={`${video.title} 播放器`}
                            />
                          </div>
                        </div>
                      ) : null}
                    </section>

                    <section className="detail-content-section detail-content-section-keypoints">
                      <div className="detail-section-heading">
                        <h3 className="detail-section-label">Key Points</h3>
                        <span className="detail-section-meta">{keyPointCards.length} 条</span>
                      </div>
                      {keyPointCards.length ? (
                        <div className="detail-point-rail">
                          {keyPointCards.map((card, index) => (
                            <KnowledgeCardBlock card={card} index={index} key={card.id} />
                          ))}
                        </div>
                      ) : (
                        <div className="empty-placeholder">当前任务还没有生成关键要点卡。</div>
                      )}
                    </section>
                  </div>

                  <section className="detail-content-section detail-content-section-last">
                    <div className="detail-section-heading">
                      <h3 className="detail-section-label">Chapters</h3>
                      <span className="detail-section-meta">{chapterCards.length} 条</span>
                    </div>
                    {chapterGroups.length ? (
                        <div className="detail-chapter-groups">
                          {chapterGroups.map((group, groupIndex) => (
                            <details className="detail-chapter-group" key={group.id} open={groupIndex === 0}>
                              <summary className="detail-chapter-group-summary">
                                <div className="detail-chapter-group-copy">
                                  <strong>{group.title}</strong>
                                  <span>{group.meta}</span>
                                </div>
                                <span className="detail-chapter-group-caret" aria-hidden="true">
                                  <IconChevronDown />
                                </span>
                              </summary>
                              <div className="detail-chapter-group-content">
                                <div className="detail-chapter-group-body">
                                  {group.items.map((card, index) => (
                                    <KnowledgeCardBlock
                                      card={card}
                                      index={index}
                                      key={card.id}
                                      onSeekToTimestamp={bilibiliEmbedBaseUrl ? handleSeekToChapter : undefined}
                                    />
                                  ))}
                                </div>
                              </div>
                            </details>
                          ))}
                        </div>
                    ) : (
                      <div className="empty-placeholder">当前任务还没有生成章节知识卡。</div>
                    )}
                  </section>
                </section>
              )
            ) : null}

            {activeTab === "summary" ? (
              contentState ? (
                <TaskStatePanel state={contentState} />
              ) : (
                <section className="detail-tab-panel">
                  <section className="detail-content-section">
                    <div className="detail-section-heading">
                      <h3 className="detail-section-label">Knowledge Note</h3>
                      <span className="detail-section-meta">完整学习视图</span>
                    </div>
                    <h4 className="detail-section-title">知识笔记</h4>
                    {selectedKnowledgeNoteMarkdown ? (
                      <MarkdownContent className="detail-note-markdown" content={selectedKnowledgeNoteMarkdown} />
                    ) : (
                      <p className="detail-section-body">当前任务还没有生成知识笔记。</p>
                    )}
                  </section>

                  <section className="detail-content-section">
                    <div className="detail-section-heading">
                      <h3 className="detail-section-label">Transcript</h3>
                      <span className="detail-section-meta">{selectedTranscript ? "原始转写" : "暂无内容"}</span>
                    </div>
                    <pre className="transcript-full">{selectedTranscript || "暂无转写全文。"}</pre>
                  </section>
                </section>
              )
            ) : null}

            {activeTab === "mindmap" ? (
              <section className="detail-tab-panel">
                <section className="detail-content-section detail-content-section-last">
                  <div className="detail-section-heading">
                    <h3 className="detail-section-label">Mind Map</h3>
                    <span className="detail-section-meta">知识图谱入口</span>
                  </div>
                  <article className={`detail-mindmap-placeholder tone-${mindMapState.tone}`}>
                    <div className="detail-mindmap-copy">
                      <h4 className="detail-section-title">{mindMapState.title}</h4>
                      <p className="detail-section-body">{mindMapState.description}</p>
                    </div>
                    {mindMapState.actionLabel ? (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={!mindMapState.actionEnabled}
                        aria-disabled={!mindMapState.actionEnabled}
                      >
                        {mindMapState.actionLabel}
                      </button>
                    ) : null}
                  </article>
                </section>
              </section>
            ) : null}
          </article>
        </section>
      </div>
    </section>
  );
}

function KnowledgeCardBlock({
  card,
  index,
  onSeekToTimestamp,
}: {
  card: KnowledgeCard;
  index: number;
  onSeekToTimestamp?: (seconds: number | null) => void;
}) {
  if (card.kind === "chapter") {
    const canSeek = typeof card.timestampSeconds === "number" && Boolean(onSeekToTimestamp);
    const chapterCardBody = (
      <div className="detail-chapter-node-shell">
        <span className="detail-chapter-node-dot" aria-hidden="true" />
        <div className="detail-chapter-node-meta">
          <div className="detail-chapter-time">
            <IconClock className="detail-inline-icon" />
            <span>{card.timestampSeconds != null ? formatDuration(card.timestampSeconds) : "--"}</span>
          </div>
        </div>
        <div className="detail-chapter-node-copy">
          <h4>{card.title}</h4>
          <MarkdownContent className="detail-card-markdown" compact content={card.content} />
        </div>
        {canSeek ? (
          <div className="detail-card-link">
            定位片段
            <IconArrowRight className="detail-inline-icon" />
          </div>
        ) : null}
      </div>
    );

    if (canSeek) {
      return (
        <button className="detail-chapter-node detail-chapter-node-action" type="button" onClick={() => onSeekToTimestamp!(card.timestampSeconds ?? null)}>
          {chapterCardBody}
        </button>
      );
    }

    return (
      <article className="detail-chapter-node">
        {chapterCardBody}
      </article>
    );
  }

  return (
    <article className="detail-point-item">
      <div className="detail-point-marker" aria-hidden="true">
        <span>{String(index + 1).padStart(2, "0")}</span>
      </div>
      <div className="detail-point-main">
        {card.title ? (
          <div className="detail-point-card-top">
            <h4>{card.title}</h4>
          </div>
        ) : null}
        <MarkdownContent className="detail-card-markdown" compact content={card.content} />
      </div>
    </article>
  );
}

function TaskStatePanel({ state }: { state: NonNullable<ReturnType<typeof describeTaskContentState>> }) {
  return (
    <section className={`detail-state-panel tone-${state.tone}`} role="status">
      <div className="detail-state-copy">
        <h3 className="detail-section-label">Workspace State</h3>
        <h4 className="detail-section-title">{state.title}</h4>
        <p className="detail-section-body">{state.description}</p>
        {state.detail ? <pre className="detail-state-detail">{state.detail}</pre> : null}
      </div>
    </section>
  );
}

function DetailTabIcon({ active, tab }: { active: boolean; tab: DetailTab }) {
  const className = `detail-tab-icon ${active ? "is-active" : ""}`;
  if (tab === "knowledge") {
    return <IconBrainCircuit className={className} />;
  }
  if (tab === "summary") {
    return <IconFileText className={className} />;
  }
  return <IconShare className={className} />;
}

function IconChevronLeft(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function IconChevronDown(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function IconPlayCircle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8 6 4-6 4z" />
    </svg>
  );
}

function IconClock(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function IconTrash(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

function IconRefresh(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="M20 4v6h-6" />
      <path d="M4 20v-6h6" />
      <path d="M7 17a8 8 0 0 0 13-5" />
      <path d="M17 7A8 8 0 0 0 4 12" />
    </svg>
  );
}

function IconFileText(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h6M9 9h2" />
    </svg>
  );
}

function IconSummaryRefresh(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 9h2M9 13h6" />
      <path d="M9 17a3 3 0 1 0 3-3" />
      <path d="M13.75 15.5H12v-1.75" />
    </svg>
  );
}

function IconTranscriptRefresh(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="M4 12a8 8 0 0 1 13-6" />
      <path d="M20 12a8 8 0 0 1-13 6" />
      <path d="M17 3v5h-5" />
      <path d="M7 21v-5h5" />
      <path d="M9 10.5a3 3 0 0 1 6 0c0 2.2-3 2.2-3 4.5" />
      <path d="M12 18h.01" />
    </svg>
  );
}

function IconSettings(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="M12 3.75a1.5 1.5 0 0 1 1.471 1.206l.167.835a6.954 6.954 0 0 1 1.309.544l.716-.46a1.5 1.5 0 0 1 1.867.195l.8.8a1.5 1.5 0 0 1 .195 1.867l-.46.716c.224.417.406.856.544 1.309l.835.167A1.5 1.5 0 0 1 20.25 12a1.5 1.5 0 0 1-1.206 1.471l-.835.167a6.954 6.954 0 0 1-.544 1.309l.46.716a1.5 1.5 0 0 1-.195 1.867l-.8.8a1.5 1.5 0 0 1-1.867.195l-.716-.46a6.954 6.954 0 0 1-1.309.544l-.167.835A1.5 1.5 0 0 1 12 20.25a1.5 1.5 0 0 1-1.471-1.206l-.167-.835a6.954 6.954 0 0 1-1.309-.544l-.716.46a1.5 1.5 0 0 1-1.867-.195l-.8-.8a1.5 1.5 0 0 1-.195-1.867l.46-.716a6.954 6.954 0 0 1-.544-1.309l-.835-.167A1.5 1.5 0 0 1 3.75 12a1.5 1.5 0 0 1 1.206-1.471l.835-.167c.138-.453.32-.892.544-1.309l-.46-.716a1.5 1.5 0 0 1 .195-1.867l.8-.8a1.5 1.5 0 0 1 1.867-.195l.716.46a6.954 6.954 0 0 1 1.309-.544l.167-.835A1.5 1.5 0 0 1 12 3.75Z" />
      <circle cx="12" cy="12" r="3.25" />
    </svg>
  );
}

function IconShare(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
    </svg>
  );
}

function IconBrainCircuit(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="M12 5a3 3 0 0 0-3 3v1H8a3 3 0 0 0 0 6h1v1a3 3 0 0 0 6 0v-1h1a3 3 0 0 0 0-6h-1V8a3 3 0 0 0-3-3Z" />
      <path d="M12 2v3M12 19v3M4.5 12H8M16 12h3.5" />
    </svg>
  );
}

function IconArrowRight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}
