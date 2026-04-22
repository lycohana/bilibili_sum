export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type PageAggregateStatus = "not_started" | "in_progress" | "completed" | "failed";

export type TimelineItem = {
  title?: string;
  start?: number;
  summary?: string;
};

export type ChapterGroupItem = {
  title?: string;
  start?: number;
  summary?: string;
  children?: TimelineItem[];
};

export type TaskMindMapStatus = "idle" | "generating" | "ready" | "failed";

export type MindMapNode = {
  id: string;
  label: string;
  type: "root" | "theme" | "topic" | "leaf";
  summary: string;
  children: MindMapNode[];
  time_anchor?: number | null;
  source_chapter_titles: string[];
  source_chapter_starts: number[];
};

export type TaskMindMap = {
  version: number;
  title: string;
  root: string;
  nodes: MindMapNode[];
};

export type TaskResult = {
  overview: string;
  knowledge_note_markdown?: string;
  transcript_text: string;
  segment_summaries: string[];
  key_points: string[];
  timeline: TimelineItem[];
  chapter_groups?: ChapterGroupItem[];
  artifacts: Record<string, string>;
  llm_prompt_tokens?: number | null;
  llm_completion_tokens?: number | null;
  llm_total_tokens?: number | null;
  mindmap_status?: TaskMindMapStatus;
  mindmap_error_message?: string | null;
  mindmap_artifact_path?: string | null;
  mindmap_updated_at?: string | null;
};

export type VideoAssetSummary = {
  video_id: string;
  canonical_id: string;
  platform: string;
  title: string;
  source_url: string;
  cover_url: string;
  duration?: number | null;
  latest_task_id?: string | null;
  latest_status?: TaskStatus | null;
  latest_stage?: string | null;
  has_result: boolean;
  is_favorite: boolean;
  favorite_updated_at?: string | null;
  pages: VideoPageOption[];
  created_at: string;
  updated_at: string;
};

export type VideoPageOption = {
  page: number;
  title: string;
  source_url: string;
  cover_url: string;
  duration?: number | null;
};

export type VideoPageBatchOption = VideoPageOption & {
  aggregate_status?: PageAggregateStatus;
  latest_task_status?: TaskStatus | null;
  latest_task_updated_at?: string | null;
  has_completed_result?: boolean;
};

export type VideoAssetDetail = VideoAssetSummary & {
  latest_result?: TaskResult | null;
  latest_error_message?: string | null;
};

export type VideoProbeResult = {
  video: VideoAssetSummary;
  cached: boolean;
  requires_selection: boolean;
  pages: VideoPageOption[];
};

export type TaskSummary = {
  task_id: string;
  video_id?: string | null;
  status: TaskStatus;
  input_type: string;
  source: string;
  title?: string | null;
  page_number?: number | null;
  page_title?: string | null;
  created_at: string;
  updated_at: string;
  llm_total_tokens?: number | null;
  task_duration_seconds?: number | null;
};

export type TaskDetail = TaskSummary & {
  result?: TaskResult | null;
  error_code?: string | null;
  error_message?: string | null;
};

export type VideoTaskBatchOperation = "create" | "resummary";
export type VideoTaskBatchPageAction = "skip" | "rerun";

export type VideoTaskBatchPageResult = {
  page_number: number;
  page_title?: string | null;
  action: VideoTaskBatchPageAction;
  reason?: string | null;
  existing_task_id?: string | null;
  existing_status?: TaskStatus | null;
  has_existing_result: boolean;
  task?: TaskDetail | null;
};

export type VideoTaskBatchRequest = {
  page_numbers: number[];
  confirm?: boolean;
};

export type VideoTaskBatchResponse = {
  operation: VideoTaskBatchOperation;
  requested_page_numbers: number[];
  requires_confirmation: boolean;
  created_tasks: TaskDetail[];
  skipped_pages: VideoTaskBatchPageResult[];
  conflict_pages: VideoTaskBatchPageResult[];
};

export type TaskMindMapResponse = {
  task_id: string;
  status: TaskMindMapStatus;
  error_message?: string | null;
  updated_at?: string | null;
  mindmap?: TaskMindMap | null;
};

export type TaskMarkdownExportTarget = "markdown" | "obsidian";

export type TaskMarkdownExportResponse = {
  task_id: string;
  target_format: TaskMarkdownExportTarget;
  path: string;
  directory: string;
  file_name: string;
  overwritten: boolean;
  artifact_key: string;
};

export type TaskEvent = {
  event_id: string;
  task_id: string;
  stage: string;
  progress: number;
  message: string;
  created_at: string;
  payload: Record<string, unknown>;
};

export type EnvironmentInfo = {
  pythonVersion?: string;
  torchInstalled?: boolean;
  torchVersion?: string;
  cudaAvailable?: boolean;
  gpuName?: string;
  ytDlpVersion?: string;
  localAsrInstalled?: boolean;
  localAsrAvailable?: boolean;
  localAsrVersion?: string;
  chromadbInstalled?: boolean;
  chromadbVersion?: string;
  sentenceTransformersInstalled?: boolean;
  sentenceTransformersVersion?: string;
  knowledgeDependenciesReady?: boolean;
  ffmpegLocation?: string;
  recommendedModel?: string;
  recommendedDevice?: string;
  runtimeChannel?: string;
  runtimeReady?: boolean;
  runtimePython?: string;
  runtimeError?: string;
};

export type ServiceSettings = {
  host: string;
  port: number;
  data_dir: string;
  cache_dir: string;
  tasks_dir: string;
  database_url: string;
  transcription_provider: string;
  whisper_model: string;
  whisper_device: string;
  whisper_compute_type: string;
  device_preference: string;
  compute_type: string;
  model_mode: string;
  fixed_model: string;
  siliconflow_asr_base_url: string;
  siliconflow_asr_model: string;
  siliconflow_asr_api_key: string;
  siliconflow_asr_api_key_configured?: boolean;
  cuda_variant: string;
  runtime_channel: string;
  output_dir: string;
  preserve_temp_audio: boolean;
  enable_cache: boolean;
  language: string;
  summary_mode: string;
  llm_enabled: boolean;
  auto_generate_mindmap: boolean;
  llm_provider: string;
  llm_api_key: string;
  llm_base_url: string;
  llm_model: string;
  llm_api_key_configured?: boolean;
  knowledge_llm_mode: string;
  knowledge_llm_enabled: boolean;
  knowledge_llm_api_key: string;
  knowledge_llm_base_url: string;
  knowledge_llm_model: string;
  knowledge_llm_api_key_configured?: boolean;
  knowledge_index_auto_rebuild: string;
  summary_system_prompt: string;
  summary_user_prompt_template: string;
  summary_chunk_target_chars: number;
  summary_chunk_overlap_segments: number;
  task_concurrency: number;
  mindmap_concurrency: number;
  summary_chunk_concurrency: number;
  summary_chunk_retry_count: number;
  settings_file_exists?: boolean;
};

export type SystemInfo = {
  application?: {
    name: string;
    version: string;
  };
  taskModel?: {
    statuses?: string[];
  };
  service?: {
    log_file?: string;
  };
  settings?: ServiceSettings;
  environment?: EnvironmentInfo;
};

export type SystemLogResponse = {
  path: string;
  lines: number;
  content: string;
};

export type LlmTestResponse = {
  ok: boolean;
  message: string;
  model: string;
  baseUrl: string;
  responsePreview?: string;
  jsonOutputAvailable?: boolean;
  jsonPreview?: string;
};

// 文件管理相关类型（与 desktop.d.ts 保持一致）
export type StorageLocationKind = "data" | "cache" | "tasks" | "logs" | "runtime";

export type StorageDirectoryStat = {
  key: StorageLocationKind;
  label: string;
  path: string;
  exists: boolean;
  sizeBytes: number;
  fileCount: number;
  directoryCount: number;
};

export type StorageOverview = {
  generatedAt: string;
  totals: {
    managedBytes: number;
    managedFiles: number;
    managedDirectories: number;
  };
  directories: StorageDirectoryStat[];
  cleanup: {
    serviceAvailable: boolean;
    orphanTaskCount: number;
    orphanTaskBytes: number;
    cacheCandidateCount: number;
    cacheCandidateBytes: number;
  };
};

export type KnowledgeTagRecord = {
  video_id: string;
  tag: string;
  source: string;
  confidence: number;
  created_at: string;
};

export type KnowledgeTagItem = {
  tag: string;
  count: number;
  videos: string[];
};

export type KnowledgeTagListResponse = {
  items: KnowledgeTagItem[];
};

export type VideoKnowledgeTagListResponse = {
  video_id: string;
  items: KnowledgeTagRecord[];
};

export type KnowledgeNetworkNode = {
  id: string;
  label: string;
  type: "tag" | "video" | string;
  count?: number | null;
  tags: string[];
  degree?: number | null;
  focus?: boolean;
  hidden_count?: number;
  video_count?: number;
};

export type KnowledgeNetworkLink = {
  source: string;
  target: string;
  weight?: number;
  kind?: "cooccurrence" | "association" | string;
};

export type KnowledgeNetworkResponse = {
  nodes: KnowledgeNetworkNode[];
  links: KnowledgeNetworkLink[];
  mode?: string;
  hidden_tag_count?: number;
  selected_tags?: string[];
};

export type KnowledgeSearchFilters = {
  tags?: string[];
};

export type KnowledgeSearchRequest = {
  query: string;
  limit?: number;
  filters?: KnowledgeSearchFilters;
};

export type KnowledgeSearchResult = {
  video_id: string;
  title: string;
  relevance_score: number;
  snippet: string;
  tags: string[];
  cover_url: string;
  timestamp?: string | null;
  video_title?: string | null;
  page_title?: string | null;
  page_number?: number | null;
};

export type KnowledgeSearchResponse = {
  query: string;
  results: KnowledgeSearchResult[];
  total: number;
};

export type KnowledgeSourceRef = {
  video_id: string;
  title: string;
  relevance_score: number;
  timestamp?: string | null;
  video_title?: string | null;
  page_title?: string | null;
  page_number?: number | null;
};

export type KnowledgeAskResponse = {
  query: string;
  answer: string;
  sources: KnowledgeSourceRef[];
};

export type KnowledgeChatHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

export type KnowledgeToolTrace = {
  id: string;
  label: string;
  status: "running" | "completed" | "error";
  detail?: string;
  meta?: Record<string, unknown>;
};

export type KnowledgeStatsResponse = {
  video_count: number;
  indexed_chunk_count: number;
  tag_count: number;
  untagged_video_count: number;
  knowledge_llm_available: boolean;
};

export type KnowledgeAutoTagVideoResult = {
  video_id: string;
  tags: string[];
};

export type KnowledgeAutoTagResponse = {
  items: KnowledgeAutoTagVideoResult[];
};
