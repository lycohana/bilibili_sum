import assert from "node:assert/strict";

import { getConfigHealth, shouldShowSetupAssistant } from "../src/appModel.ts";
import type { EnvironmentInfo, ServiceSettings } from "../src/types.ts";

function run(name: string, fn: () => void) {
  fn();
  console.log(`ok - ${name}`);
}

function createSettings(overrides: Partial<ServiceSettings> = {}): ServiceSettings {
  return {
    host: "127.0.0.1",
    port: 3838,
    data_dir: "data",
    cache_dir: "cache",
    tasks_dir: "tasks",
    database_url: "sqlite:///test.db",
    transcription_provider: "siliconflow",
    whisper_model: "tiny",
    whisper_device: "cpu",
    whisper_compute_type: "int8",
    device_preference: "cpu",
    compute_type: "int8",
    model_mode: "fixed",
    fixed_model: "tiny",
    siliconflow_asr_base_url: "https://api.siliconflow.cn/v1",
    siliconflow_asr_model: "TeleAI/TeleSpeechASR",
    siliconflow_asr_api_key: "",
    siliconflow_asr_api_key_configured: false,
    cuda_variant: "cu128",
    runtime_channel: "base",
    output_dir: "",
    preserve_temp_audio: false,
    enable_cache: true,
    language: "zh",
    summary_mode: "llm",
    llm_enabled: false,
    auto_generate_mindmap: false,
    llm_provider: "openai-compatible",
    llm_api_key: "",
    llm_api_key_configured: false,
    llm_base_url: "",
    llm_model: "",
    summary_system_prompt: "",
    summary_user_prompt_template: "",
    summary_chunk_target_chars: 2200,
    summary_chunk_overlap_segments: 2,
    summary_chunk_concurrency: 2,
    summary_chunk_retry_count: 2,
    settings_file_exists: true,
    ...overrides,
  };
}

run("marks siliconflow api key as blocking when missing", () => {
  const health = getConfigHealth(createSettings({ settings_file_exists: false }));

  assert.equal(health.state, "critical");
  assert.equal(health.hasBlockingIssues, true);
  assert.equal(health.blockingIssues[0]?.key, "siliconflow_asr_api_key");
});

run("marks incomplete llm setup as warning when llm is enabled", () => {
  const health = getConfigHealth(createSettings({
    llm_enabled: true,
    llm_api_key_configured: false,
    llm_base_url: "",
    llm_model: "",
    siliconflow_asr_api_key_configured: true,
  }));

  assert.equal(health.state, "warning");
  assert.equal(health.hasBlockingIssues, false);
  assert.equal(health.issues[0]?.key, "llm_configuration");
});

run("marks missing local asr runtime as blocking when local provider is selected", () => {
  const health = getConfigHealth(
    createSettings({
      transcription_provider: "local",
      siliconflow_asr_api_key_configured: true,
    }),
    { localAsrAvailable: false } as EnvironmentInfo,
  );

  assert.equal(health.state, "critical");
  assert.equal(health.blockingIssues[0]?.key, "local_asr_runtime");
});

run("shows setup assistant only for first-run installs with outstanding issues", () => {
  const settings = createSettings({ settings_file_exists: false });
  const health = getConfigHealth(settings);

  assert.equal(shouldShowSetupAssistant(health, settings), true);
  assert.equal(shouldShowSetupAssistant(health, createSettings({ settings_file_exists: true })), false);
});
