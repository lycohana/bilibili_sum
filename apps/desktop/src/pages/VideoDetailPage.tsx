import "@xyflow/react/dist/style.css";
import { Controls, Handle, Position, ReactFlow, type Edge, type Node as FlowNode, type NodeProps } from "@xyflow/react";
import { toBlob } from "html-to-image";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent, type SVGProps } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { progressEventClass, stageLabel, taskStatusClass } from "../appModel";
import { api } from "../api";
import { CookieHelpDialog } from "../components/CookieHelpDialog";
import { MarkdownContent } from "../components/MarkdownContent";
import { MultiPageSelectDialog } from "../components/MultiPageSelectDialog";
import { FloatingNoticeStack } from "../components/FloatingNoticeStack";
import {
  AGGREGATE_SUMMARY_PAGE_NUMBER,
  buildVideoPageBatchOptions,
  canExportKnowledgeNote,
  buildChapterGroups,
  buildKnowledgeCards,
  describeMindMapWorkspace,
  describeTaskContentState,
  describeUserFacingErrorMessage,
  filterTasksForPage,
  getTaskPageNumber,
  isAggregateSummaryTask,
  pickDetailTaskId,
  resolveKnowledgeNoteMarkdown,
  taskPageLabel,
  type DetailTab,
  type KnowledgeCard,
  type TaskPanelState,
} from "../detailModel";
import type { MindMapNode, TaskDetail, TaskEvent, TaskMarkdownExportResponse, TaskMindMapResponse, TaskSegment, TaskStatus, TaskSummary, TaskVisualEvidenceResponse, VideoAssetDetail, VideoDirectMediaStatus, VideoPageBatchOption, VideoTaskBatchResponse, VisualEvidenceFrame, VisualEvidenceObservation } from "../types";
import { formatDateTime, formatDuration, formatTaskDuration, formatTokenCount, sanitizeMindMapLabel, summarizeEvents, taskStatusLabel } from "../utils";
import { buildPlayerEmbedDescriptor, buildTimestampedSourceUrl, postPlayerSeek, type SupportedVideoPlatform } from "../videoPlayer";

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

type ProgressPhase = {
  id: "prepare" | "media" | "summary" | "export" | "mindmap" | "knowledge" | "other";
  label: string;
  events: TaskEvent[];
  tone: "done" | "active" | "failed" | "pending";
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

type VideoDetailPageProps = {
  onRefresh(): void;
  onOpenCookieSettings?: () => void;
  onOpenCookieTutorial?: () => void;
  onCaptureLoginCookies?: () => void | Promise<void>;
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
  pageAnchorLabel?: string;
  sourceChapterTitles: string[];
  sourceChapterStarts: number[];
  accent: MindMapAccent;
};

type FloatingPlayerLayout = {
  width: number;
  x: number;
  y: number;
};

type KnowledgeNoteViewMode = "text" | "visual";

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
const LOCAL_VIDEO_SUFFIXES = new Set([".mp4", ".mov", ".mkv", ".avi", ".wmv", ".webm", ".flv", ".m4v", ".ts", ".mpeg", ".mpg"]);
const SUMMARY_PREFERENCE_STORAGE_KEY = "bilisum.summaryPreference";

const detailTabs: Array<{ id: DetailTab; label: string; description: string }> = [
  { id: "knowledge", label: "知识卡片", description: "按概览、要点、章节整理当前任务结果。" },
  { id: "summary", label: "知识笔记", description: "查看当前任务的完整笔记、重点展开和转写全文。" },
  { id: "captions", label: "动态字幕", description: "按时间轴跟读转写内容，点击字幕跳转播放。" },
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

function isProgressEventFailed(event: TaskEvent) {
  return progressEventClass(event.stage) === "error" || /失败|不可用|错误|异常/i.test(event.message);
}

function isProgressEventCompleted(event: TaskEvent) {
  return progressEventClass(event.stage) === "completed" || event.progress >= 100 || /完成|已写入|检查通过|已就绪/.test(event.message);
}

function getProgressPhaseId(event: TaskEvent): ProgressPhase["id"] {
  const message = event.message || "";
  if (event.stage.startsWith("mindmap_") || /思维导图|导图/.test(message)) {
    return "mindmap";
  }
  if (/知识库|索引/.test(message)) {
    return "knowledge";
  }
  if (/导出|写入本地|结果整理|结果文件/.test(message)) {
    return "export";
  }
  if (event.stage === "downloading" || event.stage === "transcribing" || /音频|转写|字幕/.test(message)) {
    return "media";
  }
  if (event.stage === "summarizing" || /LLM|摘要|总结|知识卡片|知识笔记|内容块|分块|合并/.test(message)) {
    return "summary";
  }
  if (event.stage === "queued" || /队列|开始执行|检查|规范化|读取视频|视频信息/.test(message)) {
    return "prepare";
  }
  return "other";
}

const progressPhaseLabels: Record<ProgressPhase["id"], string> = {
  prepare: "准备阶段",
  media: "音频与转写",
  summary: "摘要生成",
  export: "结果导出",
  mindmap: "思维导图",
  knowledge: "知识库索引",
  other: "其他记录",
};

const progressPhaseOrder: ProgressPhase["id"][] = ["prepare", "media", "summary", "export", "mindmap", "knowledge", "other"];

function buildProgressPhases(events: TaskEvent[]): ProgressPhase[] {
  const groups = new Map<ProgressPhase["id"], TaskEvent[]>();
  for (const event of events) {
    const phaseId = getProgressPhaseId(event);
    groups.set(phaseId, [...(groups.get(phaseId) ?? []), event]);
  }

  const lastEvent = events.at(-1);
  return progressPhaseOrder
    .map((id) => {
      const phaseEvents = groups.get(id) ?? [];
      if (!phaseEvents.length) {
        return null;
      }
      const hasFailure = phaseEvents.some(isProgressEventFailed);
      const hasActive = Boolean(lastEvent && phaseEvents.some((event) => event.event_id === lastEvent.event_id));
      const allDone = phaseEvents.every(isProgressEventCompleted);
      return {
        id,
        label: progressPhaseLabels[id],
        events: phaseEvents,
        tone: hasFailure ? "failed" : hasActive && !allDone ? "active" : allDone ? "done" : "pending",
      } satisfies ProgressPhase;
    })
    .filter((phase): phase is ProgressPhase => Boolean(phase));
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

function loadKnowledgeNoteViewMode(): KnowledgeNoteViewMode {
  if (typeof window === "undefined") {
    return "text";
  }
  try {
    const rawValue = window.localStorage.getItem(SUMMARY_PREFERENCE_STORAGE_KEY);
    if (!rawValue) {
      return "text";
    }
    const parsed = JSON.parse(rawValue) as { noteMode?: unknown };
    return parsed.noteMode === "visual" ? "visual" : "text";
  } catch {
    return "text";
  }
}

function saveKnowledgeNoteViewMode(mode: KnowledgeNoteViewMode) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const rawValue = window.localStorage.getItem(SUMMARY_PREFERENCE_STORAGE_KEY);
    const parsed = rawValue ? JSON.parse(rawValue) as Record<string, unknown> : {};
    window.localStorage.setItem(SUMMARY_PREFERENCE_STORAGE_KEY, JSON.stringify({ ...parsed, noteMode: mode }));
  } catch {
    window.localStorage.setItem(SUMMARY_PREFERENCE_STORAGE_KEY, JSON.stringify({ noteMode: mode }));
  }
}

function ShakaMediaPlayer({
  audioUrl,
  className,
  manifestUrl,
  onTimeUpdate,
  poster,
  videoRef,
  videoUrl,
}: {
  audioUrl?: string;
  className: string;
  manifestUrl: string;
  onTimeUpdate?: (seconds: number) => void;
  poster?: string;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  videoUrl?: string;
}) {
  const [errorMessage, setErrorMessage] = useState("");
  const [useFallback, setUseFallback] = useState(false);

  useEffect(() => {
    if (useFallback) {
      return;
    }
    const video = videoRef.current;
    if (!video) {
      return;
    }
    let cancelled = false;
    let player: import("shaka-player").default.Player | null = null;
    const handleError = (event: Event) => {
      const detail = (event as CustomEvent).detail as { code?: number; message?: string } | undefined;
      setErrorMessage(detail?.message || (detail?.code ? `Shaka 播放错误 ${detail.code}` : "Shaka 播放器加载失败"));
    };
    const handleTimeUpdate = () => onTimeUpdate?.(video.currentTime || 0);
    video.addEventListener("timeupdate", handleTimeUpdate);

    void import("shaka-player")
      .then((module) => {
        if (cancelled) {
          return null;
        }
        module.default.polyfill.installAll();
        if (!module.default.Player.isBrowserSupported()) {
          throw new Error("当前 Chromium 环境不支持 Shaka/MSE 播放。");
        }
        player = new module.default.Player(video);
        player.addEventListener("error", handleError);
        return player.load(manifestUrl);
      })
      .then(() => {
        if (!cancelled) {
          setErrorMessage("");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const detail = error as { code?: number; message?: string };
          setErrorMessage(detail.message || (detail.code ? `Shaka 播放错误 ${detail.code}` : "Shaka 播放器加载失败"));
          if (videoUrl && audioUrl) {
            setUseFallback(true);
          }
        }
      });

    return () => {
      cancelled = true;
      video.removeEventListener("timeupdate", handleTimeUpdate);
      if (player) {
        player.removeEventListener("error", handleError);
        void player.destroy().catch(() => undefined);
      }
    };
  }, [audioUrl, manifestUrl, onTimeUpdate, useFallback, videoRef, videoUrl]);

  if (useFallback && videoUrl && audioUrl) {
    return (
      <SplitMediaFallbackPlayer
        audioUrl={audioUrl}
        className={className}
        onTimeUpdate={onTimeUpdate}
        poster={poster}
        videoRef={videoRef}
        videoUrl={videoUrl}
      />
    );
  }

  return (
    <>
      <video
        ref={videoRef}
        className={className}
        controls
        preload="metadata"
        poster={poster}
      />
      {errorMessage ? (
        <div className="detail-video-export-mask detail-video-error-mask" aria-live="polite">
          <div className="detail-video-export-mask-copy">
            <strong>播放器加载失败</strong>
            <span>{errorMessage}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}

function SplitMediaFallbackPlayer({
  audioUrl,
  className,
  onTimeUpdate,
  poster,
  videoRef,
  videoUrl,
}: {
  audioUrl: string;
  className: string;
  onTimeUpdate?: (seconds: number) => void;
  poster?: string;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  videoUrl: string;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video || !audio) {
      return;
    }
    const sync = (force = false) => {
      if (force || Math.abs((audio.currentTime || 0) - (video.currentTime || 0)) > 0.35) {
        audio.currentTime = video.currentTime || 0;
      }
      audio.playbackRate = video.playbackRate || 1;
      audio.muted = video.muted;
      audio.volume = video.volume;
    };
    const playAudio = () => {
      if (!video.paused && !video.ended) {
        void audio.play().catch(() => undefined);
      }
    };
    const handlePlay = () => {
      sync(true);
      playAudio();
    };
    const handlePause = () => audio.pause();
    const handleSeeked = () => {
      sync(true);
      playAudio();
    };
    const handleTimeUpdate = () => {
      sync();
      playAudio();
      onTimeUpdate?.(video.currentTime || 0);
    };
    const handleChange = () => {
      sync();
      playAudio();
    };
    const timer = window.setInterval(handleTimeUpdate, 700);

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("volumechange", handleChange);
    video.addEventListener("ratechange", handleChange);
    video.addEventListener("playing", handleChange);
    return () => {
      window.clearInterval(timer);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("volumechange", handleChange);
      video.removeEventListener("ratechange", handleChange);
      video.removeEventListener("playing", handleChange);
      audio.pause();
    };
  }, [audioUrl, onTimeUpdate, videoRef, videoUrl]);

  return (
    <>
      <video
        ref={videoRef}
        className={className}
        controls
        preload="metadata"
        poster={poster}
        src={videoUrl}
      />
      <audio ref={audioRef} preload="metadata" src={audioUrl} />
    </>
  );
}

function canUseBilibiliBrowserView() {
  return typeof window !== "undefined" && Boolean(window.desktop?.bilibiliPlayer);
}

async function loadTaskContext(taskId: string): Promise<TaskContext> {
  const [detail, events] = await Promise.all([api.getTaskResult(taskId), api.getTaskEvents(taskId)]);
  return { detail, events };
}

function IconFavorite(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16z" />
    </svg>
  );
}

function isBilibiliCookieHelpError(message: string) {
  return /HTTP\s*412|cookies?\.txt|B\s*站返回|Bilibili rejected|风控拦截|登录态|cookiesfrombrowser|DPAPI/i.test(message);
}

export function VideoDetailPage({ onRefresh, onOpenCookieSettings, onOpenCookieTutorial, onCaptureLoginCookies }: VideoDetailPageProps) {
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
  const [actionMenuSection, setActionMenuSection] = useState<"regenerate" | "batch" | "maintenance" | null>(null);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [cookieHelpDialogOpen, setCookieHelpDialogOpen] = useState(false);
  const [mindMaps, setMindMaps] = useState<Record<string, TaskMindMapResponse>>({});
  const [mindMapLoading, setMindMapLoading] = useState<Record<string, boolean>>({});
  const [visualEvidence, setVisualEvidence] = useState<Record<string, TaskVisualEvidenceResponse>>({});
  const [visualEvidenceLoading, setVisualEvidenceLoading] = useState<Record<string, boolean>>({});
  const [taskSegments, setTaskSegments] = useState<Record<string, TaskSegment[]>>({});
  const [taskSegmentAccuracy, setTaskSegmentAccuracy] = useState<Record<string, "exact" | "approximate" | "mixed" | "unknown">>({});
  const [taskSegmentsLoading, setTaskSegmentsLoading] = useState<Record<string, boolean>>({});
  const [taskSegmentsErrors, setTaskSegmentsErrors] = useState<Record<string, string>>({});
  const [activeCaptionIndex, setActiveCaptionIndex] = useState<number | null>(null);
  const [bilibiliBrowserViewReady, setBilibiliBrowserViewReady] = useState(false);
  const [bilibiliBrowserViewFailed, setBilibiliBrowserViewFailed] = useState(false);
  const [directMediaStatus, setDirectMediaStatus] = useState<Record<string, VideoDirectMediaStatus>>({});
  const [knowledgeNoteViewMode, setKnowledgeNoteViewMode] = useState<KnowledgeNoteViewMode>(() => loadKnowledgeNoteViewMode());
  const [knowledgeNoteModeMenuOpen, setKnowledgeNoteModeMenuOpen] = useState(false);
  const [isExportingKnowledgeCard, setIsExportingKnowledgeCard] = useState(false);
  const [isExportingKnowledgeNote, setIsExportingKnowledgeNote] = useState(false);
  const [isExportingTranscript, setIsExportingTranscript] = useState(false);
  const [knowledgeNoteExportMenuOpen, setKnowledgeNoteExportMenuOpen] = useState(false);
  const [includeTranscriptInNoteExport, setIncludeTranscriptInNoteExport] = useState(false);
  const [knowledgeOutputDir, setKnowledgeOutputDir] = useState("");
  const [lastKnowledgeExport, setLastKnowledgeExport] = useState<TaskMarkdownExportResponse | null>(null);
  const [expandedChapterGroupIds, setExpandedChapterGroupIds] = useState<string[]>([]);
  const [selectedPageNumber, setSelectedPageNumber] = useState<number | null>(null);
  const [jumpConfirmPopover, setJumpConfirmPopover] = useState<{ open: boolean; pageNumber: number; title: string; x: number; y: number } | null>(null);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [batchDialogMode, setBatchDialogMode] = useState<"create" | "resummary">("create");
  const [playerSeekTarget, setPlayerSeekTarget] = useState<PlayerSeekTarget>({ nonce: 0, seconds: null });
  const [selectedMindMapNodeId, setSelectedMindMapNodeId] = useState<string | null>(null);
  const lastAutoRefreshEventRef = useRef<string | null>(null);
  const cookieHelpAutoShownRef = useRef<string | null>(null);
  const taskPopoverRef = useRef<HTMLDivElement | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const pageSwitcherRef = useRef<HTMLDivElement | null>(null);
  const batchSideRef = useRef<HTMLDivElement | null>(null);
  const playerFrameRef = useRef<HTMLDivElement | null>(null);
  const captionPlayerFrameRef = useRef<HTMLDivElement | null>(null);
  const playerIframeRef = useRef<HTMLIFrameElement | null>(null);
  const captionPlayerIframeRef = useRef<HTMLIFrameElement | null>(null);
  const captionBrowserViewSlotRef = useRef<HTMLDivElement | null>(null);
  const bilibiliBrowserViewOccludedRef = useRef(false);
  const captionListRef = useRef<HTMLDivElement | null>(null);
  const activeCaptionRowRef = useRef<HTMLDivElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const captionLocalVideoRef = useRef<HTMLVideoElement | null>(null);
  const directMediaProbeKeysRef = useRef<Set<string>>(new Set());
  const knowledgeExportRef = useRef<HTMLElement | null>(null);
  const knowledgeNoteModeMenuRef = useRef<HTMLDivElement | null>(null);
  const knowledgeNoteExportMenuRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    void api.getSettings()
      .then((settings) => {
        if (!cancelled) {
          setKnowledgeOutputDir(String(settings.output_dir || "").trim());
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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

  async function loadVisualEvidence(taskId: string, options: { force?: boolean } = {}) {
    if (!options.force && visualEvidence[taskId]) {
      return visualEvidence[taskId];
    }
    setVisualEvidenceLoading((current) => ({ ...current, [taskId]: true }));
    try {
      const response = await api.getTaskVisualEvidence(taskId);
      setVisualEvidence((current) => ({ ...current, [taskId]: response }));
      return response;
    } catch (error) {
      const failedState: TaskVisualEvidenceResponse = {
        task_id: taskId,
        mode: "text",
        status: "failed",
        error_message: error instanceof Error ? error.message : "图文笔记加载失败",
        updated_at: null,
        frame_count: 0,
        insert_count: 0,
        visual_note_markdown: "",
        enhanced_note_markdown: "",
        context: null,
      };
      setVisualEvidence((current) => ({ ...current, [taskId]: failedState }));
      throw error;
    } finally {
      setVisualEvidenceLoading((current) => omitRecordKey(current, taskId));
    }
  }

  async function loadTaskSegments(taskId: string, options: { force?: boolean } = {}) {
    if (!options.force && taskSegments[taskId]) {
      return taskSegments[taskId];
    }
    setTaskSegmentsLoading((current) => ({ ...current, [taskId]: true }));
    setTaskSegmentsErrors((current) => omitRecordKey(current, taskId));
    try {
      const response = await api.getTaskSegments(taskId);
      setTaskSegments((current) => ({ ...current, [taskId]: response.segments }));
      setTaskSegmentAccuracy((current) => ({ ...current, [taskId]: response.timing_accuracy ?? "unknown" }));
      return response.segments;
    } catch (error) {
      const message = error instanceof Error ? error.message : "动态字幕加载失败";
      setTaskSegmentsErrors((current) => ({ ...current, [taskId]: message }));
      return [];
    } finally {
      setTaskSegmentsLoading((current) => omitRecordKey(current, taskId));
    }
  }

  async function triggerVisualNoteGeneration(taskId: string, options: { force?: boolean; mode?: string } = {}) {
    setVisualEvidenceLoading((current) => ({ ...current, [taskId]: true }));
    try {
      const response = await api.generateTaskVisualEvidence(taskId, { force: options.force, mode: options.mode });
      setVisualEvidence((current) => ({ ...current, [taskId]: response }));
      return response;
    } catch (error) {
      const failedState: TaskVisualEvidenceResponse = {
        task_id: taskId,
        mode: "frame_insert",
        status: "failed",
        error_message: error instanceof Error ? error.message : "图文笔记生成失败",
        updated_at: null,
        frame_count: 0,
        insert_count: 0,
        visual_note_markdown: "",
        enhanced_note_markdown: "",
        context: null,
      };
      setVisualEvidence((current) => ({ ...current, [taskId]: failedState }));
      throw error;
    } finally {
      setVisualEvidenceLoading((current) => omitRecordKey(current, taskId));
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
    setKnowledgeNoteExportMenuOpen(false);
    setLastKnowledgeExport(null);
    setSelectedPageNumber(null);
    setPageMenuOpen(false);
    setBatchDialogOpen(false);
    setBatchDialogMode("create");
    setSelectedMindMapNodeId(null);
    void refreshDetail({ preferredTaskId: null }).catch(() => undefined);
  }, [videoId]);

  const orderedTasks = useMemo(() => [...tasks].sort(compareTasksByRecent), [tasks]);
  const availablePages = video?.pages ?? [];
  const aggregateSummaryTasks = useMemo(() => orderedTasks.filter(isAggregateSummaryTask), [orderedTasks]);
  const pageGeneratedMap = useMemo(() => {
    const nextMap = new Map<number, boolean>();
    for (const task of orderedTasks) {
      if (isAggregateSummaryTask(task)) {
        continue;
      }
      const pageNumber = getTaskPageNumber(task);
      nextMap.set(pageNumber, Boolean(nextMap.get(pageNumber)) || hasGeneratedResult(task));
    }
    return nextMap;
  }, [orderedTasks]);
  const pageBatchOptions = useMemo<VideoPageBatchOption[]>(() => {
    return buildVideoPageBatchOptions(availablePages, orderedTasks);
  }, [availablePages, orderedTasks]);
  const pageBatchSummary = useMemo(() => {
    return pageBatchOptions.reduce(
      (summary, page) => {
        summary.total += 1;
        if (page.aggregate_status === "completed") {
          summary.completed += 1;
        } else if (page.aggregate_status === "in_progress") {
          summary.inProgress += 1;
        } else if (page.aggregate_status === "failed") {
          summary.failed += 1;
        } else {
          summary.notStarted += 1;
        }
        return summary;
      },
      { total: 0, completed: 0, inProgress: 0, notStarted: 0, failed: 0 },
    );
  }, [pageBatchOptions]);
  const canCreateAggregateSummary = pageBatchOptions.some((page) => page.has_completed_result);
  const canShowAggregateSummaryOption = availablePages.length > 0 && (aggregateSummaryTasks.length > 0 || canCreateAggregateSummary);
  const effectivePageNumber = selectedPageNumber ?? availablePages[0]?.page ?? null;
  const isAggregateSummaryView = effectivePageNumber === AGGREGATE_SUMMARY_PAGE_NUMBER;
  const currentPage = availablePages.find((page) => page.page === effectivePageNumber) ?? null;
  const pageTasks = useMemo(() => {
    if (!availablePages.length || effectivePageNumber == null) {
      return orderedTasks.filter((task) => !isAggregateSummaryTask(task));
    }
    return filterTasksForPage(orderedTasks, effectivePageNumber);
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
    if (selectedPageNumber === AGGREGATE_SUMMARY_PAGE_NUMBER && canShowAggregateSummaryOption) {
      return;
    }
    const preferredPage = orderedTasks.find((task) => task.page_number != null && task.page_number > 0)?.page_number ?? availablePages[0]?.page ?? null;
    setSelectedPageNumber(preferredPage);
  }, [availablePages, canShowAggregateSummaryOption, orderedTasks, selectedPageNumber]);

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
    if (!selectedTaskId || activeTab !== "summary") {
      return;
    }
    void loadVisualEvidence(selectedTaskId).catch(() => undefined);
  }, [activeTab, selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId || activeTab !== "captions") {
      return;
    }
    void loadTaskSegments(selectedTaskId).catch(() => undefined);
  }, [activeTab, selectedTaskId]);

  useEffect(() => {
    setActiveCaptionIndex(null);
  }, [selectedTaskId]);

  useEffect(() => {
    saveKnowledgeNoteViewMode(knowledgeNoteViewMode);
  }, [knowledgeNoteViewMode]);

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
    if (!selectedTaskId) {
      return;
    }
    const currentVisualEvidence = visualEvidence[selectedTaskId];
    const isGenerating = currentVisualEvidence?.status === "generating" || selectedTaskDetail?.result?.visual_note_status === "generating";
    if (!isGenerating) {
      return;
    }
    const timer = window.setInterval(() => {
      void Promise.all([
        loadVisualEvidence(selectedTaskId, { force: true }),
        ensureTaskContext(selectedTaskId, { force: true }),
      ]).catch(() => undefined);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [selectedTaskDetail?.result?.visual_note_status, selectedTaskId, visualEvidence]);

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
      || event.stage === "visual_completed"
      || event.stage === "visual_partial"
      || event.stage === "visual_failed"
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
    if (taskPanelState !== "expanded" && !actionMenuOpen && !pageMenuOpen && !knowledgeNoteExportMenuOpen && !knowledgeNoteModeMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      const clickedTaskPopover = taskPopoverRef.current?.contains(target);
      const clickedActionMenu = actionMenuRef.current?.contains(target);
      const clickedPageSwitcher = pageSwitcherRef.current?.contains(target);
      const clickedKnowledgeNoteExportMenu = knowledgeNoteExportMenuRef.current?.contains(target);
      const clickedKnowledgeNoteModeMenu = knowledgeNoteModeMenuRef.current?.contains(target);
      const clickedBatchSide = batchSideRef.current?.contains(target);

      if (!clickedTaskPopover && !clickedBatchSide) {
        setTaskPanelState("collapsed");
      }
      if (!clickedActionMenu) {
        setActionMenuOpen(false);
        setActionMenuSection(null);
      }
      if (!clickedPageSwitcher) {
        setPageMenuOpen(false);
      }
      if (!clickedKnowledgeNoteExportMenu) {
        setKnowledgeNoteExportMenuOpen(false);
      }
      if (!clickedKnowledgeNoteModeMenu) {
        setKnowledgeNoteModeMenuOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setTaskPanelState("collapsed");
        setActionMenuOpen(false);
        setActionMenuSection(null);
        setPageMenuOpen(false);
        setKnowledgeNoteExportMenuOpen(false);
        setKnowledgeNoteModeMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [actionMenuOpen, knowledgeNoteExportMenuOpen, knowledgeNoteModeMenuOpen, pageMenuOpen, taskPanelState]);

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
  const cookieHelpNeeded = Boolean(contentState?.detail && isBilibiliCookieHelpError(contentState.detail));

  useEffect(() => {
    if (!selectedTaskId || !contentState?.detail || !isBilibiliCookieHelpError(contentState.detail)) {
      return;
    }
    const helpKey = `${selectedTaskId}:${contentState.detail}`;
    if (cookieHelpAutoShownRef.current === helpKey) {
      return;
    }
    cookieHelpAutoShownRef.current = helpKey;
    setCookieHelpDialogOpen(true);
  }, [contentState?.detail, selectedTaskId]);

  function openCookieExportTutorial() {
    onOpenCookieTutorial?.();
    if (!onOpenCookieTutorial) {
      window.open("https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp", "_blank", "noopener,noreferrer");
    }
  }

  function openYtdlpCookieSettings() {
    setCookieHelpDialogOpen(false);
    if (onOpenCookieSettings) {
      onOpenCookieSettings();
      return;
    }
    navigate("/settings");
  }

  async function captureLoginCookies() {
    if (!onCaptureLoginCookies) {
      openYtdlpCookieSettings();
      return;
    }
    try {
      await onCaptureLoginCookies();
      setCookieHelpDialogOpen(false);
      setStatus("B 站登录态已保存。重新提交任务即可。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "捕获 B 站登录态失败，请按教程手动导出 cookies.txt。");
    }
  }

  const cookieHelpActions = cookieHelpNeeded
    ? {
        onOpenTutorial: openCookieExportTutorial,
        onOpenSettings: openYtdlpCookieSettings,
      }
    : null;

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
  const knowledgeCards = useMemo(
    () => buildKnowledgeCards(selectedResult, { chapterAnchor: isAggregateSummaryView ? "page" : "time" }),
    [isAggregateSummaryView, selectedResult],
  );
  const overviewCard = knowledgeCards.find((item) => item.kind === "overview") ?? null;
  const keyPointCards = knowledgeCards.filter((item) => item.kind === "key-point");
  const chapterCards = knowledgeCards.filter((item) => item.kind === "chapter");
  const chapterGroups = useMemo(
    () => buildChapterGroups(chapterCards, selectedResult, { chapterAnchor: isAggregateSummaryView ? "page" : "time" }),
    [chapterCards, isAggregateSummaryView, selectedResult],
  );
  const areAllChapterGroupsExpanded = chapterGroups.length > 0 && expandedChapterGroupIds.length === chapterGroups.length;
  const selectedKnowledgeNoteMarkdown = useMemo(() => resolveKnowledgeNoteMarkdown(selectedResult), [selectedResult]);
  const selectedVisualEvidence = selectedTaskId ? visualEvidence[selectedTaskId] ?? null : null;
  const selectedVisualEvidenceStatus = selectedVisualEvidence?.status || selectedTaskDetail?.result?.visual_note_status || "idle";
  const selectedEnhancedNoteMarkdown = selectedVisualEvidence?.enhanced_note_markdown || selectedVisualEvidence?.visual_note_markdown || "";
  const hasEnhancedKnowledgeNote = Boolean(selectedEnhancedNoteMarkdown.trim());
  const effectiveKnowledgeNoteViewMode: KnowledgeNoteViewMode = knowledgeNoteViewMode === "visual" && hasEnhancedKnowledgeNote ? "visual" : "text";

  useEffect(() => {
    if (!hasEnhancedKnowledgeNote && knowledgeNoteViewMode === "visual") {
      setKnowledgeNoteViewMode("text");
    }
  }, [hasEnhancedKnowledgeNote, knowledgeNoteViewMode]);
  const displayedKnowledgeNoteMarkdown = effectiveKnowledgeNoteViewMode === "visual"
    ? selectedEnhancedNoteMarkdown
    : selectedKnowledgeNoteMarkdown;
  const knowledgeNoteModeLabel = effectiveKnowledgeNoteViewMode === "visual" ? "图文" : "纯文本";
  const visualKnowledgeNoteUnavailableText = selectedVisualEvidenceStatus === "generating"
    ? "图文笔记生成中，完成后可选"
    : "当前任务没有图文笔记";
  const visualEvidenceFrames = useMemo(
    () => buildVisualEvidenceItems(selectedTaskId, selectedVisualEvidence),
    [selectedTaskId, selectedVisualEvidence],
  );
  const canExportSelectedKnowledgeNote = useMemo(() => canExportKnowledgeNote(selectedTaskDetail), [selectedTaskDetail]);
  const selectedTranscript = selectedResult?.transcript_text ?? "";
  const canExportSelectedTranscript = Boolean(
    selectedTaskDetail?.status === "completed"
      && (selectedTranscript.trim() || selectedResult?.artifacts?.transcript_path),
  );
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
  const canRegenerateVisualNote = Boolean(
    selectedTaskId
    && selectedTaskStatus === "completed"
    && selectedResult?.knowledge_note_markdown?.trim()
    && !isAggregateSummaryView
    && selectedVisualEvidenceStatus !== "generating"
    && !visualEvidenceLoading[selectedTaskId],
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
    {
      id: "content",
      label: "当前查看",
      value: isAggregateSummaryView ? "全集总结" : currentPage ? `P${currentPage.page}` : selectedTaskCode ? `任务 ${selectedTaskCode}` : "暂无任务",
      mono: true,
    },
  ];
  const batchCompletionCount = pageBatchSummary.completed;
  const batchProgressPercent = pageBatchSummary.total > 0
    ? Math.max(0, Math.min(100, Math.round((batchCompletionCount / pageBatchSummary.total) * 100)))
    : 0;
  const playerDescriptor = useMemo(
    () => isAggregateSummaryView ? null : buildPlayerEmbedDescriptor(currentPage?.source_url || video?.source_url),
    [currentPage?.source_url, isAggregateSummaryView, video?.source_url],
  );
  const playerEmbedUrl = useMemo(() => {
    if (!playerDescriptor) {
      return null;
    }
    return playerDescriptor.embedUrl;
  }, [playerDescriptor]);

  const directMediaKey = video && !isAggregateSummaryView
    ? `${video.video_id}:${effectivePageNumber ?? 1}`
    : "";
  const selectedDirectMedia = directMediaKey ? directMediaStatus[directMediaKey] ?? null : null;
  const shakaManifestUrl = selectedDirectMedia?.available
    && selectedDirectMedia.mode === "split"
    && selectedDirectMedia.stream_url
    ? selectedDirectMedia.stream_url
    : null;
  const directPlayerUrl = selectedDirectMedia?.available && (selectedDirectMedia.mode === "direct" || selectedDirectMedia.mode === "muxed")
    ? selectedDirectMedia.stream_url
    : null;
  const directMediaDebugLabel = selectedDirectMedia
    ? [
        `mode=${selectedDirectMedia.mode}`,
        selectedDirectMedia.format_id ? `format=${selectedDirectMedia.format_id}` : null,
        selectedDirectMedia.width && selectedDirectMedia.height ? `${selectedDirectMedia.width}x${selectedDirectMedia.height}` : null,
        selectedDirectMedia.vcodec ? `v=${selectedDirectMedia.vcodec}` : null,
        selectedDirectMedia.acodec ? `a=${selectedDirectMedia.acodec}` : null,
      ].filter(Boolean).join(" / ")
    : "direct-media=pending";

  useEffect(() => {
    if (activeTab !== "captions" || !video || isAggregateSummaryView || String(video.platform || "").toLowerCase() !== "bilibili" || !directMediaKey) {
      return;
    }
    if (directMediaProbeKeysRef.current.has(directMediaKey) && directMediaStatus[directMediaKey]) {
      return;
    }
    directMediaProbeKeysRef.current.add(directMediaKey);
    let cancelled = false;
    void api.getVideoDirectMediaStatus(video.video_id, effectivePageNumber)
      .then((response) => {
        if (!cancelled) {
          setDirectMediaStatus((current) => ({ ...current, [directMediaKey]: response }));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setDirectMediaStatus((current) => ({
            ...current,
            [directMediaKey]: {
              available: false,
              mode: "unavailable",
              stream_url: "",
              reason: error instanceof Error ? error.message : "底层流探测失败",
            },
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, directMediaKey, directMediaStatus, effectivePageNumber, isAggregateSummaryView, video]);

  useEffect(() => {
    setBilibiliBrowserViewReady(false);
    setBilibiliBrowserViewFailed(false);
  }, [playerEmbedUrl]);

  const localPlayerUrl = useMemo(() => {
    if (!video || String(video.platform || "").toLowerCase() !== "local") {
      return null;
    }
    if (isAggregateSummaryView) {
      return null;
    }
    const source = currentPage?.source_url || video.source_url;
    const suffix = (() => {
      try {
        return `.${new URL(source, window.location.origin).pathname.split(".").pop()?.toLowerCase() || ""}`;
      } catch {
        const parts = String(source || "").split(".");
        return parts.length > 1 ? `.${parts[parts.length - 1].toLowerCase()}` : "";
      }
    })();
    return LOCAL_VIDEO_SUFFIXES.has(suffix) ? `/api/v1/videos/${video.video_id}/media` : null;
  }, [currentPage?.source_url, isAggregateSummaryView, video]);
  const captionNativePlayerUrl = localPlayerUrl || directPlayerUrl;
  const usesDirectBilibiliCaptionPlayer = Boolean(directPlayerUrl || shakaManifestUrl);
  const hasSeekablePlayer = Boolean(
    localPlayerUrl
    || (activeTab === "captions" && (directPlayerUrl || shakaManifestUrl))
    || (playerDescriptor && playerDescriptor.platform !== "bilibili")
  );
  const selectedSegments = selectedTaskId ? taskSegments[selectedTaskId] ?? [] : [];
  const selectedSegmentAccuracy = selectedTaskId ? taskSegmentAccuracy[selectedTaskId] ?? "unknown" : "unknown";
  const usesApproximateSegmentTiming = selectedSegmentAccuracy === "approximate" || selectedSegmentAccuracy === "mixed";
  const selectedSegmentsLoading = Boolean(selectedTaskId && taskSegmentsLoading[selectedTaskId]);
  const selectedSegmentsError = selectedTaskId ? taskSegmentsErrors[selectedTaskId] ?? "" : "";
  const useBilibiliBrowserView = false;
  const bilibiliBrowserViewOccluded = Boolean(
    taskPanelState === "expanded"
    || actionMenuOpen
    || pageMenuOpen
    || knowledgeNoteExportMenuOpen
    || knowledgeNoteModeMenuOpen
    || cookieHelpDialogOpen
    || jumpConfirmPopover?.open
    || batchDialogOpen
  );

  useEffect(() => {
    bilibiliBrowserViewOccludedRef.current = bilibiliBrowserViewOccluded;
  }, [bilibiliBrowserViewOccluded]);

  useEffect(() => {
    if (!useBilibiliBrowserView || !playerEmbedUrl || activeTab !== "captions") {
      void window.desktop?.bilibiliPlayer?.hide?.().catch(() => undefined);
      return;
    }

    let cancelled = false;
    let frame = 0;

    function readBounds() {
      const slot = captionBrowserViewSlotRef.current;
      if (!slot) {
        return null;
      }
      const rect = slot.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      if (visibleWidth < 20 || visibleHeight < 20) {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
      return {
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: rect.width,
        height: rect.height,
      };
    }

    function syncBounds() {
      if (cancelled) {
        return;
      }
      const bounds = readBounds();
      if (!bounds || !window.desktop?.bilibiliPlayer) {
        return;
      }
      if (bilibiliBrowserViewOccludedRef.current) {
        void window.desktop.bilibiliPlayer.setBounds({ x: 0, y: 0, width: 0, height: 0 }).catch(() => undefined);
        return;
      }
      void window.desktop.bilibiliPlayer.setBounds(bounds).catch(() => undefined);
    }

    async function showView() {
      const bounds = readBounds();
      if (!bounds || !playerEmbedUrl || !window.desktop?.bilibiliPlayer) {
        return;
      }
      try {
        await window.desktop.bilibiliPlayer.show({ url: playerEmbedUrl, bounds });
        if (bilibiliBrowserViewOccludedRef.current) {
          await window.desktop.bilibiliPlayer.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        }
        if (!cancelled) {
          setBilibiliBrowserViewReady(true);
          setBilibiliBrowserViewFailed(false);
        }
      } catch (error) {
        if (!cancelled) {
          setBilibiliBrowserViewReady(false);
          setBilibiliBrowserViewFailed(true);
          const message = error instanceof Error ? error.message : "";
          setStatus(
            /No handler registered.*desktop:bilibili-player:show/i.test(message)
              ? "需要重启桌面端以启用 B 站 BrowserView 播放器，当前已回退普通播放器。"
              : message || "B 站播放器加载失败，已回退普通播放器。",
          );
        }
      }
    }

    function scheduleSync() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncBounds);
    }

    void showView();
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("scroll", scheduleSync, true);
    const timer = window.setInterval(syncBounds, 600);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("scroll", scheduleSync, true);
      window.clearInterval(timer);
      void window.desktop?.bilibiliPlayer?.hide?.().catch(() => undefined);
    };
  }, [activeTab, playerEmbedUrl, useBilibiliBrowserView]);

  useEffect(() => {
    if (!useBilibiliBrowserView || !bilibiliBrowserViewReady || activeTab !== "captions" || !window.desktop?.bilibiliPlayer?.setBounds) {
      return;
    }
    if (bilibiliBrowserViewOccluded) {
      void window.desktop.bilibiliPlayer.setBounds({ x: 0, y: 0, width: 0, height: 0 }).catch(() => undefined);
      return;
    }
    const slot = captionBrowserViewSlotRef.current;
    if (!slot) {
      return;
    }
    const rect = slot.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    if (visibleWidth < 20 || visibleHeight < 20) {
      void window.desktop.bilibiliPlayer.setBounds({ x: 0, y: 0, width: 0, height: 0 }).catch(() => undefined);
      return;
    }
    void window.desktop.bilibiliPlayer.setBounds({
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: rect.width,
      height: rect.height,
    }).catch(() => undefined);
  }, [activeTab, bilibiliBrowserViewOccluded, bilibiliBrowserViewReady, useBilibiliBrowserView]);

  useEffect(() => {
    if (!useBilibiliBrowserView || !bilibiliBrowserViewReady || activeTab !== "captions") {
      return;
    }
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy || bilibiliBrowserViewOccludedRef.current || !window.desktop?.bilibiliPlayer?.getSnapshot) {
        return;
      }
      busy = true;
      void window.desktop.bilibiliPlayer.getSnapshot()
        .then((snapshot) => {
          if (snapshot?.ok && typeof snapshot.currentTime === "number" && Number.isFinite(snapshot.currentTime)) {
            handleCaptionTimeUpdate(snapshot.currentTime);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, 500);
    return () => window.clearInterval(timer);
  }, [activeTab, bilibiliBrowserViewReady, useBilibiliBrowserView, selectedSegments]);

  useEffect(() => {
    if (activeCaptionIndex == null || !activeCaptionRowRef.current || !captionListRef.current) {
      return;
    }
    const row = activeCaptionRowRef.current;
    const list = captionListRef.current;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    const viewportTop = list.scrollTop;
    const viewportBottom = viewportTop + list.clientHeight;
    if (rowTop < viewportTop + 12 || rowBottom > viewportBottom - 12) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeCaptionIndex]);

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
  const liveProgressPhases = useMemo(() => buildProgressPhases(liveProgress.filtered), [liveProgress.filtered]);
  const liveProgressFocusPhase = liveProgressPhases.find((phase) => phase.tone === "failed")
    ?? [...liveProgressPhases].reverse().find((phase) => phase.tone === "active")
    ?? liveProgressPhases.at(-1)
    ?? null;
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
    () => (
      readyMindMapRoot
        ? buildMindMapFlow(readyMindMapRoot, selectedMindMapNodeId, isAggregateSummaryView ? "page" : "time")
        : { nodes: [], edges: [] }
    ),
    [isAggregateSummaryView, readyMindMapRoot, selectedMindMapNodeId],
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
    if (seconds == null) {
      return;
    }
    setPlayerSeekTarget((current) => ({ nonce: current.nonce + 1, seconds }));

    const activeLocalVideo = activeTab === "captions" ? captionLocalVideoRef.current : localVideoRef.current;
    const activeIframe = activeTab === "captions" ? captionPlayerIframeRef.current : playerIframeRef.current;
    if (localPlayerUrl && activeLocalVideo) {
      activeLocalVideo.currentTime = seconds;
      void activeLocalVideo.play().catch(() => {});
    } else if (activeTab === "captions" && (directPlayerUrl || shakaManifestUrl) && activeLocalVideo) {
      activeLocalVideo.currentTime = seconds;
      void activeLocalVideo.play().catch(() => {});
    } else if (playerDescriptor && activeIframe && playerDescriptor.platform !== "bilibili") {
      postPlayerSeek(activeIframe, playerDescriptor.platform, seconds);
    } else if (playerDescriptor?.platform === "bilibili") {
      return;
    } else if (!playerDescriptor && !localPlayerUrl) {
      return;
    }

    if (activeTab === "knowledge") {
      playerFrameRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (activeTab === "captions") {
      captionPlayerFrameRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  async function seekBilibiliBrowserView(seconds: number | null) {
    if (seconds == null) {
      return false;
    }
    if (!window.desktop?.bilibiliPlayer?.seek) {
      return false;
    }
    try {
      const result = await window.desktop.bilibiliPlayer.seek(seconds);
      if (typeof result === "object" && result && "ok" in result && !Boolean((result as { ok?: unknown }).ok)) {
        setStatus("B 站播放器暂未暴露可控制的视频节点，已保留外部打开入口。");
        return false;
      }
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "B 站播放器跳转失败");
      return false;
    }
  }

  function handleCaptionTimeUpdate(currentSeconds: number) {
    if (!selectedSegments.length) {
      setActiveCaptionIndex(null);
      return;
    }
    const nextIndex = selectedSegments.findIndex((segment, index) => {
      const nextStart = selectedSegments[index + 1]?.start ?? Number.POSITIVE_INFINITY;
      const end = segment.end > segment.start ? segment.end : nextStart;
      return currentSeconds >= segment.start && currentSeconds < end;
    });
    setActiveCaptionIndex(nextIndex >= 0 ? nextIndex : null);
  }

  function handleJumpToPageSummary(event: React.MouseEvent, pageNumber: number | null) {
    if (pageNumber == null) {
      return;
    }
    const page = availablePages.find((item) => item.page === pageNumber);
    if (!page) {
      setStatus(`没有找到 P${pageNumber} 对应的分 P。`);
      return;
    }
    // 在点击位置显示确认悬浮窗
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setJumpConfirmPopover({
      open: true,
      pageNumber,
      title: page.title,
      x: rect.left + rect.width / 2,
      y: rect.bottom + 8,
    });
  }

  function handleConfirmJump() {
    if (!jumpConfirmPopover) return;
    setSelectedPageNumber(jumpConfirmPopover.pageNumber);
    setActiveTab("knowledge");
    setPageMenuOpen(false);
    setJumpConfirmPopover(null);
    setStatus(`已跳转到 P${jumpConfirmPopover.pageNumber}「${jumpConfirmPopover.title}」`);
  }

  function handleCancelJump() {
    setJumpConfirmPopover(null);
  }

  function handleDismissJumpPopover() {
    setJumpConfirmPopover(null);
  }

  // 点击页面其他地方关闭悬浮窗
  useEffect(() => {
    if (!jumpConfirmPopover?.open) return;

    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest('.jump-confirm-popover') && !target.closest('[data-jump-anchor]')) {
        setJumpConfirmPopover(null);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [jumpConfirmPopover?.open]);

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

  async function handleGenerateVisualNote(force = false) {
    if (!selectedTaskId) {
      return;
    }
    setActiveTab("summary");
    setKnowledgeNoteViewMode("visual");
    setStatus(force ? "已发起重新生成图文笔记..." : "已发起生成图文笔记...");
    try {
      const response = await triggerVisualNoteGeneration(selectedTaskId, { force });
      await ensureTaskContext(selectedTaskId, { force: true }).catch(() => undefined);
      if (response.status === "ready" || response.status === "partial") {
        setStatus("图文笔记已更新");
        return;
      }
      setStatus(force ? "正在重新生成图文笔记..." : "正在生成图文笔记...");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "图文笔记生成失败");
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

  async function handleCreateAggregateSummary() {
    if (!video) {
      return;
    }
    setActionMenuOpen(false);
    setActionMenuSection(null);
    setStatus("正在创建全集总结任务...");
    try {
      const response = await api.createAggregateSummaryTask(video.video_id);
      setSelectedPageNumber(AGGREGATE_SUMMARY_PAGE_NUMBER);
      await refreshDetail({
        forceTaskIds: [response.task_id],
        preferredTaskId: response.task_id,
        syncLibrary: true,
      });
      setStatus("已开始生成全集总结");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "全集总结创建失败");
    }
  }

  async function handleSubmitBatchAction(input: { pageNumbers: number[]; confirm: boolean }): Promise<VideoTaskBatchResponse> {
    if (!video) {
      throw new Error("当前视频信息不可用，请稍后重试。");
    }

    setStatus(
      batchDialogMode === "create"
        ? (input.confirm ? "正在确认批量生成..." : "正在创建批量生成任务...")
        : (input.confirm ? "正在确认批量重生成..." : "正在准备批量重生成..."),
    );

    const response = batchDialogMode === "create"
      ? await api.createVideoTasksBatch(video.video_id, {
        page_numbers: input.pageNumbers,
        confirm: input.confirm,
      })
      : await api.resummarizeVideoTasksBatch(video.video_id, {
        page_numbers: input.pageNumbers,
        confirm: input.confirm,
      });

    if (response.requires_confirmation) {
      setStatus(
        batchDialogMode === "create"
          ? `所选内容中有 ${response.conflict_pages.length} 个分 P 已有成功摘要，确认后会默认跳过。`
          : `所选内容中有 ${response.conflict_pages.length} 个分 P 将复用已有转写重新生成摘要，请确认继续。`,
      );
      return response;
    }

    await refreshDetail({ preferredTaskId: null, syncLibrary: true });
    setBatchDialogOpen(false);
    const createdCount = response.created_tasks.length;
    const skippedCount = response.skipped_pages.length;
    setStatus(
      batchDialogMode === "create"
        ? (createdCount > 0
          ? `已创建 ${createdCount} 个批量任务${skippedCount ? `，跳过 ${skippedCount} 个分 P` : ""}`
          : `没有创建新任务${skippedCount ? `，已跳过 ${skippedCount} 个分 P` : ""}`)
        : (createdCount > 0
          ? `已发起 ${createdCount} 个批量重生成任务${skippedCount ? `，跳过 ${skippedCount} 个分 P` : ""}`
          : `没有创建新的重生成任务${skippedCount ? `，已跳过 ${skippedCount} 个分 P` : ""}`),
    );
    return response;
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

  async function handleExportKnowledgeNote(target: "markdown" | "obsidian" = "obsidian") {
    if (!selectedTaskId || isExportingKnowledgeNote) {
      return;
    }
    setIsExportingKnowledgeNote(true);
    setKnowledgeNoteExportMenuOpen(false);
    setStatus(target === "obsidian" ? "正在导出 Obsidian 笔记..." : "正在导出 Markdown 笔记...");
    try {
      const pickedDirectory = await window.desktop?.dialog?.pickDirectory?.(knowledgeOutputDir || undefined);
      if (window.desktop?.dialog && !pickedDirectory) {
        setStatus("已取消导出。");
        return;
      }
      const response = await api.exportTaskMarkdown(selectedTaskId, {
        target,
        include_transcript: includeTranscriptInNoteExport,
        output_dir: pickedDirectory || undefined,
      });
      setLastKnowledgeExport(response);
      setKnowledgeOutputDir((current) => current || response.directory);
      await refreshDetail({ preferredTaskId: selectedTaskId, forceTaskIds: [selectedTaskId] });
      setStatus(`已导出到 ${response.file_name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导出 Markdown 失败");
    } finally {
      setIsExportingKnowledgeNote(false);
    }
  }

  async function handleExportTranscript() {
    if (!selectedTaskId || isExportingTranscript) {
      return;
    }
    setIsExportingTranscript(true);
    setStatus("正在导出转写文本...");
    try {
      const pickedDirectory = await window.desktop?.dialog?.pickDirectory?.(knowledgeOutputDir || undefined);
      if (window.desktop?.dialog && !pickedDirectory) {
        setStatus("已取消导出。");
        return;
      }
      const response = await api.exportTaskTranscript(selectedTaskId, { output_dir: pickedDirectory || undefined });
      setLastKnowledgeExport(response);
      setKnowledgeOutputDir((current) => current || response.directory);
      await refreshDetail({ preferredTaskId: selectedTaskId, forceTaskIds: [selectedTaskId] });
      setStatus(`已导出到 ${response.file_name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "导出转写文本失败");
    } finally {
      setIsExportingTranscript(false);
    }
  }

  async function handleOpenKnowledgeExportDirectory() {
    if (!window.desktop?.shell || !lastKnowledgeExport?.directory) {
      return;
    }
    const result = await window.desktop.shell.openPath(lastKnowledgeExport.directory);
    if (result) {
      throw new Error(result);
    }
  }

  return (
    <section className="video-detail-page">
      <FloatingNoticeStack notices={[{ id: "video-detail-status", message: status }]} />
      <CookieHelpDialog
        isOpen={cookieHelpDialogOpen}
        onClose={() => setCookieHelpDialogOpen(false)}
        onOpenTutorial={openCookieExportTutorial}
        onOpenSettings={openYtdlpCookieSettings}
        onCaptureLoginCookies={captureLoginCookies}
      />

      {/* 分 P 跳转确认悬浮窗 */}
      {jumpConfirmPopover?.open && (
        <div
          className="jump-confirm-popover"
          role="dialog"
          aria-modal="true"
          style={{
            left: jumpConfirmPopover.x,
            top: jumpConfirmPopover.y,
            transform: 'translateX(-50%)',
          }}
        >
          <div className="jump-confirm-popover-arrow" aria-hidden="true"></div>
          <div className="jump-confirm-popover-content">
            <p className="jump-confirm-popover-message">
              跳转到 P{jumpConfirmPopover.pageNumber}「{jumpConfirmPopover.title}」？
            </p>
            <div className="jump-confirm-popover-actions">
              <button className="jump-confirm-popover-cancel" onClick={handleCancelJump} type="button">
                取消
              </button>
              <button className="jump-confirm-popover-ok" onClick={handleConfirmJump} type="button">
                跳转
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="detail-page-shell">
        <div className="detail-page-toolbar">
          <Link className="detail-back-button" to="/library">
            <IconChevronLeft className="detail-back-icon" />
            返回视频库
          </Link>
        </div>

        <article className={`video-detail-hero ${pageBatchSummary.total > 0 ? "has-page-batch" : "is-single-page"}`}>
          <div className="video-detail-media">
            {canOpenLocalSource ? (
              <button
                className="video-detail-cover video-detail-cover-button"
                type="button"
                onClick={() => void handleOpenLocalSource().catch((error) => {
                  setStatus(error instanceof Error ? error.message : "打开本地视频失败");
                })}
              >
                {(currentPage?.cover_url || video.cover_url) ? <img src={currentPage?.cover_url || video.cover_url} alt={currentPage ? `P${currentPage.page} ${video.title}` : video.title} loading="lazy" /> : <div className="video-detail-cover-placeholder">VIDEO</div>}
                <div className="video-detail-cover-overlay">
                  <IconPlayCircle className="video-detail-play-icon" />
                </div>
                <div className="detail-duration-badge">{formatDuration(currentPage?.duration ?? video.duration)}</div>
              </button>
            ) : isLocalVideo ? (
              <div className="video-detail-cover">
                {(currentPage?.cover_url || video.cover_url) ? <img src={currentPage?.cover_url || video.cover_url} alt={currentPage ? `P${currentPage.page} ${video.title}` : video.title} loading="lazy" /> : <div className="video-detail-cover-placeholder">VIDEO</div>}
                <div className="detail-duration-badge">{formatDuration(currentPage?.duration ?? video.duration)}</div>
              </div>
            ) : (
              <a className="video-detail-cover" href={heroSourceTarget} target="_blank" rel="noreferrer">
                {(currentPage?.cover_url || video.cover_url) ? <img src={currentPage?.cover_url || video.cover_url} alt={currentPage ? `P${currentPage.page} ${video.title}` : video.title} loading="lazy" /> : <div className="video-detail-cover-placeholder">VIDEO</div>}
                <div className="video-detail-cover-overlay">
                  <IconPlayCircle className="video-detail-play-icon" />
                </div>
                <div className="detail-duration-badge">{formatDuration(currentPage?.duration ?? video.duration)}</div>
              </a>
            )}
          </div>

          <div className="video-detail-copy">
            <div className="video-detail-copy-main">
              <div className="detail-hero-meta-row">
                <span className={`detail-status-badge ${taskStatusClass(liveStatus)}`}>{taskStatusLabel(liveStatus)}</span>
                <span className="detail-hero-meta-time">{formatDateTime(video.updated_at)}</span>
                {pageBatchSummary.total > 0 ? <span className="detail-hero-meta-time">共 {pageBatchSummary.total} P</span> : null}
              </div>

              <h2 className="video-detail-title">{video.title}</h2>
              {availablePages.length ? (
                <div className={`detail-page-switcher ${pageMenuOpen ? "is-open" : ""}`} ref={pageSwitcherRef}>
                  <span className="detail-page-switcher-label">当前内容</span>
                  <button
                    className="detail-page-select"
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={pageMenuOpen}
                    onClick={() => setPageMenuOpen((current) => !current)}
                  >
                    <span className="detail-page-select-value">
                      {isAggregateSummaryView ? "全集总结" : currentPage?.title || "选择分 P"}
                      {currentPage && pageGeneratedMap.get(currentPage.page) ? <span className="detail-page-select-check">✓</span> : null}
                      {isAggregateSummaryView && aggregateSummaryTasks.some((task) => task.status === "completed") ? <span className="detail-page-select-check">✓</span> : null}
                    </span>
                    <IconChevronDown className="detail-page-select-caret" />
                  </button>
                  {pageMenuOpen ? (
                    <div className="detail-page-menu">
                      <div className="detail-page-menu-scroll" role="listbox" aria-label="选择当前分 P">
                        {canShowAggregateSummaryOption ? (
                          <button
                            className={`detail-page-option ${isAggregateSummaryView ? "is-selected" : ""}`}
                            role="option"
                            aria-selected={isAggregateSummaryView}
                            type="button"
                            onClick={() => {
                              setSelectedPageNumber(AGGREGATE_SUMMARY_PAGE_NUMBER);
                              setPageMenuOpen(false);
                            }}
                          >
                            <span className={`detail-page-option-check ${isAggregateSummaryView ? "is-selected" : ""}`}>{isAggregateSummaryView ? "✓" : ""}</span>
                            <span className="detail-page-option-copy">
                              <strong>全集总结</strong>
                              {aggregateSummaryTasks.length ? <small>已有 {aggregateSummaryTasks.length} 个版本</small> : <small>可基于已完成分 P 生成</small>}
                            </span>
                          </button>
                        ) : null}
                        {availablePages.map((page) => {
                          const selected = page.page === effectivePageNumber;
                          const generated = pageGeneratedMap.get(page.page);
                          return (
                            <button
                              className={`detail-page-option ${selected ? "is-selected" : ""} ${generated ? "has-summary" : "is-unavailable"}`}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              key={page.page}
                              onClick={() => {
                                setSelectedPageNumber(page.page);
                                setPageMenuOpen(false);
                              }}
                            >
                              <span className={`detail-page-option-check ${selected ? "is-selected" : ""}`}>{selected ? "✓" : ""}</span>
                              <span className="detail-page-option-copy">
                                <strong>{page.title}</strong>
                                {generated ? <small>已生成摘要</small> : <small>尚未生成</small>}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="detail-task-float" ref={taskPopoverRef}>
              <div className={`detail-hero-capsule ${taskStatusClass(liveStatus)} ${taskPanelState === "expanded" ? "is-expanded" : ""}`}>
                <div className="detail-hero-capsule-grid">
                  <div className="detail-hero-capsule-item">
                    <span className="detail-hero-stat-label">{heroStats[0].label}</span>
                    <div className="detail-hero-stat-value">
                      <strong className={heroStats[0].mono ? "detail-hero-stat-mono" : ""}>{heroStats[0].value}</strong>
                    </div>
                  </div>
                  <button
                    aria-label={taskPanelState === "expanded" ? "收起任务详情与历史" : "展开任务详情与历史"}
                    aria-expanded={taskPanelState === "expanded"}
                    className={`detail-hero-capsule-item detail-task-detail-trigger ${taskPanelState === "expanded" ? "is-open" : ""}`}
                    title={taskPanelState === "expanded" ? "收起任务详情与历史" : "任务详情与历史"}
                    type="button"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setTaskPanelState((current) => current === "expanded" ? "collapsed" : "expanded");
                    }}
                  >
                    <span className="detail-hero-stat-label detail-task-detail-label">
                      {heroStats[1].label}
                      <IconChevronDown className="detail-action-caret" />
                    </span>
                    <div className="detail-hero-stat-value">
                      <strong className={heroStats[1].mono ? "detail-hero-stat-mono" : ""}>{heroStats[1].value}</strong>
                    </div>
                  </button>
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
                      onClick={() => {
                        setActionMenuOpen((current) => {
                          const nextOpen = !current;
                          if (!nextOpen) {
                            setActionMenuSection(null);
                          }
                          return nextOpen;
                        });
                      }}
                    >
                      <IconSettings className="detail-action-icon" />
                      <IconChevronDown className="detail-action-caret" />
                    </button>

                    {actionMenuOpen ? (
                      <div className="detail-action-popover" role="menu" aria-label="视频操作设置">
                        <button
                          className={`detail-action-menu-item detail-action-menu-group ${actionMenuSection === "regenerate" ? "is-open" : ""}`}
                          role="menuitem"
                          type="button"
                          onClick={() => setActionMenuSection((current) => current === "regenerate" ? null : "regenerate")}
                        >
                          <span className="detail-action-menu-item-icon" aria-hidden="true">
                            <IconRegenerateAction className="detail-action-icon" />
                          </span>
                          <span className="detail-action-menu-copy">
                            <strong>重新生成</strong>
                          </span>
                          <IconChevronDown className="detail-action-caret" />
                        </button>

                          <div className={`detail-action-submenu ${actionMenuSection === "regenerate" ? "is-open" : ""}`} role="group" aria-label="重新生成操作" aria-hidden={actionMenuSection !== "regenerate"}>
                            <button
                              className="detail-action-subitem"
                              role="menuitem"
                              type="button"
                              tabIndex={actionMenuSection === "regenerate" ? 0 : -1}
                              disabled={!canResummarize}
                              onClick={async () => {
                                setActionMenuOpen(false);
                                setActionMenuSection(null);
                                setStatus("正在基于当前版本重新生成摘要...");
                                await api.resummarizeVideoTask(video.video_id, {
                                  task_id: selectedTaskIdRef.current,
                                  page_number: effectivePageNumber,
                                });
                                await refreshDetail({ preferredTaskId: null, syncLibrary: true });
                                setStatus("已开始新的摘要生成任务");
                              }}
                            >
                              <IconSummaryRefresh className="detail-action-icon" />
                              <span>重跑文本笔记</span>
                            </button>
                            <button
                              className="detail-action-subitem"
                              role="menuitem"
                              type="button"
                              tabIndex={actionMenuSection === "regenerate" ? 0 : -1}
                              disabled={!canRegenerateVisualNote}
                              onClick={async () => {
                                setActionMenuOpen(false);
                                setActionMenuSection(null);
                                await handleGenerateVisualNote(true);
                              }}
                            >
                              <IconCopyImage className="detail-action-icon" />
                              <span>重跑图文笔记</span>
                            </button>
                            <button
                              className="detail-action-subitem"
                              role="menuitem"
                              type="button"
                              tabIndex={actionMenuSection === "regenerate" ? 0 : -1}
                              disabled={!selectedTaskId || selectedTaskStatus !== "completed" || Boolean(selectedTaskId && mindMapLoading[selectedTaskId])}
                              onClick={async () => {
                                setActionMenuOpen(false);
                                setActionMenuSection(null);
                                await handleGenerateMindMap(true);
                              }}
                            >
                              <IconMindMap className="detail-action-icon" />
                              <span>重跑思维导图</span>
                            </button>
                            <button
                              className="detail-action-subitem"
                              role="menuitem"
                              type="button"
                              tabIndex={actionMenuSection === "regenerate" ? 0 : -1}
                              disabled={isAggregateSummaryView}
                              onClick={async () => {
                                setActionMenuOpen(false);
                                setActionMenuSection(null);
                                setStatus("正在重新转写并生成摘要...");
                                const visualNoteMode = loadKnowledgeNoteViewMode() === "visual" ? "frame_insert" : "text";
                                await api.createVideoTask(video.video_id, { page_number: effectivePageNumber, visual_note_mode: visualNoteMode });
                                await refreshDetail({ preferredTaskId: null, syncLibrary: true });
                                setStatus("已开始新的转写摘要任务");
                              }}
                            >
                              <IconTranscriptRefresh className="detail-action-icon" />
                              <span>重新转写并生成</span>
                            </button>
                          </div>

                        <button
                          className={`detail-action-menu-item detail-action-menu-group ${actionMenuSection === "batch" ? "is-open" : ""}`}
                          role="menuitem"
                          type="button"
                          disabled={pageBatchOptions.length === 0}
                          onClick={() => setActionMenuSection((current) => current === "batch" ? null : "batch")}
                        >
                          <span className="detail-action-menu-item-icon" aria-hidden="true">
                            <IconBatchProcess className="detail-action-icon" />
                          </span>
                          <span className="detail-action-menu-copy">
                            <strong>批量处理</strong>
                          </span>
                          <IconChevronDown className="detail-action-caret" />
                        </button>

                          <div className={`detail-action-submenu ${actionMenuSection === "batch" ? "is-open" : ""}`} role="group" aria-label="批量处理操作" aria-hidden={actionMenuSection !== "batch"}>
                            <button
                              className="detail-action-subitem"
                              role="menuitem"
                              type="button"
                              tabIndex={actionMenuSection === "batch" ? 0 : -1}
                              onClick={() => {
                                setActionMenuOpen(false);
                                setActionMenuSection(null);
                                setBatchDialogMode("create");
                                setBatchDialogOpen(true);
                              }}
                            >
                              <IconTranscriptRefresh className="detail-action-icon" />
                              <span>批量生成摘要</span>
                            </button>
                            <button
                              className="detail-action-subitem"
                              role="menuitem"
                              type="button"
                              tabIndex={actionMenuSection === "batch" ? 0 : -1}
                              onClick={() => {
                                setActionMenuOpen(false);
                                setActionMenuSection(null);
                                setBatchDialogMode("resummary");
                                setBatchDialogOpen(true);
                              }}
                            >
                              <IconSummaryRefresh className="detail-action-icon" />
                              <span>批量重生成摘要</span>
                            </button>
                            <button
                              className="detail-action-subitem"
                              role="menuitem"
                              type="button"
                              tabIndex={actionMenuSection === "batch" ? 0 : -1}
                              disabled={!canCreateAggregateSummary}
                              onClick={() => void handleCreateAggregateSummary()}
                            >
                              <IconFileText className="detail-action-icon" />
                              <span>生成全集总结</span>
                            </button>
                          </div>

                        <button
                          className={`detail-action-menu-item detail-action-menu-group ${actionMenuSection === "maintenance" ? "is-open" : ""}`}
                          role="menuitem"
                          type="button"
                          onClick={() => setActionMenuSection((current) => current === "maintenance" ? null : "maintenance")}
                        >
                          <span className="detail-action-menu-item-icon" aria-hidden="true">
                            <IconMaintenanceTools className="detail-action-icon" />
                          </span>
                          <span className="detail-action-menu-copy">
                            <strong>更多维护</strong>
                          </span>
                          <IconChevronDown className="detail-action-caret" />
                        </button>

                          <div className={`detail-action-submenu ${actionMenuSection === "maintenance" ? "is-open" : ""}`} role="group" aria-label="维护操作" aria-hidden={actionMenuSection !== "maintenance"}>
                            <button
                              className="detail-action-subitem"
                              role="menuitem"
                              type="button"
                              tabIndex={actionMenuSection === "maintenance" ? 0 : -1}
                              onClick={async () => {
                                setActionMenuOpen(false);
                                setActionMenuSection(null);
                                setStatus("正在刷新视频信息...");
                                await api.probeVideo({ url: video.source_url, force_refresh: true });
                                await refreshDetail({ preferredTaskId: selectedTaskIdRef.current, syncLibrary: true });
                                setStatus("视频信息已刷新");
                              }}
                            >
                              <IconRefresh className="detail-action-icon" />
                              <span>刷新视频信息</span>
                            </button>
                          </div>
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
                                    <strong>{liveProgress.failedEvent ? "需要关注" : liveProgress.isCompleted ? "主任务已完成" : "当前进度"}</strong>
                                    <span>{liveProgressFocusPhase ? `${liveProgressFocusPhase.label} · ${liveProgressFocusPhase.events.length} 条` : `${liveProgress.filtered.length} 条进度记录`}</span>
                                  </div>
                                  <span className="progress-stage-toggle">查看阶段树</span>
                                </summary>
                                <div className="progress-phase-view">
                                  {liveProgressFocusPhase ? (
                                    <article className={`progress-focus-card tone-${liveProgressFocusPhase.tone}`}>
                                      <span>{liveProgressFocusPhase.tone === "failed" ? "异常阶段" : liveProgress.isCompleted ? "完成概览" : "当前阶段"}</span>
                                      <strong>{liveProgressFocusPhase.label}</strong>
                                      <small>{liveProgressFocusPhase.events.at(-1)?.message || liveMessage}</small>
                                    </article>
                                  ) : null}
                                  <div className="progress-phase-tree">
                                    {liveProgressPhases.map((phase) => (
                                      <article className={`progress-phase-group tone-${phase.tone}`} key={phase.id}>
                                        <div className="progress-phase-head">
                                          <strong>{phase.label}</strong>
                                          <span>{phase.events.filter(isProgressEventCompleted).length}/{phase.events.length}</span>
                                        </div>
                                        <div className="progress-stage-list progress-stage-tree">
                                          {phase.events.map((event, index) => (
                                            <article className={`progress-event-card ${progressEventClass(event.stage)}`} key={event.event_id}>
                                              <div className="progress-event-node" aria-hidden="true" />
                                              <div className="progress-event-copy">
                                                <div className="progress-event-topline">
                                                  <strong>{event.message} <span className="progress-event-count">({index + 1}/{phase.events.length})</span></strong>
                                                  <span>{formatDateTime(event.created_at)}</span>
                                                </div>
                                                <div className="progress-event-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={event.progress} aria-label={`${stageLabel(event.stage)}阶段进度`}>
                                                  <span style={{ width: `${event.progress}%` }} />
                                                </div>
                                                <div className="progress-event-meta">{stageLabel(event.stage)} · {event.progress}%</div>
                                              </div>
                                            </article>
                                          ))}
                                        </div>
                                      </article>
                                    ))}
                                  </div>
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
                                        {taskPageLabel(task) ? <span className="helper-chip">{taskPageLabel(task)}</span> : null}
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

          {pageBatchSummary.total > 0 ? (
            <div className="detail-batch-side" aria-label="批量任务统计" ref={batchSideRef}>
              <div className="progress-bar-simple detail-batch-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={batchProgressPercent} aria-label="批量完成进度">
                <div className="progress-fill-simple success" style={{ width: `${batchProgressPercent}%` }} />
              </div>
              <div className="detail-batch-inline-meta">
                <div className="detail-batch-inline-copy">
                  <span>{batchCompletionCount} / {pageBatchSummary.total}</span>
                  <small>
                    进行中 {pageBatchSummary.inProgress} · 未开始 {pageBatchSummary.notStarted}
                    {pageBatchSummary.failed ? ` · 失败 ${pageBatchSummary.failed}` : ""}
                  </small>
                </div>
              </div>
            </div>
          ) : null}
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
                <TaskStatePanel cookieHelpActions={cookieHelpActions} state={contentState} />
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
                      {localPlayerUrl ? (
                        <div className="detail-overview-player" ref={playerFrameRef}>
                          <div className="detail-section-heading">
                            <h3 className="detail-section-label">Player</h3>
                            <span className="detail-section-meta detail-section-link">
                              本地视频播放器
                            </span>
                          </div>
                          <div className="detail-video-embed-frame">
                            <video
                              ref={localVideoRef}
                              className="detail-video-embed detail-local-video"
                              controls
                              preload="metadata"
                              src={localPlayerUrl}
                              poster={currentPage?.cover_url || video.cover_url || undefined}
                            />
                            <div className="detail-video-export-mask" aria-hidden="true">
                              {currentPage?.cover_url || video.cover_url ? (
                                <img className="detail-video-export-cover" src={currentPage?.cover_url || video.cover_url} alt="" />
                              ) : (
                                <div className="detail-video-export-mask-copy">
                                  <strong>{video.title}</strong>
                                  <span>导出知识卡片时会保留当前视频封面，不直接导出播放器画面。</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : playerEmbedUrl && playerDescriptor ? (
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
                              ref={playerIframeRef}
                              referrerPolicy="strict-origin-when-cross-origin"
                              scrolling="no"
                              src={playerEmbedUrl}
                              title={`${video.title} 播放器`}
                            />
                            <div className="detail-video-export-mask" aria-hidden="true">
                              {currentPage?.cover_url || video.cover_url ? (
                                <img className="detail-video-export-cover" src={currentPage?.cover_url || video.cover_url} alt="" />
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
                                      onJumpToPage={isAggregateSummaryView ? handleJumpToPageSummary : undefined}
                                      onSeekToTimestamp={!isAggregateSummaryView && hasSeekablePlayer ? handleSeekToChapter : undefined}
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
                <TaskStatePanel cookieHelpActions={cookieHelpActions} state={contentState} />
              ) : (
                <section className="detail-tab-panel">
                  <section className="detail-content-section">
                    <div className="detail-section-heading">
                      <h3 className="detail-section-label">Knowledge Note</h3>
                      <div className="detail-section-heading-actions">
                        <span className="detail-section-meta">完整学习视图 · {knowledgeNoteModeLabel}</span>
                        <div className="detail-section-menu" ref={knowledgeNoteModeMenuRef}>
                          <button
                            className={`detail-section-icon-button detail-section-menu-trigger ${knowledgeNoteModeMenuOpen ? "is-open" : ""}`}
                            type="button"
                            onClick={() => setKnowledgeNoteModeMenuOpen((current) => !current)}
                            aria-haspopup="menu"
                            aria-expanded={knowledgeNoteModeMenuOpen}
                            aria-label="选择知识笔记显示形式"
                            title="笔记形式"
                          >
                            {effectiveKnowledgeNoteViewMode === "visual" ? <IconCopyImage /> : <IconFileText />}
                            <IconChevronDown className="detail-section-menu-caret" />
                          </button>
                          {knowledgeNoteModeMenuOpen ? (
                            <div className="detail-section-popover detail-note-mode-popover" role="menu" aria-label="知识笔记显示形式">
                              <button
                                className={`detail-section-menu-item detail-note-mode-option ${effectiveKnowledgeNoteViewMode === "visual" ? "is-selected" : ""}`}
                                type="button"
                                role="menuitemradio"
                                aria-checked={effectiveKnowledgeNoteViewMode === "visual"}
                                disabled={!hasEnhancedKnowledgeNote}
                                onClick={() => {
                                  if (!hasEnhancedKnowledgeNote) {
                                    return;
                                  }
                                  setKnowledgeNoteViewMode("visual");
                                  setKnowledgeNoteModeMenuOpen(false);
                                }}
                              >
                                <span className="detail-section-menu-item-icon" aria-hidden="true">
                                  <IconCopyImage />
                                </span>
                                <span className="detail-section-menu-copy">
                                  <strong>图文</strong>
                                  <small>{hasEnhancedKnowledgeNote ? "显示带图片的整合笔记" : visualKnowledgeNoteUnavailableText}</small>
                                </span>
                              </button>
                              <button
                                className={`detail-section-menu-item detail-note-mode-option ${effectiveKnowledgeNoteViewMode === "text" ? "is-selected" : ""}`}
                                type="button"
                                role="menuitemradio"
                                aria-checked={effectiveKnowledgeNoteViewMode === "text"}
                                onClick={() => {
                                  setKnowledgeNoteViewMode("text");
                                  setKnowledgeNoteModeMenuOpen(false);
                                }}
                              >
                                <span className="detail-section-menu-item-icon" aria-hidden="true">
                                  <IconFileText />
                                </span>
                                <span className="detail-section-menu-copy">
                                  <strong>纯文本</strong>
                                  <small>显示基础知识笔记正文</small>
                                </span>
                              </button>
                            </div>
                          ) : null}
                        </div>
                        <div className="detail-section-menu" ref={knowledgeNoteExportMenuRef}>
                          <button
                            className={`detail-section-icon-button detail-section-menu-trigger ${knowledgeNoteExportMenuOpen ? "is-open" : ""}`}
                            type="button"
                            disabled={!canExportSelectedKnowledgeNote || isExportingKnowledgeNote}
                            onClick={() => setKnowledgeNoteExportMenuOpen((current) => !current)}
                            aria-haspopup="menu"
                            aria-expanded={knowledgeNoteExportMenuOpen}
                            aria-label={isExportingKnowledgeNote ? "正在导出 Obsidian 笔记" : "导出知识笔记"}
                            title={isExportingKnowledgeNote ? "正在导出 Obsidian 笔记" : "导出知识笔记"}
                          >
                            <IconExportNote />
                            <IconChevronDown className="detail-section-menu-caret" />
                          </button>
                          {knowledgeNoteExportMenuOpen ? (
                            <div className="detail-section-popover" role="menu" aria-label="知识笔记导出设置">
                              <button
                                className="detail-section-menu-item"
                                type="button"
                                role="menuitem"
                                disabled={!canExportSelectedKnowledgeNote || isExportingKnowledgeNote}
                                onClick={() => void handleExportKnowledgeNote("obsidian")}
                              >
                                <span className="detail-section-menu-item-icon" aria-hidden="true">
                                  <IconExportNote />
                                </span>
                                <span className="detail-section-menu-copy">
                                  <strong>{isExportingKnowledgeNote ? "正在导出..." : "导出到 Obsidian"}</strong>
                                  <small>选择目录后写入 Markdown 笔记</small>
                                </span>
                              </button>
                              <label className="detail-section-menu-check" role="menuitemcheckbox" aria-checked={includeTranscriptInNoteExport}>
                                <input
                                  type="checkbox"
                                  checked={includeTranscriptInNoteExport}
                                  onChange={(event) => setIncludeTranscriptInNoteExport(event.target.checked)}
                                />
                                <span>导出笔记时附带转写全文</span>
                              </label>
                            </div>
                          ) : null}
                        </div>
                        {lastKnowledgeExport?.directory && window.desktop?.shell ? (
                          <button
                            className="detail-section-icon-button"
                            type="button"
                            onClick={() => void handleOpenKnowledgeExportDirectory().catch((error) => {
                              setStatus(error instanceof Error ? error.message : "打开导出目录失败");
                            })}
                            aria-label="打开导出目录"
                            title="打开导出目录"
                          >
                            <IconFolderOpen />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <h4 className="detail-section-title">知识笔记</h4>
                    {!knowledgeOutputDir && !window.desktop?.dialog ? (
                      <p className="detail-section-body">导出前请先在设置中填写输出目录，Markdown / Obsidian 笔记会写入该目录。</p>
                    ) : null}
                    {displayedKnowledgeNoteMarkdown ? (
                      <MarkdownContent
                        className="detail-note-markdown"
                        content={displayedKnowledgeNoteMarkdown}
                        imageResolver={(src) => resolveVisualNoteImageSrc(selectedTaskId, src)}
                      />
                    ) : (
                      <p className="detail-section-body">当前任务还没有生成知识笔记。</p>
                    )}
                    <details className="detail-visual-assets-details detail-note-assets-details">
                      <summary>
                        <span>查看图片素材记录</span>
                        <small>{formatVisualEvidenceStatus(selectedVisualEvidenceStatus, visualEvidenceFrames.length, selectedVisualEvidence?.insert_count ?? 0)}</small>
                      </summary>
                      <VisualEvidencePanel
                        frames={visualEvidenceFrames}
                        status={selectedVisualEvidenceStatus}
                        errorMessage={selectedVisualEvidence?.error_message || selectedTaskDetail?.result?.visual_note_error_message || ""}
                        loading={Boolean(selectedTaskId && visualEvidenceLoading[selectedTaskId])}
                        onSeekToTimestamp={!isAggregateSummaryView && hasSeekablePlayer ? handleSeekToChapter : undefined}
                      />
                    </details>
                  </section>

                  <section className="detail-content-section">
                    <div className="detail-section-heading">
                      <h3 className="detail-section-label">Transcript</h3>
                      <div className="detail-section-heading-actions">
                        <span className="detail-section-meta">{selectedTranscript ? "原始转写" : "暂无内容"}</span>
                        <button
                          className="detail-section-icon-button"
                          type="button"
                          disabled={!canExportSelectedTranscript || isExportingTranscript}
                          onClick={() => void handleExportTranscript()}
                          aria-label={isExportingTranscript ? "正在导出转写文本" : "导出转写文本"}
                          title={isExportingTranscript ? "正在导出转写文本" : "导出转写文本"}
                        >
                          <IconExportNote />
                        </button>
                      </div>
                    </div>
                    <pre className="transcript-full">{selectedTranscript || "暂无转写全文。"}</pre>
                  </section>

                </section>
              )
            ) : null}

            {activeTab === "captions" ? (
              contentState ? (
                <TaskStatePanel cookieHelpActions={cookieHelpActions} state={contentState} />
              ) : (
                <section className="detail-tab-panel detail-caption-panel">
                  <section className="detail-content-section detail-caption-player-section" ref={captionPlayerFrameRef}>
                    <div className="detail-section-heading">
                      <h3 className="detail-section-label">Dynamic Captions</h3>
                      <div className="detail-section-heading-actions">
                        <span className="detail-section-meta">
                          {selectedSegmentsLoading
                            ? "加载字幕中"
                            : `${selectedSegments.length} 条字幕 · ${
                              selectedSegmentAccuracy === "exact"
                                ? "精确时间轴"
                                : usesApproximateSegmentTiming
                                  ? "估算时间轴"
                                  : "时间轴来源未知"
                            }`}
                        </span>
                        {selectedTaskId ? (
                          <button
                            className="detail-section-icon-button"
                            type="button"
                            disabled={selectedSegmentsLoading}
                            onClick={() => void loadTaskSegments(selectedTaskId, { force: true })}
                            aria-label="刷新动态字幕"
                            title="刷新动态字幕"
                          >
                            <IconRefresh />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="detail-caption-workspace">
                      <div className="detail-caption-player">
                        {captionNativePlayerUrl || shakaManifestUrl ? (
                          <div className="detail-video-embed-frame">
                            {shakaManifestUrl ? (
                              <ShakaMediaPlayer
                                audioUrl={selectedDirectMedia?.audio_url || undefined}
                                className="detail-video-embed detail-local-video"
                                manifestUrl={shakaManifestUrl}
                                onTimeUpdate={handleCaptionTimeUpdate}
                                poster={currentPage?.cover_url || video.cover_url || undefined}
                                videoRef={captionLocalVideoRef}
                                videoUrl={selectedDirectMedia?.video_url || undefined}
                              />
                            ) : (
                              <video
                                ref={captionLocalVideoRef}
                                className="detail-video-embed detail-local-video"
                                controls
                                preload="metadata"
                                src={captionNativePlayerUrl || undefined}
                                poster={currentPage?.cover_url || video.cover_url || undefined}
                                onTimeUpdate={(event) => handleCaptionTimeUpdate(event.currentTarget.currentTime)}
                              />
                            )}
                          </div>
                        ) : playerEmbedUrl && playerDescriptor ? (
                          <div className="detail-video-embed-frame">
                            {useBilibiliBrowserView ? (
                              <div
                                className="detail-video-embed detail-bilibili-browser-view-slot"
                                ref={captionBrowserViewSlotRef}
                                aria-label={`${video.title} Bilibili 播放器`}
                              >
                                {!bilibiliBrowserViewReady ? (
                                  <span>正在加载 B 站播放器...</span>
                                ) : null}
                              </div>
                            ) : (
                              <iframe
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                                allowFullScreen
                                className="detail-video-embed"
                                ref={captionPlayerIframeRef}
                                referrerPolicy="strict-origin-when-cross-origin"
                                scrolling="no"
                                src={playerEmbedUrl}
                                title={`${video.title} 动态字幕播放器`}
                              />
                            )}
                          </div>
                        ) : (
                          <div className="empty-placeholder">当前视频没有可用播放器。</div>
                        )}
                        {playerDescriptor?.platform === "bilibili" ? (
                          <p className="detail-caption-player-note">
                            {usesDirectBilibiliCaptionPlayer
                              ? shakaManifestUrl
                                ? `正在使用 Shaka DASH 播放器，可在应用内拖动进度并跟踪动态字幕。${directMediaDebugLabel}`
                                : `正在使用 Bilibili 底层流播放器，可在应用内拖动进度并跟踪动态字幕。${directMediaDebugLabel}`
                              : useBilibiliBrowserView
                              ? bilibiliBrowserViewReady
                                ? "桌面端正在使用 BrowserView B 站播放器。若站点改版导致跳转失败，可使用字幕行右侧入口外部打开。"
                                : "B 站播放器正在加载，若失败会自动回退到普通播放器。"
                              : selectedDirectMedia?.reason
                                ? `底层流未启用：${selectedDirectMedia.reason}`
                                : "B 站外链播放器不支持可靠的应用内时间跳转。点击字幕行右侧入口可在 Bilibili 打开对应时间点。"}
                          </p>
                        ) : null}
                        {usesApproximateSegmentTiming ? (
                          <p className="detail-caption-timing-note">
                            当前转写接口只返回全文文本，字幕时间由文本长度按音频时长估算，可能与实际播放进度有偏差。需要更准同步时请在设置里切换到本地 ASR 后重新转写。
                          </p>
                        ) : null}
                      </div>
                      <div className="detail-caption-list" role="list" aria-label="动态字幕列表" ref={captionListRef}>
                        {selectedSegmentsError ? (
                          <div className="empty-placeholder">{selectedSegmentsError}</div>
                        ) : selectedSegmentsLoading && !selectedSegments.length ? (
                          <div className="empty-placeholder">正在加载动态字幕...</div>
                        ) : selectedSegments.length ? (
                          selectedSegments.map((segment, index) => (
                            <div
                              className={`detail-caption-row ${activeCaptionIndex === index ? "is-active" : ""}`}
                              key={`${segment.start}-${index}`}
                              ref={activeCaptionIndex === index ? activeCaptionRowRef : null}
                              role="listitem"
                            >
                              <button
                                className="detail-caption-main"
                                type="button"
                                onClick={() => {
                                  setActiveCaptionIndex(index);
                                  if (useBilibiliBrowserView) {
                                    void seekBilibiliBrowserView(segment.start);
                                    return;
                                  }
                                  handleSeekToChapter(segment.start);
                                }}
                              >
                                <span className="detail-caption-time">{formatDuration(segment.start)}</span>
                                <span className="detail-caption-copy">{segment.text || "..."}</span>
                              </button>
                              {playerDescriptor?.platform === "bilibili" ? (
                                <a
                                  className="detail-caption-open-link"
                                  href={buildTimestampedSourceUrl(playerDescriptor.sourceUrl, segment.start)}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={() => setActiveCaptionIndex(index)}
                                >
                                  打开
                                </a>
                              ) : null}
                            </div>
                          ))
                        ) : (
                          <div className="empty-placeholder">当前任务还没有可展示的时间轴字幕。</div>
                        )}
                      </div>
                    </div>
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
                              {isAggregateSummaryView && shouldDisplayMindMapTimestamp(selectedMindMapNode.time_anchor) ? (
                                <button
                                  className="detail-mindmap-seek-button"
                                  type="button"
                                  data-jump-anchor
                                  onClick={(event) => handleJumpToPageSummary(event, Math.round(selectedMindMapNode.time_anchor ?? 0))}
                                >
                                  <IconArrowRight className="detail-mindmap-seek-icon" />
                                  查看 P{Math.round(selectedMindMapNode.time_anchor ?? 0)} 总结
                                </button>
                              ) : shouldDisplayMindMapTimestamp(selectedMindMapNode.time_anchor) && hasSeekablePlayer ? (
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
                                  const canJumpToPage = isAggregateSummaryView && shouldDisplayMindMapTimestamp(timestamp);
                                  const canSeek = !isAggregateSummaryView && shouldDisplayMindMapTimestamp(timestamp) && hasSeekablePlayer;
                                  const anchorLabel = canJumpToPage
                                    ? `P${Math.round(timestamp!)}`
                                    : shouldDisplayMindMapTimestamp(timestamp)
                                      ? formatDuration(timestamp!)
                                      : "";
                                  const label = `${title}${anchorLabel ? ` · ${anchorLabel}` : ""}`;

                                  if (canJumpToPage || canSeek) {
                                    return (
                                      <button
                                        className="detail-mindmap-inspector-tag is-action"
                                        key={`${title}-${index}`}
                                        type="button"
                                        onClick={(event) => (
                                          canJumpToPage
                                            ? handleJumpToPageSummary(event, Math.round(timestamp!))
                                            : handleSeekToChapter(timestamp)
                                        )}
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
                                <div className="progress-stage-list progress-stage-tree">
                                  {mindMapProgress.events.map((event, index) => (
                                    <article className={`progress-event-card ${progressEventClass(event.stage)}`} key={event.event_id}>
                                      <div className="progress-event-node" aria-hidden="true" />
                                      <div className="progress-event-copy">
                                        <div className="progress-event-topline">
                                          <strong>{event.message} <span className="progress-event-count">({index + 1}/{mindMapProgress.events.length})</span></strong>
                                          <time>{formatDateTime(event.created_at)}</time>
                                        </div>
                                        <div className="progress-event-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={event.progress} aria-label={`${stageLabel(event.stage)}阶段进度`}>
                                          <span style={{ width: `${event.progress}%` }} />
                                        </div>
                                        <div className="progress-event-meta">{stageLabel(event.stage)} · {event.progress}%</div>
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

            <MultiPageSelectDialog
              isOpen={batchDialogOpen}
              mode={batchDialogMode}
              video={video}
              pages={pageBatchOptions}
              onClose={() => setBatchDialogOpen(false)}
              onSubmit={handleSubmitBatchAction}
            />

            {(activeTab === "summary" || activeTab === "mindmap") && (localPlayerUrl || (playerEmbedUrl && playerDescriptor)) ? (
              <FloatingVideoPlayer
                embedUrl={playerEmbedUrl}
                localVideoUrl={localPlayerUrl}
                openLabel={playerDescriptor?.openLabel}
                platform={playerDescriptor?.platform}
                poster={currentPage?.cover_url || video.cover_url || undefined}
                sourceUrl={playerDescriptor?.sourceUrl}
                seekTarget={playerSeekTarget}
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
  onJumpToPage,
  onSeekToTimestamp,
}: {
  card: KnowledgeCard;
  index: number;
  onJumpToPage?: (event: React.MouseEvent, pageNumber: number | null) => void;
  onSeekToTimestamp?: (seconds: number | null) => void;
}) {
  if (card.kind === "chapter") {
    const canSeek = typeof card.timestampSeconds === "number" && Boolean(onSeekToTimestamp);
    const canJumpToPage = typeof card.pageNumber === "number" && Boolean(onJumpToPage);
    const isActionable = canSeek || canJumpToPage;
    const chapterCardBody = (
      <div className="detail-chapter-node-shell">
        <span className="detail-chapter-node-dot" aria-hidden="true" />
        <div className="detail-chapter-node-meta">
          <div className="detail-chapter-time">
            {card.anchorLabel ? <IconFileText className="detail-inline-icon" /> : <IconClock className="detail-inline-icon" />}
            <span>{card.anchorLabel || (card.timestampSeconds != null ? formatDuration(card.timestampSeconds) : "--")}</span>
          </div>
        </div>
        <div className="detail-chapter-node-copy">
          <h4>{card.title}</h4>
          <MarkdownContent className="detail-card-markdown" compact content={card.content} />
        </div>
        {isActionable ? (
          <div className="detail-card-link">
            {canJumpToPage ? "查看分 P 总结" : "定位片段"}
            <IconArrowRight className="detail-inline-icon" />
          </div>
        ) : null}
      </div>
    );

    if (isActionable) {
      return (
        <button
          className="detail-chapter-node detail-chapter-node-action"
          type="button"
          data-jump-anchor
          onClick={(event) => {
            if (canJumpToPage) {
              onJumpToPage!(event, card.pageNumber ?? null);
              return;
            }
            onSeekToTimestamp!(card.timestampSeconds ?? null);
          }}
        >
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

type VisualEvidenceItem = {
  key: string;
  timestampSeconds: number;
  timestampLabel: string;
  imageUrl: string;
  caption: string;
  ocrText: string;
  scene: string;
};

function buildVisualEvidenceItems(taskId: string | null, response: TaskVisualEvidenceResponse | null): VisualEvidenceItem[] {
  if (!taskId || !response?.context?.observations?.length) {
    return [];
  }
  const framesById = new Map<string, VisualEvidenceFrame>();
  for (const frame of response.context.frames ?? []) {
    if (frame.frame_id) {
      framesById.set(frame.frame_id, frame);
    }
  }
  return response.context.observations
    .map((observation: VisualEvidenceObservation) => {
      const frame = framesById.get(observation.frame_id);
      const fileName = frame?.file_name || `${observation.frame_id}.jpg`;
      return {
        key: `${observation.frame_id}-${observation.timestamp_seconds}`,
        timestampSeconds: observation.timestamp_seconds,
        timestampLabel: formatDuration(observation.timestamp_seconds),
        imageUrl: `/api/v1/tasks/${taskId}/visual-evidence/media/${encodeURIComponent(fileName)}`,
        caption: observation.caption || "关键画面截图",
        ocrText: observation.ocr_text || "",
        scene: observation.scene || "",
      };
    })
    .filter((item) => Number.isFinite(item.timestampSeconds));
}

function formatVisualEvidenceStatus(status: string, frameCount: number, insertCount = 0): string {
  if (status === "generating") {
    return "生成中";
  }
  if (status === "ready") {
    return insertCount > 0 ? `${insertCount} 处插图 · ${frameCount} 张图` : `${frameCount} 张图`;
  }
  if (status === "partial") {
    return frameCount ? `${frameCount} 张，部分降级` : "部分降级";
  }
  if (status === "unsupported") {
    return "当前输入不支持";
  }
  if (status === "failed") {
    return "生成失败";
  }
  return "按需生成";
}

function resolveVisualNoteImageSrc(taskId: string | null, src: string): string {
  if (!taskId) {
    return src;
  }
  const normalized = src.startsWith("visual://")
    ? src.replace("visual://", "").trim()
    : src.startsWith("frames/")
      ? src.replace(/^frames\//, "").trim()
      : "";
  if (!normalized) {
    return src;
  }
  const frameId = normalized.replace(/\.jpg$/i, "");
  if (!frameId || frameId.includes("/") || frameId.includes("\\")) {
    return src;
  }
  const suffixMatch = normalized.match(/\.(jpe?g|png|webp)$/i);
  const mediaFileName = suffixMatch ? normalized : `${frameId}.jpg`;
  return `/api/v1/tasks/${taskId}/visual-evidence/media/${encodeURIComponent(mediaFileName)}`;
}

function VisualEvidencePanel({
  frames,
  status,
  errorMessage,
  loading,
  onSeekToTimestamp,
}: {
  frames: VisualEvidenceItem[];
  status: string;
  errorMessage?: string;
  loading: boolean;
  onSeekToTimestamp?: (seconds: number | null) => void;
}) {
  if (frames.length) {
    return (
      <div className="detail-visual-grid">
        {frames.map((frame) => (
          <article className="detail-visual-card" key={frame.key}>
            <img alt={`${frame.timestampLabel} ${frame.caption}`} src={frame.imageUrl} loading="lazy" />
            <div className="detail-visual-card-copy">
              <div className="detail-visual-card-head">
                {onSeekToTimestamp ? (
                  <button type="button" onClick={() => onSeekToTimestamp(frame.timestampSeconds)}>
                    {frame.timestampLabel}
                  </button>
                ) : (
                  <span>{frame.timestampLabel}</span>
                )}
                {frame.scene ? <small>{frame.scene}</small> : null}
              </div>
              <strong>{frame.caption}</strong>
              {frame.ocrText ? <p>画面文字：{frame.ocrText}</p> : null}
            </div>
          </article>
        ))}
      </div>
    );
  }
  const message = loading || status === "generating"
    ? "正在后台生成图文笔记，完成后会自动刷新。"
    : status === "unsupported"
      ? (errorMessage || "音频或纯文本任务没有可截图的视频画面。")
    : status === "failed"
        ? (errorMessage || "图文笔记生成失败，可以稍后重试。")
        : "还没有生成图文笔记。";
  return <p className="detail-section-body">{message}</p>;
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

function buildMindMapFlow(
  root: MindMapNode,
  selectedNodeId: string | null,
  anchorMode: "time" | "page" = "time",
): { nodes: FlowNode<MindMapFlowNodeData>[]; edges: Edge[] } {
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
        pageAnchorLabel: anchorMode === "page" && shouldDisplayMindMapTimestamp(item.node.time_anchor)
          ? `P${Math.round(item.node.time_anchor ?? 0)}`
          : undefined,
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
        {data.pageAnchorLabel ? (
          <small>{data.pageAnchorLabel}</small>
        ) : shouldDisplayMindMapTimestamp(data.timeAnchor) ? (
          <small>{formatDuration(data.timeAnchor)}</small>
        ) : null}
      </div>
    </div>
  );
}

const mindMapNodeTypes = {
  mindmap: MindMapFlowNode,
};

function FloatingVideoPlayer({
  audioUrl,
  embedUrl,
  localVideoUrl,
  manifestUrl,
  openLabel,
  platform,
  poster,
  sourceUrl,
  seekTarget,
  title,
  videoUrl,
}: {
  audioUrl?: string;
  embedUrl: string | null;
  localVideoUrl: string | null;
  manifestUrl?: string | null;
  openLabel?: string | null;
  platform?: SupportedVideoPlatform | null;
  poster?: string;
  sourceUrl?: string | null;
  seekTarget: PlayerSeekTarget;
  title: string;
  videoUrl?: string;
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
  const localFloatingVideoRef = useRef<HTMLVideoElement | null>(null);
  const floatingIframeRef = useRef<HTMLIFrameElement | null>(null);

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

  useEffect(() => {
    if (seekTarget.seconds == null) {
      return;
    }
    if ((localVideoUrl || manifestUrl) && localFloatingVideoRef.current) {
      localFloatingVideoRef.current.currentTime = seekTarget.seconds;
      void localFloatingVideoRef.current.play().catch(() => {});
      return;
    }
    if (platform && platform !== "bilibili" && floatingIframeRef.current) {
      postPlayerSeek(floatingIframeRef.current, platform, seekTarget.seconds);
    }
  }, [localVideoUrl, manifestUrl, platform, seekTarget]);

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
        {sourceUrl && openLabel ? (
          <a
            className="detail-floating-player-link"
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {openLabel}
          </a>
        ) : null}
      </div>
      <div className="detail-video-embed-frame detail-video-embed-frame-floating">
        {manifestUrl ? (
          <ShakaMediaPlayer
            audioUrl={audioUrl}
            className="detail-video-embed detail-local-video"
            manifestUrl={manifestUrl}
            poster={poster}
            videoRef={localFloatingVideoRef}
            videoUrl={videoUrl}
          />
        ) : localVideoUrl ? (
          <video
            ref={localFloatingVideoRef}
            className="detail-video-embed detail-local-video"
            controls
            preload="metadata"
            src={localVideoUrl}
            poster={poster}
          />
        ) : embedUrl ? (
          <iframe
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            allowFullScreen
            className="detail-video-embed"
            ref={floatingIframeRef}
            referrerPolicy="strict-origin-when-cross-origin"
            scrolling="no"
            src={embedUrl}
            title={`${title} 悬浮播放器`}
          />
        ) : null}
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

function TaskStatePanel({
  cookieHelpActions,
  state,
}: {
  cookieHelpActions?: { onOpenTutorial(): void; onOpenSettings(): void } | null;
  state: NonNullable<ReturnType<typeof describeTaskContentState>>;
}) {
  return (
    <section className={`detail-state-panel tone-${state.tone}`} role="status">
      <div className="detail-state-copy">
        <h3 className="detail-section-label">Workspace State</h3>
        <h4 className="detail-section-title">{state.title}</h4>
        <p className="detail-section-body">{state.description}</p>
        {state.detail ? <pre className="detail-state-detail">{state.detail}</pre> : null}
        {cookieHelpActions ? (
          <div className="detail-state-actions">
            <button className="secondary-button" type="button" onClick={cookieHelpActions.onOpenTutorial}>
              打开导出教程
            </button>
            <button className="primary-button" type="button" onClick={cookieHelpActions.onOpenSettings}>
              前往 Cookies 设置
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function DetailTabIcon({ active, tab }: { active: boolean; tab: DetailTab }) {
  const className = `detail-tab-icon ${active ? "is-active" : ""}`;
  if (tab === "knowledge") {
    return <IconSparkles className={className} />;
  }
  if (tab === "summary") {
    return <IconFileText className={className} />;
  }
  if (tab === "captions") {
    return <IconTranscriptRefresh className={className} />;
  }
  return <IconMindMap className={className} />;
}

function IconChevronLeft(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function IconChevronDown(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function IconPlayCircle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z" />
      <circle cx="12" cy="12" r="10" />
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
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function IconRefresh(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function IconFileText(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  );
}

function IconSummaryRefresh(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M16 22h2a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v2.85" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M8 14v2.2l1.6 1" />
      <circle cx="8" cy="16" r="6" />
    </svg>
  );
}

function IconRegenerateAction(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M16 22h2a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v2.85" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
      <path d="M8 14v2.2l1.6 1" />
      <circle cx="8" cy="16" r="6" />
    </svg>
  );
}

function IconBatchProcess(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M13 5h8" />
      <path d="M13 12h8" />
      <path d="M13 19h8" />
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
    </svg>
  );
}

function IconMaintenanceTools(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
    </svg>
  );
}

function IconTranscriptRefresh(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M2 10v3" />
      <path d="M6 6v11" />
      <path d="M10 3v18" />
      <path d="M14 8v7" />
      <path d="M18 5v13" />
      <path d="M22 10v3" />
    </svg>
  );
}

function IconSettings(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
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

function IconExportNote(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
    </svg>
  );
}

function IconFolderOpen(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function IconCopyImage(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16" />
      <path d="M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2" />
      <circle cx="13" cy="7" r="1" fill="currentColor" stroke="none" />
      <rect width="14" height="14" x="8" y="2" rx="2" />
    </svg>
  );
}

function IconSparkles(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
      <path d="M20 2v4" />
      <path d="M22 4h-4" />
      <circle cx="4" cy="20" r="2" />
    </svg>
  );
}

function IconMindMap(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="12" cy="18" r="3" />
      <path d="M6 9v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9" />
      <path d="M12 12v3" />
    </svg>
  );
}

function IconArrowRight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" {...props}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}
