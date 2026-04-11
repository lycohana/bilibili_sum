export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type TimelineItem = {
  title?: string;
  start?: number;
  summary?: string;
};

export type TaskResult = {
  overview: string;
  transcript_text: string;
  segment_summaries: string[];
  key_points: string[];
  timeline: TimelineItem[];
  artifacts: Record<string, string>;
  llm_prompt_tokens?: number | null;
  llm_completion_tokens?: number | null;
  llm_total_tokens?: number | null;
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
  created_at: string;
  updated_at: string;
};

export type VideoAssetDetail = VideoAssetSummary & {
  latest_result?: TaskResult | null;
  latest_error_message?: string | null;
};

export type TaskSummary = {
  task_id: string;
  video_id?: string | null;
  status: TaskStatus;
  input_type: string;
  source: string;
  title?: string | null;
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
  fasterWhisperVersion?: string;
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
  whisper_model: string;
  whisper_device: string;
  whisper_compute_type: string;
  device_preference: string;
  compute_type: string;
  model_mode: string;
  fixed_model: string;
  cuda_variant: string;
  runtime_channel: string;
  output_dir: string;
  preserve_temp_audio: boolean;
  enable_cache: boolean;
  language: string;
  summary_mode: string;
  llm_enabled: boolean;
  llm_provider: string;
  llm_api_key: string;
  llm_base_url: string;
  llm_model: string;
  llm_api_key_configured?: boolean;
  summary_system_prompt: string;
  summary_user_prompt_template: string;
  summary_chunk_target_chars: number;
  summary_chunk_overlap_segments: number;
  summary_chunk_concurrency: number;
  summary_chunk_retry_count: number;
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
