import "@xyflow/react/dist/style.css";
import { Controls, Handle, Position, ReactFlow, type Edge, type Node as FlowNode, type NodeProps } from "@xyflow/react";
import { toBlob } from "html-to-image";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type SVGProps } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { progressEventClass, stageLabel, taskStatusClass } from "../appModel";
import { api } from "../api";
import { MarkdownContent } from "../components/MarkdownContent";
import { FloatingNoticeStack } from "../components/FloatingNoticeStack";
import {
  buildChapterGroups,
  buildKnowledgeCards,
  describeMindMapWorkspace,
  describeTaskContentState,
  describeUserFacingErrorMessage,
  pickDetailTaskId,
  resolveKnowledgeNoteMarkdown,
  type DetailTab,
  type KnowledgeCard,
  type TaskPanelState,
} from "../detailModel";
import type { MindMapNode, TaskDetail, TaskEvent, TaskMindMapResponse, TaskStatus, TaskSummary, VideoAssetDetail } from "../types";
import { formatDateTime, formatDuration, formatTaskDuration, formatTokenCount, sanitizeMindMapLabel, summarizeEvents, taskStatusLabel } from "../utils";
import { buildPlayerEmbedDescriptor, withPlayerSeek } from "../videoPlayer";

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

type MindMapCanvasNode = {
  node: MindMapNode;
  depth: number;
  branch: "left" | "right" | "center";
  x: number;
  y: number;
  parentId?: string;
  accent: MindMapAccent;
};

type MindMapAccent = {
  stroke: string;
  surface: string;
  ink: string;
  shadow: string;
};

type MindMapFlowNodeData = {
  label: string;
  summary: string;
  tone: "root" | "theme" | "topic" | "leaf";
  branch: "left" | "right" | "center";
  selected: boolean;
  muted: boolean;
  timeAnchor?: number | null;
  sourceChapterTitles: string[];
  sourceChapterStarts: number[];
  accent: MindMapAccent;
};

type FloatingPlayerLayout = {
  width: number;
  x: number;
  y: number;
};

const MINDMAP_ROOT_ACCENT: MindMapAccent = {
  stroke: "#4c9fdd",
  surface: "rgba(76, 159, 221, 0.18)",
  ink: "#104f7d",
  shadow: "rgba(76, 159, 221, 0.24)",
};

const MINDMAP_BRANCH_ACCENTS: MindMapAccent[] = [
  { stroke: "#f2b84b", surface: "rgba(242, 184, 75, 0.18)", ink: "#805018", shadow: "rgba(242, 184, 75, 0.24)" },
  { stroke: "#ff8c69", surface: "rgba(255, 140, 105, 0.16)", ink: "#91412a", shadow: "rgba(255, 140, 105, 0.24)" },
  { stroke: "#8cc8ff", surface: "rgba(140, 200, 255, 0.18)", ink: "#285c86", shadow: "rgba(140, 200, 255, 0.24)" },
  { stroke: "#f5a64a", surface: "rgba(245, 166, 74, 0.16)", ink: "#8a4a00", shadow: "rgba(245, 166, 74, 0.22)" },
  { stroke: "#9dd8b3", surface: "rgba(157, 216, 179, 0.18)", ink: "#1f6a47", shadow: "rgba(157, 216, 179, 0.22)" },
  { stroke: "#f7a8c2", surface: "rgba(247, 168, 194, 0.16)", ink: "#8e4563", shadow: "rgba(247, 168, 194, 0.22)" },
];

const FLOATING_PLAYER_ASPECT_RATIO = 16 / 9;
const FLOATING_PLAYER_MIN_WIDTH = 220;
const FLOATING_PLAYER_DEFAULT_WIDTH = 360;
const FLOATING_PLAYER_VIEWPORT_MARGIN = 20;
const FLOATING_PLAYER_TOP_OFFSET = 92;
const FLOATING_PLAYER_CHROME_HEIGHT = 62;

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

function clampFloatingPlayerWidth(width: number, viewportWidth: number) {
  const maxWidth = Math.max(FLOATING_PLAYER_MIN_WIDTH, viewportWidth - FLOATING_PLAYER_VIEWPORT_MARGIN * 2);
  return Math.min(Math.max(width, FLOATING_PLAYER_MIN_WIDTH), maxWidth);
}

function clampFloatingPlayerLayout(layout: FloatingPlayerLayout, viewportWidth: number, viewportHeight: number): FloatingPlayerLayout {
  const width = clampFloatingPlayerWidth(layout.width, viewportWidth);
  const height = width / FLOATING_PLAYER_ASPECT_RATIO + FLOATING_PLAYER_CHROME_HEIGHT;
  const maxX = Math.max(FLOATING_PLAYER_VIEWPORT_MARGIN, viewportWidth - width - FLOATING_PLAYER_VIEWPORT_MARGIN);
  const maxY = Math.max(FLOATING_PLAYER_TOP_OFFSET, viewportHeight - height - FLOATING_PLAYER_VIEWPORT_MARGIN);
  return {
    width,
    x: Math.min(Math.max(layout.x, FLOATING_PLAYER_VIEWPORT_MARGIN), maxX),
    y: Math.min(Math.max(layout.y, FLOATING_PLAYER_TOP_OFFSET), maxY),
  };
}

function createDefaultFloatingPlayerLayout(viewportWidth: number, viewportHeight: number): FloatingPlayerLayout {
  const width = clampFloatingPlayerWidth(FLOATING_PLAYER_DEFAULT_WIDTH, viewportWidth);
  const height = width / FLOATING_PLAYER_ASPECT_RATIO + FLOATING_PLAYER_CHROME_HEIGHT;
  return {
    width,
    x: Math.max(FLOATING_PLAYER_VIEWPORT_MARGIN, viewportWidth - width - 28),
    y: Math.max(FLOATING_PLAYER_TOP_OFFSET, viewportHeight - height - 28),
  };
}

function omitRecordKey<T>(record: Record<string, T>, key: string) {
  if (!(key in record)) {
    return record;
  }
  const nextRecord = { ...record };
  delete nextRecord[key];
  return nextRecord;
}

function shouldDisplayMindMapTimestamp(seconds?: number | null) {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
}

async function loadTaskContext(taskId: string): Promise<TaskContext> {
  const [detail, events] = await Promise.all([api.getTaskResult(taskId), api.getTaskEvents(taskId)]);
  return { detail, events };
}

function IconFavorite(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="currentColor" viewBox="0 0 24 24" {...props}>
      <path d="M12 18.26 4.95 22l1.35-7.84L.6 8.71l7.87-1.14L12 0.5l3.53 7.07 7.87 1.14-5.7 5.45L19.05 22z" />
    </svg>
  );
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
  const [mindMaps, setMindMaps] = useState<Record<string, TaskMindMapResponse>>({});
  const [mindMapLoading, setMindMapLoading] = useState<Record<string, boolean>>({});
  const [isExportingKnowledgeCard, setIsExportingKnowledgeCard] = useState(false);
  const [expandedChapterGroupIds, setExpandedChapterGroupIds] = useState<string[]>([]);
  const [selectedPageNumber, setSelectedPageNumber] = useState<number | null>(null);
  const [playerSeekTarget, setPlayerSeekTarget] = useState<PlayerSeekTarget>({ nonce: 0, seconds: null });
  const [selectedMindMapNodeId, setSelectedMindMapNodeId] = useState<string | null>(null);
  const lastAutoRefreshEventRef = useRef<string | null>(null);
  const taskPopoverRef = useRef<HTMLDivElement | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const playerFrameRef = useRef<HTMLDivElement | null>(null);
  const knowledgeExportRef = useRef<HTMLElement | null>(null);
  const lastChapterGroupSignatureRef = useRef("");
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

  async function loadMindMap(taskId: string, options: { force?: boolean } = {}) {
    if (!options.force && mindMaps[taskId]) {
      return mindMaps[taskId];
    }
    setMindMapLoading((current) => ({ ...current, [taskId]: true }));
    try {
      const response = await api.getTaskMindMap(taskId);
      setMindMaps((current) => ({ ...current, [taskId]: response }));
      return response;
    } catch (error) {
      const failedState: TaskMindMapResponse = {
        task_id: taskId,
        status: "failed",
        error_message: error instanceof Error ? error.message : "思维导图加载失败",
        updated_at: null,
        mindmap: null,
      };
      setMindMaps((current) => ({ ...current, [taskId]: failedState }));
      throw error;
    } finally {
      setMindMapLoading((current) => omitRecordKey(current, taskId));
    }
  }

  async function triggerMindMapGeneration(taskId: string, options: { force?: boolean } = {}) {
    setMindMapLoading((current) => ({ ...current, [taskId]: true }));
    try {
      const response = await api.generateTaskMindMap(taskId, { force: options.force });
      setMindMaps((current) => ({ ...current, [taskId]: response }));
      return response;
    } catch (error) {
      const failedState: TaskMindMapResponse = {
        task_id: taskId,
        status: "failed",
        error_message: error instanceof Error ? error.message : "思维导图生成失败",
        updated_at: null,
        mindmap: null,
      };
      setMindMaps((current) => ({ ...current, [taskId]: failedState }));
      throw error;
    } finally {
      setMindMapLoading((current) => omitRecordKey(current, taskId));
    }
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
    setMindMaps({});
    setMindMapLoading({});
    setSelectedPageNumber(null);
    setSelectedMindMapNodeId(null);
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
  const selectedTaskEvents = selectedTaskContext?.events ?? [];
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
    if (!selectedTaskId || activeTab !== "mindmap") {
      return;
    }
    void loadMindMap(selectedTaskId).catch(() => undefined);
  }, [activeTab, selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId) {
      return;
    }
    const currentMindMap = mindMaps[selectedTaskId];
    const isGenerating = currentMindMap?.status === "generating" || selectedTaskDetail?.result?.mindmap_status === "generating";
    if (!isGenerating) {
      return;
    }
    const timer = window.setInterval(() => {
      void Promise.all([
        loadMindMap(selectedTaskId, { force: true }),
        ensureTaskContext(selectedTaskId, { force: true }),
      ]).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [mindMaps, selectedTaskDetail?.result?.mindmap_status, selectedTaskId]);

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
      event.stage === "completed"
      || event.stage === "failed"
      || event.stage === "cancelled"
      || event.stage === "mindmap_completed"
      || event.stage === "mindmap_failed"
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

  async function handleCopyKnowledgeCardAsImage() {
    if (!knowledgeExportRef.current || isExportingKnowledgeCard) {
      return;
    }

    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      setStatus("当前环境不支持将图片复制到剪贴板。");
      return;
    }

    const exportTarget = knowledgeExportRef.current;
    const previousStatus = status;
    const computedStyle = window.getComputedStyle(exportTarget);
    const backgroundColor = computedStyle.backgroundColor === "rgba(0, 0, 0, 0)" ? window.getComputedStyle(document.body).backgroundColor : computedStyle.backgroundColor;

    setIsExportingKnowledgeCard(true);
    setStatus("正在导出当前知识卡片...");
    exportTarget.setAttribute("data-export-mode", "true");

    try {
      await document.fonts.ready;
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));

      const blob = await toBlob(exportTarget, {
        backgroundColor,
        cacheBust: true,
        pixelRatio: Math.max(window.devicePixelRatio || 1, 2),
      });

      if (!blob) {
        throw new Error("未能生成图片，请稍后重试。");
      }

      if (window.desktop?.clipboard) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            if (typeof reader.result === "string") {
              resolve(reader.result);
              return;
            }
            reject(new Error("图片编码失败，请稍后重试。"));
          };
          reader.onerror = () => reject(reader.error ?? new Error("图片编码失败，请稍后重试。"));
          reader.readAsDataURL(blob);
        });
        await window.desktop.clipboard.writeImage(dataUrl);
      } else {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      }
      setStatus("当前知识卡片已复制为图片。");
    } catch (error) {
      if (error instanceof Error && error.message.includes("Document is not focused")) {
        setStatus("复制失败：请先点一下应用窗口，再重新尝试。");
      } else {
        setStatus(error instanceof Error ? error.message : "导出图片失败，请稍后重试。");
      }
    } finally {
      exportTarget.removeAttribute("data-export-mode");
      setIsExportingKnowledgeCard(false);
      window.setTimeout(() => {
        setStatus((current) => (current === "当前知识卡片已复制为图片。" || current === "正在导出当前知识卡片..." ? previousStatus : current));
      }, 2600);
    }
  }

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
        detail: describeUserFacingErrorMessage(selectedTaskLoadError),
      } as const;
    }
    return describeTaskContentState(selectedTaskDetail);
  }, [isSelectedTaskLoading, selectedTaskDetail, selectedTaskLoadError]);
  const selectedMindMap = useMemo(() => {
    const current = selectedTaskId ? mindMaps[selectedTaskId] ?? null : null;
    if (current?.status === "ready" && (!current.mindmap || !current.mindmap.nodes?.length)) {
      return {
        ...current,
        status: "failed" as const,
        error_message: current.error_message || "思维导图数据为空，请重新生成。",
        mindmap: null,
      };
    }
    return current;
  }, [mindMaps, selectedTaskId]);
  const mindMapState = useMemo(() => {
    if (isSelectedTaskLoading) {
      return {
        tone: "pending",
        title: "思维导图将在版本载入后可用",
        description: "当前正在同步所选内容版本的详细结果。",
        actionLabel: "加载中",
        actionEnabled: false,
      } as const;
    }
    if (selectedTaskLoadError) {
      return {
        tone: "failed",
        title: "当前版本暂时无法打开思维导图",
        description: describeUserFacingErrorMessage(selectedTaskLoadError),
        actionLabel: "稍后重试",
        actionEnabled: false,
      } as const;
    }
    return describeMindMapWorkspace(selectedTaskDetail, selectedMindMap);
  }, [isSelectedTaskLoading, selectedMindMap, selectedTaskDetail, selectedTaskLoadError]);
  const knowledgeCards = useMemo(() => buildKnowledgeCards(selectedResult), [selectedResult]);
  const overviewCard = knowledgeCards.find((item) => item.kind === "overview") ?? null;
  const keyPointCards = knowledgeCards.filter((item) => item.kind === "key-point");
  const chapterCards = knowledgeCards.filter((item) => item.kind === "chapter");
  const chapterGroups = useMemo(() => buildChapterGroups(chapterCards, selectedResult), [chapterCards, selectedResult]);
  const areAllChapterGroupsExpanded = chapterGroups.length > 0 && expandedChapterGroupIds.length === chapterGroups.length;
  const selectedKnowledgeNoteMarkdown = useMemo(() => resolveKnowledgeNoteMarkdown(selectedResult), [selectedResult]);
  const selectedTranscript = selectedResult?.transcript_text ?? "";
  const liveStatus = latestTaskDetail?.status ?? latestTaskSummary?.status ?? video?.latest_status;
  const liveMessage = latestTaskLoadError
    ?? describeUserFacingErrorMessage(liveProgress.failedEvent?.message)
    ?? liveProgress.currentEvent?.message
    ?? describeUserFacingErrorMessage(latestTaskDetail?.error_message)
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
  const playerDescriptor = useMemo(
    () => buildPlayerEmbedDescriptor(currentPage?.source_url || video?.source_url),
    [currentPage?.source_url, video?.source_url],
  );
  const playerEmbedUrl = useMemo(() => {
    if (!playerDescriptor) {
      return null;
    }
    return withPlayerSeek(playerDescriptor.embedUrl, playerDescriptor.platform, playerSeekTarget.seconds, playerSeekTarget.nonce);
  }, [playerDescriptor, playerSeekTarget]);
  const readyMindMap = selectedMindMap?.status === "ready" && selectedTaskDetail?.result?.mindmap_status !== "generating"
    ? selectedMindMap.mindmap ?? null
    : null;
  const mindMapEvents = useMemo(
    () => selectedTaskEvents.filter((event) => event.stage.startsWith("mindmap_")),
    [selectedTaskEvents],
  );
  const mindMapProgress = useMemo(() => {
    if (!selectedTaskId) {
      return null;
    }

    const generating = selectedMindMap?.status === "generating" || selectedTaskDetail?.result?.mindmap_status === "generating";
    const loading = Boolean(mindMapLoading[selectedTaskId]);
    const summarized = mindMapEvents.length ? summarizeEvents(mindMapEvents) : null;
    if (!generating && !loading && !summarized?.filtered.length) {
      return null;
    }

    return {
      progress: Math.max(0, Math.min(100, Math.round(summarized?.progress ?? (loading ? 6 : 90)))),
      currentLabel: summarized?.currentEvent?.stage ? stageLabel(summarized.currentEvent.stage) : (loading ? "提交生成请求" : "等待阶段回传"),
      message: selectedMindMap?.error_message
        || selectedTaskDetail?.result?.mindmap_error_message
        || summarized?.failedEvent?.message
        || summarized?.currentEvent?.message
        || (loading ? "正在向本地服务提交导图生成请求。" : "系统正在生成思维导图，阶段完成后会自动刷新。"),
      events: summarized?.filtered ?? [],
      hasError: Boolean(summarized?.failedEvent),
    };
  }, [mindMapEvents, mindMapLoading, selectedMindMap, selectedTaskDetail?.result?.mindmap_error_message, selectedTaskDetail?.result?.mindmap_status, selectedTaskId]);
  const mindMapMeta = readyMindMap
    ? "主题导图视图"
    : mindMapProgress
      ? `${mindMapProgress.currentLabel} · ${mindMapProgress.progress}%`
      : "按需生成";
  const readyMindMapRoot = useMemo(() => {
    if (!readyMindMap) {
      return null;
    }
    return readyMindMap.nodes.find((node) => node.id === readyMindMap.root) ?? readyMindMap.nodes[0] ?? null;
  }, [readyMindMap]);
  const mindMapFlow = useMemo(
    () => (readyMindMapRoot ? buildMindMapFlow(readyMindMapRoot, selectedMindMapNodeId) : { nodes: [], edges: [] }),
    [readyMindMapRoot, selectedMindMapNodeId],
  );
  const selectedMindMapNode = useMemo(() => {
    if (!readyMindMapRoot || !selectedMindMapNodeId) {
      return null;
    }
    return findMindMapNodeById(readyMindMapRoot, selectedMindMapNodeId);
  }, [readyMindMapRoot, selectedMindMapNodeId]);

  useEffect(() => {
    const chapterGroupSignature = chapterGroups.map((group) => group.id).join("|");
    const chapterGroupsChanged = lastChapterGroupSignatureRef.current !== chapterGroupSignature;
    lastChapterGroupSignatureRef.current = chapterGroupSignature;

    setExpandedChapterGroupIds((current) => {
      const visibleGroupIds = new Set(chapterGroups.map((group) => group.id));
      const nextExpanded = current.filter((groupId) => visibleGroupIds.has(groupId));
      const hasSameExpandedIds = nextExpanded.length === current.length
        && nextExpanded.every((groupId, index) => groupId === current[index]);

      if (chapterGroups.length === 0) {
        return nextExpanded.length ? [] : current;
      }
      if (nextExpanded.length > 0 || !chapterGroupsChanged) {
        return hasSameExpandedIds ? current : nextExpanded;
      }
      return [chapterGroups[0].id];
    });
  }, [chapterGroups]);

  useEffect(() => {
    if (!readyMindMapRoot) {
      setSelectedMindMapNodeId(null);
      return;
    }
    setSelectedMindMapNodeId((current) => (current && findMindMapNodeById(readyMindMapRoot, current) ? current : null));
  }, [readyMindMapRoot]);

  function handleSeekToChapter(seconds: number | null) {
    if (!playerDescriptor || seconds == null) {
      return;
    }
    setPlayerSeekTarget((current) => ({ nonce: current.nonce + 1, seconds }));
    if (activeTab === "knowledge") {
      playerFrameRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function handleToggleAllChapterGroups() {
    setExpandedChapterGroupIds(areAllChapterGroupsExpanded ? [] : chapterGroups.map((group) => group.id));
  }

  function handleToggleChapterGroup(groupId: string, open: boolean) {
    setExpandedChapterGroupIds((current) => {
      if (open) {
        return current.includes(groupId) ? current : [...current, groupId];
      }
      return current.filter((item) => item !== groupId);
    });
  }

  async function handleGenerateMindMap(force = false) {
    if (!selectedTaskId) {
      return;
    }
    setActiveTab("mindmap");
    setStatus(force ? "已发起重新生成思维导图..." : "已发起生成思维导图...");
    try {
      const response = await triggerMindMapGeneration(selectedTaskId, { force });
      if (response.status === "ready") {
        setSelectedMindMapNodeId(null);
        setStatus("思维导图已更新");
        return;
      }
      setStatus(force ? "正在重新生成思维导图..." : "正在生成思维导图...");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "思维导图生成失败");
    }
  }

  async function handleToggleFavorite() {
    if (!video) {
      return;
    }
    const previousVideo = video;
    const nextFavorite = !video.is_favorite;
    setVideo({
      ...video,
      is_favorite: nextFavorite,
      favorite_updated_at: nextFavorite ? new Date().toISOString() : null,
    });
    try {
      const updated = await api.setVideoFavorite(video.video_id, { is_favorite: nextFavorite });
      setVideo(updated);
      onRefresh();
      setStatus(nextFavorite ? "已加入收藏" : "已取消收藏");
    } catch (error) {
      setVideo(previousVideo);
      setStatus(error instanceof Error ? error.message : "更新收藏状态失败");
    }
  }

  if (!video) {
    return <section className="grid-card empty-state-card">正在加载视频详情...</section>;
  }

  const heroSourceTarget = currentPage?.source_url || video.source_url;
  const isLocalVideo = String(video.platform || "").toLowerCase() === "local";
  const canOpenLocalSource = isLocalVideo && Boolean(window.desktop?.shell) && Boolean(heroSourceTarget);

  async function handleOpenLocalSource() {
    if (!window.desktop?.shell || !heroSourceTarget) {
      return;
    }
    const result = await window.desktop.shell.openPath(heroSourceTarget);
    if (result) {
      throw new Error(result);
    }
  }

  return (
    <section className="video-detail-page">
      <FloatingNoticeStack notices={[{ id: "video-detail-status", message: status }]} />
      <div className="detail-page-shell">
        <div className="detail-page-toolbar">
          <Link className="detail-back-button" to="/library">
            <IconChevronLeft className="detail-back-icon" />
            返回视频库
          </Link>
        </div>

        <article className="video-detail-hero">
          {canOpenLocalSource ? (
            <button
              className="video-detail-cover video-detail-cover-button"
              type="button"
              onClick={() => void handleOpenLocalSource().catch((error) => {
                setStatus(error instanceof Error ? error.message : "打开本地视频失败");
              })}
            >
              {video.cover_url ? <img src={video.cover_url} alt={video.title} loading="lazy" /> : <div className="video-detail-cover-placeholder">VIDEO</div>}
              <div className="video-detail-cover-overlay">
                <IconPlayCircle className="video-detail-play-icon" />
              </div>
              <div className="detail-duration-badge">{formatDuration(video.duration)}</div>
            </button>
          ) : isLocalVideo ? (
            <div className="video-detail-cover">
              {video.cover_url ? <img src={video.cover_url} alt={video.title} loading="lazy" /> : <div className="video-detail-cover-placeholder">VIDEO</div>}
              <div className="detail-duration-badge">{formatDuration(video.duration)}</div>
            </div>
          ) : (
            <a className="video-detail-cover" href={heroSourceTarget} target="_blank" rel="noreferrer">
              {video.cover_url ? <img src={video.cover_url} alt={video.title} loading="lazy" /> : <div className="video-detail-cover-placeholder">VIDEO</div>}
              <div className="video-detail-cover-overlay">
                <IconPlayCircle className="video-detail-play-icon" />
              </div>
              <div className="detail-duration-badge">{formatDuration(video.duration)}</div>
            </a>
          )}

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
                  <button
                    aria-label={video.is_favorite ? "取消收藏" : "收藏视频"}
                    className={`detail-action-button secondary detail-action-button-compact detail-action-button-favorite ${video.is_favorite ? "is-active" : ""}`}
                    title={video.is_favorite ? "取消收藏" : "收藏视频"}
                    type="button"
                    onClick={() => void handleToggleFavorite()}
                  >
                    <IconFavorite className="detail-action-icon" />
                  </button>
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
                          disabled={!selectedTaskId || selectedTaskStatus !== "completed" || Boolean(selectedTaskId && mindMapLoading[selectedTaskId])}
                          onClick={async () => {
                            setActionMenuOpen(false);
                            await handleGenerateMindMap(true);
                          }}
                        >
                          <span className="detail-action-menu-item-icon" aria-hidden="true">
                            <IconBrainCircuit className="detail-action-icon" />
                          </span>
                          <span className="detail-action-menu-copy">
                            <strong>重新生成思维导图</strong>
                            <small>基于当前查看版本的摘要与知识笔记，重新调用 LLM 生成新的思维导图。</small>
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
                                <span>{describeUserFacingErrorMessage(selectedTaskLoadError)}</span>
                              </div>
                            ) : null}

                            {selectedTaskDetail?.error_message ? (
                              <div className="detail-error-banner" role="status">
                                <strong>任务错误</strong>
                                <span>{describeUserFacingErrorMessage(selectedTaskDetail.error_message)}</span>
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
                <section className="detail-tab-panel detail-export-target" ref={knowledgeExportRef}>
                  <div className="detail-knowledge-lead">
                    <section className="detail-content-section detail-content-section-overview">
                      <div className="detail-section-heading">
                        <div className="detail-section-heading-main">
                          <h3 className="detail-section-label">Overview</h3>
                          {overviewCard?.meta ? <span className="detail-section-meta">{overviewCard.meta}</span> : null}
                        </div>
                        <button
                          className="detail-section-icon-button"
                          type="button"
                          onClick={handleCopyKnowledgeCardAsImage}
                          disabled={isExportingKnowledgeCard}
                          aria-label={isExportingKnowledgeCard ? "正在导出知识卡片图片" : "复制当前知识卡片为图片"}
                          title={isExportingKnowledgeCard ? "正在导出知识卡片图片" : "复制当前知识卡片为图片"}
                        >
                          <IconCopyImage />
                        </button>
                      </div>
                      <h4 className="detail-section-title">{overviewCard?.title || "核心概览"}</h4>
                      {overviewCard?.content ? <MarkdownContent className="detail-section-body markdown-content-body" compact content={overviewCard.content} /> : <p className="detail-section-body">当前任务还没有生成核心概览。</p>}
                      {playerEmbedUrl && playerDescriptor ? (
                        <div className="detail-overview-player" ref={playerFrameRef}>
                          <div className="detail-section-heading">
                            <h3 className="detail-section-label">Player</h3>
                            <a className="detail-section-meta detail-section-link" href={playerDescriptor.sourceUrl} target="_blank" rel="noreferrer">{playerDescriptor.openLabel}</a>
                          </div>
                          <div className="detail-video-embed-frame">
                            <iframe
                              allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                              allowFullScreen
                              className="detail-video-embed"
                              referrerPolicy="strict-origin-when-cross-origin"
                              scrolling="no"
                              src={playerEmbedUrl}
                              title={`${video.title} 播放器`}
                            />
                            <div className="detail-video-export-mask" aria-hidden="true">
                              {video.cover_url ? (
                                <img className="detail-video-export-cover" src={video.cover_url} alt="" />
                              ) : (
                                <div className="detail-video-export-mask-copy">
                                  <strong>{video.title}</strong>
                                  <span>播放器画面无法直接导出，已保留当前卡片内容与视频入口。</span>
                                </div>
                              )}
                            </div>
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
                      <div className="detail-section-heading-actions">
                        {chapterGroups.length ? (
                          <button
                            className="detail-section-text-action"
                            type="button"
                            onClick={handleToggleAllChapterGroups}
                          >
                            {areAllChapterGroupsExpanded ? "一键收起" : "一键展开"}
                          </button>
                        ) : null}
                        <span className="detail-section-meta">{chapterCards.length} 条</span>
                      </div>
                    </div>
                    {chapterGroups.length ? (
                        <div className="detail-chapter-groups">
                          {chapterGroups.map((group) => {
                            const isOpen = expandedChapterGroupIds.includes(group.id);
                            return (
                            <div
                              className={`detail-chapter-group ${isOpen ? "is-open" : ""}`}
                              key={group.id}
                            >
                              <button
                                className="detail-chapter-group-summary"
                                type="button"
                                aria-expanded={isOpen}
                                onClick={() => handleToggleChapterGroup(group.id, !isOpen)}
                              >
                                <div className="detail-chapter-group-copy">
                                  <strong>{group.title}</strong>
                                  <span>{group.meta}</span>
                                </div>
                                <span className="detail-chapter-group-caret" aria-hidden="true">
                                  <IconChevronDown />
                                </span>
                              </button>
                              <div className="detail-chapter-group-content">
                                <div className="detail-chapter-group-body">
                                  {group.items.map((card, index) => (
                                    <KnowledgeCardBlock
                                      card={card}
                                      index={index}
                                      key={card.id}
                                      onSeekToTimestamp={playerDescriptor ? handleSeekToChapter : undefined}
                                    />
                                  ))}
                                </div>
                              </div>
                            </div>
                          )})}
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
                    <div className="detail-section-heading-actions">
                      <span className="detail-section-meta">{mindMapMeta}</span>
                    </div>
                  </div>
                  {readyMindMap ? (
                    <div className="detail-mindmap-workspace">
                      <div className="detail-mindmap-canvas" role="tree" aria-label="思维导图">
                        <div className="detail-mindmap-flow-shell">
                          <ReactFlow
                            key={`${readyMindMap.root}-${readyMindMap.nodes.length}`}
                            nodes={mindMapFlow.nodes}
                            edges={mindMapFlow.edges}
                            fitView
                            fitViewOptions={{ padding: 0.24 }}
                            minZoom={0.38}
                            maxZoom={1.6}
                            nodeTypes={mindMapNodeTypes}
                            nodesDraggable={false}
                            nodesConnectable={false}
                            elementsSelectable
                            proOptions={{ hideAttribution: true }}
                            onNodeClick={(_, node) => setSelectedMindMapNodeId(node.id)}
                            onPaneClick={() => setSelectedMindMapNodeId(null)}
                          >
                            <Controls showInteractive={false} />
                          </ReactFlow>
                        </div>
                      </div>
                      <div className="detail-mindmap-inspector">
                        {selectedMindMapNode ? (
                          <article className="detail-mindmap-inspector-card">
                            <div className="detail-mindmap-inspector-head">
                              <div>
                                <span className="detail-mindmap-inspector-kicker">{formatMindMapNodeType(selectedMindMapNode.type)}</span>
                                <h4>{sanitizeMindMapLabel(selectedMindMapNode.label, selectedMindMapNode.summary)}</h4>
                              </div>
                              {shouldDisplayMindMapTimestamp(selectedMindMapNode.time_anchor) && playerDescriptor ? (
                                <button
                                  className="detail-mindmap-seek-button"
                                  type="button"
                                  onClick={() => handleSeekToChapter(selectedMindMapNode.time_anchor ?? null)}
                                >
                                  <IconArrowRight className="detail-mindmap-seek-icon" />
                                  定位到片段 {formatDuration(selectedMindMapNode.time_anchor)}
                                </button>
                              ) : null}
                            </div>
                            {selectedMindMapNode.summary ? (
                              <MarkdownContent className="detail-mindmap-summary-markdown" compact content={selectedMindMapNode.summary} />
                            ) : null}
                            {selectedMindMapNode.source_chapter_titles.length ? (
                              <div className="detail-mindmap-inspector-tags">
                                {selectedMindMapNode.source_chapter_titles.slice(0, 3).map((title: string, index: number) => {
                                  const timestamp = selectedMindMapNode.source_chapter_starts[index] ?? null;
                                  const canSeek = shouldDisplayMindMapTimestamp(timestamp) && Boolean(playerDescriptor);
                                  const label = `${title}${shouldDisplayMindMapTimestamp(timestamp) ? ` · ${formatDuration(timestamp!)}` : ""}`;

                                  if (canSeek) {
                                    return (
                                      <button
                                        className="detail-mindmap-inspector-tag is-action"
                                        key={`${title}-${index}`}
                                        type="button"
                                        onClick={() => handleSeekToChapter(timestamp)}
                                      >
                                        {label}
                                      </button>
                                    );
                                  }

                                  return (
                                    <span className="detail-mindmap-inspector-tag" key={`${title}-${index}`}>
                                      {label}
                                    </span>
                                  );
                                })}
                              </div>
                            ) : null}
                          </article>
                        ) : (
                          <div className="detail-mindmap-inspector-hint">
                            <strong>点击节点查看摘要与来源片段</strong>
                            <span>主干只保留结构和标签，避免把导图重新变成一块块内容卡片。</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : mindMapState ? (
                    <article className={`detail-mindmap-placeholder tone-${mindMapState.tone}`}>
                      <div className="detail-mindmap-copy">
                        <h4 className="detail-section-title">{mindMapState.title}</h4>
                        <p className="detail-section-body">{mindMapState.description}</p>
                        {mindMapProgress ? (
                          <div className="detail-mindmap-progress">
                            <div className="progress-bar-wrapper">
                              <div
                                className="progress-bar-simple"
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={mindMapProgress.progress}
                                aria-label="思维导图生成进度"
                              >
                                <div
                                  className={`progress-fill-simple ${mindMapProgress.hasError ? "error" : mindMapProgress.progress >= 100 ? "success" : ""}`}
                                  style={{ width: `${mindMapProgress.progress}%` }}
                                />
                              </div>
                              <div className="progress-info-simple">
                                <span className="progress-percent-simple">{mindMapProgress.progress}%</span>
                                <span className="progress-status-simple">{mindMapProgress.message}</span>
                              </div>
                            </div>
                            {mindMapProgress.events.length ? (
                              <details className="progress-stage-card">
                                <summary>
                                  <strong>{mindMapProgress.currentLabel}</strong>
                                  <span className="progress-stage-toggle">查看导图进度</span>
                                </summary>
                                <div className="progress-stage-list">
                                  {mindMapProgress.events.map((event) => (
                                    <article className={`progress-event-card ${progressEventClass(event.stage)}`} key={event.event_id}>
                                      <div className="progress-event-index">{stageLabel(event.stage)}</div>
                                      <div className="progress-event-copy">
                                        <div className="progress-event-topline">
                                          <strong>{event.message}</strong>
                                          <time>{formatDateTime(event.created_at)}</time>
                                        </div>
                                        <div className="progress-event-meta">阶段进度 {event.progress}%</div>
                                      </div>
                                    </article>
                                  ))}
                                </div>
                              </details>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      {mindMapState.actionLabel ? (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={!mindMapState.actionEnabled || Boolean(selectedTaskId && mindMapLoading[selectedTaskId])}
                          aria-disabled={!mindMapState.actionEnabled || Boolean(selectedTaskId && mindMapLoading[selectedTaskId])}
                          onClick={() => handleGenerateMindMap(mindMapState.tone === "failed")}
                        >
                          {selectedTaskId && mindMapLoading[selectedTaskId] ? "处理中..." : mindMapState.actionLabel}
                        </button>
                      ) : null}
                    </article>
                  ) : null}
                </section>
              </section>
            ) : null}

            {playerEmbedUrl && playerDescriptor && activeTab === "mindmap" ? (
              <FloatingVideoPlayer
                embedUrl={playerEmbedUrl}
                openLabel={playerDescriptor.openLabel}
                sourceUrl={playerDescriptor.sourceUrl}
                title={video.title}
              />
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

function findMindMapNodeById(root: MindMapNode, nodeId: string): MindMapNode | null {
  if (root.id === nodeId) {
    return root;
  }
  for (const child of root.children) {
    const match = findMindMapNodeById(child, nodeId);
    if (match) {
      return match;
    }
  }
  return null;
}

function formatMindMapNodeType(type: MindMapNode["type"]): string {
  switch (type) {
    case "root":
      return "中心主题";
    case "theme":
      return "一级主题";
    case "topic":
      return "子主题";
    case "leaf":
      return "知识点";
    default:
      return "节点";
  }
}

function measureMindMapSpan(node: MindMapNode, depth = 0): number {
  const minimum = depth === 0 ? 132 : node.type === "theme" ? 88 : node.type === "topic" ? 66 : 56;
  if (!node.children.length) {
    return minimum;
  }
  const childGap = depth === 0 ? 58 : depth === 1 ? 30 : 18;
  const childrenSpan = node.children.reduce((sum, child) => sum + measureMindMapSpan(child, depth + 1), 0) + childGap * (node.children.length - 1);
  return Math.max(minimum, childrenSpan);
}

function getMindMapHorizontalOffset(parentDepth: number, child: MindMapNode): number {
  if (parentDepth === 0) {
    return 112;
  }
  if (parentDepth === 1) {
    return child.type === "leaf" ? 78 : 94;
  }
  return child.type === "leaf" ? 54 : 68;
}

function getMindMapNodeSize(node: MindMapNode): { width: number; height: number } {
  switch (node.type) {
    case "root":
      return { width: 252, height: 112 };
    case "theme":
      return { width: 208, height: 44 };
    case "topic":
      return { width: 212, height: 40 };
    case "leaf":
      return { width: 232, height: 52 };
    default:
      return { width: 200, height: 48 };
  }
}

function getMindMapFocusIds(positioned: MindMapCanvasNode[], selectedNodeId: string | null): Set<string> | null {
  if (!selectedNodeId) {
    return null;
  }

  const parentById = new Map<string, string>();
  const childrenById = new Map<string, string[]>();

  positioned.forEach((item) => {
    if (!item.parentId) {
      return;
    }
    parentById.set(item.node.id, item.parentId);
    childrenById.set(item.parentId, [...(childrenById.get(item.parentId) ?? []), item.node.id]);
  });

  const focusIds = new Set<string>([selectedNodeId]);
  let currentId = selectedNodeId;
  while (parentById.has(currentId)) {
    currentId = parentById.get(currentId)!;
    focusIds.add(currentId);
  }

  const stack = [selectedNodeId];
  while (stack.length) {
    const nodeId = stack.pop()!;
    const children = childrenById.get(nodeId) ?? [];
    children.forEach((childId) => {
      if (!focusIds.has(childId)) {
        focusIds.add(childId);
        stack.push(childId);
      }
    });
  }

  return focusIds;
}

function layoutMindMap(root: MindMapNode): MindMapCanvasNode[] {
  const nodes: MindMapCanvasNode[] = [];
  nodes.push({ node: root, depth: 0, branch: "center", x: 0, y: 0, accent: MINDMAP_ROOT_ACCENT });
  const rootSize = getMindMapNodeSize(root);

  const leftThemes: Array<{ node: MindMapNode; accent: MindMapAccent }> = [];
  const rightThemes: Array<{ node: MindMapNode; accent: MindMapAccent }> = [];
  let leftWeight = 0;
  let rightWeight = 0;

  root.children.forEach((themeNode, index) => {
    const accent = MINDMAP_BRANCH_ACCENTS[index % MINDMAP_BRANCH_ACCENTS.length];
    const span = measureMindMapSpan(themeNode, 1);
    if (leftWeight <= rightWeight) {
      leftThemes.push({ node: themeNode, accent });
      leftWeight += span;
      return;
    }
    rightThemes.push({ node: themeNode, accent });
    rightWeight += span;
  });

  const placeSubtree = (
    node: MindMapNode,
    depth: number,
    branch: "left" | "right",
    accent: MindMapAccent,
    x: number,
    y: number,
    parentId: string,
  ) => {
    nodes.push({ node, depth, branch, x, y, parentId, accent });
    if (!node.children.length) {
      return;
    }

    const childGap = depth === 1 ? 30 : 18;
    const nodeSize = getMindMapNodeSize(node);
    const outgoingX = branch === "left" ? x - nodeSize.width : x + nodeSize.width;
    const childSpans = node.children.map((child) => ({ child, span: measureMindMapSpan(child, depth + 1) }));
    const totalSpan = childSpans.reduce((sum, item) => sum + item.span, 0) + childGap * (childSpans.length - 1);
    let cursor = y - totalSpan / 2;

    childSpans.forEach(({ child, span }) => {
      const childY = cursor + span / 2;
      const childX = branch === "left"
        ? outgoingX - getMindMapHorizontalOffset(depth, child)
        : outgoingX + getMindMapHorizontalOffset(depth, child);
      placeSubtree(child, depth + 1, branch, accent, childX, childY, node.id);
      cursor += span + childGap;
    });
  };

  const placeSide = (items: Array<{ node: MindMapNode; accent: MindMapAccent }>, branch: "left" | "right") => {
    if (!items.length) {
      return;
    }
    const themeGap = 58;
    const spans = items.map((item) => ({ ...item, span: measureMindMapSpan(item.node, 1) }));
    const totalSpan = spans.reduce((sum, item) => sum + item.span, 0) + themeGap * (spans.length - 1);
    let cursor = -totalSpan / 2;

    spans.forEach(({ node, accent, span }) => {
      const themeY = cursor + span / 2;
      const themeX = branch === "left"
        ? -(rootSize.width / 2 + getMindMapHorizontalOffset(0, node))
        : rootSize.width / 2 + getMindMapHorizontalOffset(0, node);
      placeSubtree(node, 1, branch, accent, themeX, themeY, root.id);
      cursor += span + themeGap;
    });
  };

  placeSide(leftThemes, "left");
  placeSide(rightThemes, "right");

  const bounds = nodes.reduce(
    (acc, item) => {
      const size = getMindMapNodeSize(item.node);
      const left = item.branch === "left" ? item.x - size.width : item.branch === "right" ? item.x : item.x - size.width / 2;
      const right = item.branch === "left" ? item.x : item.branch === "right" ? item.x + size.width : item.x + size.width / 2;
      return {
        left: Math.min(acc.left, left),
        right: Math.max(acc.right, right),
        top: Math.min(acc.top, item.y - size.height / 2),
        bottom: Math.max(acc.bottom, item.y + size.height / 2),
      };
    },
    { left: Number.POSITIVE_INFINITY, right: Number.NEGATIVE_INFINITY, top: Number.POSITIVE_INFINITY, bottom: Number.NEGATIVE_INFINITY },
  );
  const offsetX = -((bounds.left + bounds.right) / 2);
  const offsetY = -((bounds.top + bounds.bottom) / 2);

  return nodes.map((item) => ({
    ...item,
    x: item.x + offsetX,
    y: item.y + offsetY,
  }));
}

function buildMindMapFlow(root: MindMapNode, selectedNodeId: string | null): { nodes: FlowNode<MindMapFlowNodeData>[]; edges: Edge[] } {
  const positioned = layoutMindMap(root);
  const focusIds = getMindMapFocusIds(positioned, selectedNodeId);
  const hasFocus = Boolean(focusIds?.size);
  const nodes: FlowNode<MindMapFlowNodeData>[] = positioned.map((item) => {
    const selected = selectedNodeId === item.node.id;
    const muted = hasFocus ? !focusIds!.has(item.node.id) : false;
    const size = getMindMapNodeSize(item.node);
    const position = item.branch === "left"
      ? { x: item.x - size.width, y: item.y - size.height / 2 }
      : item.branch === "right"
        ? { x: item.x, y: item.y - size.height / 2 }
        : { x: item.x - size.width / 2, y: item.y - size.height / 2 };
    return {
      id: item.node.id,
      type: "mindmap",
      position,
      draggable: false,
      selectable: true,
      sourcePosition: item.branch === "left" ? Position.Left : Position.Right,
      targetPosition: item.branch === "left" ? Position.Right : Position.Left,
      className: `${selected ? "is-active " : ""}${muted ? "is-muted" : ""}`.trim(),
      data: {
        label: item.node.label,
        summary: item.node.summary,
        tone: item.node.type,
        branch: item.branch,
        selected,
        muted,
        timeAnchor: item.node.time_anchor ?? null,
        sourceChapterTitles: item.node.source_chapter_titles,
        sourceChapterStarts: item.node.source_chapter_starts,
        accent: item.accent,
      },
    };
  });

  const edges: Edge[] = positioned
    .filter((item) => item.parentId)
    .map((item) => {
      const muted = hasFocus ? !(focusIds!.has(item.node.id) && focusIds!.has(item.parentId!)) : false;
      return {
        id: `${item.parentId}-${item.node.id}`,
        source: item.parentId!,
        target: item.node.id,
        sourceHandle: item.branch === "left" ? "source-left" : "source-right",
        targetHandle: item.branch === "left" ? "target-right" : "target-left",
        type: "simplebezier",
        animated: false,
        className: `detail-mindmap-edge${muted ? " is-muted" : ""}`,
        style: {
          stroke: item.accent.stroke,
          strokeWidth: item.depth <= 1 ? 2.8 : 2.2,
        },
      };
    });

  return { nodes, edges };
}

function MindMapFlowNode({ data }: NodeProps<FlowNode<MindMapFlowNodeData>>) {
  const style = {
    "--mindmap-branch": data.accent.stroke,
    "--mindmap-branch-soft": data.accent.surface,
    "--mindmap-branch-ink": data.accent.ink,
    "--mindmap-branch-shadow": data.accent.shadow,
  } as CSSProperties;
  const displayLabel = sanitizeMindMapLabel(data.label, data.summary);

  return (
    <div className={`detail-mindmap-node-card tone-${data.tone}`} style={style}>
      {data.tone === "root" ? (
        <>
          <Handle className="detail-mindmap-handle" id="source-left" position={Position.Left} type="source" />
          <Handle className="detail-mindmap-handle" id="source-right" position={Position.Right} type="source" />
        </>
      ) : (
        <>
          <Handle
            className="detail-mindmap-handle"
            id="target-left"
            position={Position.Left}
            type="target"
          />
          <Handle
            className="detail-mindmap-handle"
            id="target-right"
            position={Position.Right}
            type="target"
          />
          <Handle
            className="detail-mindmap-handle"
            id="source-left"
            position={Position.Left}
            type="source"
          />
          <Handle
            className="detail-mindmap-handle"
            id="source-right"
            position={Position.Right}
            type="source"
          />
        </>
      )}
      <div className="detail-mindmap-node-head">
        <MarkdownContent className="detail-mindmap-node-label" compact content={displayLabel} />
        {shouldDisplayMindMapTimestamp(data.timeAnchor) ? <small>{formatDuration(data.timeAnchor)}</small> : null}
      </div>
    </div>
  );
}

const mindMapNodeTypes = {
  mindmap: MindMapFlowNode,
};

function FloatingVideoPlayer({
  embedUrl,
  openLabel,
  sourceUrl,
  title,
}: {
  embedUrl: string;
  openLabel: string;
  sourceUrl: string;
  title: string;
}) {
  const pointerStateRef = useRef<{
    mode: "drag" | "resize";
    originX: number;
    originY: number;
    layout: FloatingPlayerLayout;
  } | null>(null);
  const [layout, setLayout] = useState<FloatingPlayerLayout>(() => {
    if (typeof window === "undefined") {
      return { width: FLOATING_PLAYER_DEFAULT_WIDTH, x: 0, y: 0 };
    }
    return createDefaultFloatingPlayerLayout(window.innerWidth, window.innerHeight);
  });

  useEffect(() => {
    function handleViewportResize() {
      setLayout((current) => clampFloatingPlayerLayout(current, window.innerWidth, window.innerHeight));
    }

    handleViewportResize();
    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, []);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const pointerState = pointerStateRef.current;
      if (!pointerState) {
        return;
      }

      if (pointerState.mode === "drag") {
        setLayout((current) => clampFloatingPlayerLayout({
          ...current,
          width: pointerState.layout.width,
          x: pointerState.layout.x + (event.clientX - pointerState.originX),
          y: pointerState.layout.y + (event.clientY - pointerState.originY),
        }, window.innerWidth, window.innerHeight));
        return;
      }

      setLayout((current) => clampFloatingPlayerLayout({
        ...current,
        width: pointerState.layout.width + (event.clientX - pointerState.originX),
      }, window.innerWidth, window.innerHeight));
    }

    function clearPointerState() {
      pointerStateRef.current = null;
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", clearPointerState);
    window.addEventListener("pointercancel", clearPointerState);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", clearPointerState);
      window.removeEventListener("pointercancel", clearPointerState);
    };
  }, []);

  function handlePointerStart(mode: "drag" | "resize", event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }
    pointerStateRef.current = {
      mode,
      originX: event.clientX,
      originY: event.clientY,
      layout,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function handleResetLayout() {
    if (typeof window === "undefined") {
      return;
    }
    setLayout(createDefaultFloatingPlayerLayout(window.innerWidth, window.innerHeight));
  }

  return (
    <div
      className="detail-floating-player"
      style={{
        width: `${layout.width}px`,
        left: `${layout.x}px`,
        top: `${layout.y}px`,
      }}
    >
      <div className="detail-floating-player-head" onPointerDown={(event) => handlePointerStart("drag", event)}>
        <div className="detail-floating-player-copy">
          <span className="detail-floating-player-kicker">Player</span>
          <strong>{title}</strong>
        </div>
        <a
          className="detail-floating-player-link"
          href={sourceUrl}
          target="_blank"
          rel="noreferrer"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {openLabel}
        </a>
      </div>
      <div className="detail-video-embed-frame detail-video-embed-frame-floating">
        <iframe
          allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          className="detail-video-embed"
          referrerPolicy="strict-origin-when-cross-origin"
          scrolling="no"
          src={embedUrl}
          title={`${title} 悬浮播放器`}
        />
      </div>
      <div
        className="detail-floating-player-resize"
        role="presentation"
        onPointerDown={(event) => handlePointerStart("resize", event)}
        onDoubleClick={handleResetLayout}
      />
    </div>
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

function IconCopyImage(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      <rect x="3.5" y="6.5" width="13" height="13" rx="2.5" />
      <path d="M9 6V5.5A2.5 2.5 0 0 1 11.5 3H18a2.5 2.5 0 0 1 2.5 2.5V12" />
      <path d="m6.5 16.5 3.4-3.4a1.3 1.3 0 0 1 1.84 0l1.26 1.26" />
      <path d="m12.5 15.5 1.4-1.4a1.3 1.3 0 0 1 1.84 0l.76.76" />
      <circle cx="11" cy="10.5" r="1.1" />
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
