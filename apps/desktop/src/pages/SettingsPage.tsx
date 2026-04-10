import { type FormEvent, useEffect, useState } from "react";

import {
  DesktopState,
  Snapshot,
  UpdateState,
  devicePreferenceLabel,
  formatShortDate,
  getUpdateStatusLabel,
  getUpdateStatusTone,
  getUpdateSummary,
  isUpdateUnsupported,
  normalizeDevicePreference,
} from "../appModel";
import { api } from "../api";
import type { EnvironmentInfo, ServiceSettings } from "../types";
import { settingsCategories, type SettingsCategory } from "./settingsConfig";

type SettingsPageProps = {
  snapshot: Snapshot;
  desktop: DesktopState;
  onRefresh(): void;
  updateInfo: UpdateState;
  updateSupported: boolean;
  onCheckUpdate(): Promise<unknown>;
  onDownloadUpdate(): Promise<unknown>;
  onInstallUpdate(): Promise<void>;
  onOpenUpdateDialog(): void;
};

export function SettingsPage({
  snapshot,
  desktop,
  onRefresh,
  updateInfo,
  updateSupported,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate,
  onOpenUpdateDialog,
}: SettingsPageProps) {
  const [form, setForm] = useState<ServiceSettings | null>(snapshot.settings);
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(snapshot.environment);
  const [saveStatus, setSaveStatus] = useState("");
  const [cudaStatus, setCudaStatus] = useState("");
  const [cudaOutput, setCudaOutput] = useState("");
  const [cudaInstalling, setCudaInstalling] = useState(false);
  const [cudaProgress, setCudaProgress] = useState(0);
  const [cudaStage, setCudaStage] = useState("");
  const [cudaStartedAt, setCudaStartedAt] = useState<number | null>(null);
  const [cudaDetail, setCudaDetail] = useState("");
  const [logOutput, setLogOutput] = useState("");
  const [logPath, setLogPath] = useState(snapshot.systemInfo?.service?.log_file || desktop.logPath || "");
  const [serviceStatus, setServiceStatus] = useState("");
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("overview");

  useEffect(() => {
    setForm(snapshot.settings);
  }, [snapshot.settings]);

  useEffect(() => {
    setEnvironment(snapshot.environment);
  }, [snapshot.environment]);

  useEffect(() => {
    setLogPath(snapshot.systemInfo?.service?.log_file || desktop.logPath || "");
  }, [desktop.logPath, snapshot.systemInfo?.service?.log_file]);

  useEffect(() => {
    void refreshLogs();
  }, []);

  async function refreshLogs() {
    try {
      const response = await api.getSystemLogs();
      setLogOutput(response.content || "日志文件存在，但当前还没有内容。");
      setLogPath(response.path || snapshot.systemInfo?.service?.log_file || desktop.logPath || "");
    } catch (error) {
      try {
        const fallback = await window.desktop?.logs.readServiceLogTail(200);
        if (fallback) {
          setLogOutput(fallback.content || "本地日志文件存在，但当前还没有内容。");
          setLogPath(fallback.path || snapshot.systemInfo?.service?.log_file || desktop.logPath || "");
          setServiceStatus("服务接口不可用，已切换为本地日志读取。");
          return;
        }
      } catch {}
      setLogOutput(error instanceof Error ? error.message : "读取日志失败");
    }
  }

  const backendRunning = Boolean(desktop.backend?.running);
  const backendReady = Boolean(desktop.backend?.ready);
  const serviceOnline = snapshot.serviceOnline;
  const effectiveLogPath = logPath || snapshot.systemInfo?.service?.log_file || desktop.logPath || "-";
  const targetRuntimeChannel = `gpu-${form?.cuda_variant || "cu128"}`;
  const activeCategoryMeta = settingsCategories.find((category) => category.id === activeCategory) || settingsCategories[0];
  const workspaceCategories = settingsCategories.filter((category) => category.group === "workspace");
  const systemCategories = settingsCategories.filter((category) => category.group === "system");
  const llmReady = Boolean(form?.llm_enabled && form?.llm_api_key_configured);
  const updateUnsupported = isUpdateUnsupported(updateInfo);
  const updateStatusLabel = getUpdateStatusLabel(updateInfo);
  const updateStatusTone = getUpdateStatusTone(updateInfo);
  const updateSummary = updateSupported
    ? getUpdateSummary(updateInfo, desktop.version)
    : "当前环境不支持桌面自动更新。";
  const updateActionBusy = updateInfo.status === "checking" || updateInfo.status === "downloading" || updateInfo.status === "installing";
  const cudaPhasePlan = [
    { threshold: 10, label: "准备 GPU 运行时目录" },
    { threshold: 26, label: "引导 pip 和基础安装能力" },
    { threshold: 48, label: "同步 BriefVid 工作区依赖" },
    { threshold: 78, label: "安装 PyTorch CUDA 依赖" },
    { threshold: 92, label: "刷新环境探测与运行时信息" },
    { threshold: 100, label: "完成安装并切换推荐配置" },
  ];

  useEffect(() => {
    if (!cudaInstalling) {
      return;
    }

    const timer = window.setInterval(() => {
      const elapsedMs = cudaStartedAt ? Date.now() - cudaStartedAt : 0;
      const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
      const expectedProgress = Math.min(94, 8 + Math.floor(elapsedSeconds * 1.6));
      setCudaProgress((current) => {
        const next = Math.max(current, expectedProgress);
        const activePhase = cudaPhasePlan.find((phase) => next <= phase.threshold) || cudaPhasePlan[cudaPhasePlan.length - 1];
        setCudaStage(`${activePhase.label} · 已等待 ${elapsedSeconds} 秒`);
        return next;
      });
    }, 1200);

    return () => window.clearInterval(timer);
  }, [cudaInstalling, cudaStartedAt]);

  if (!form) return <section className="grid-card empty-state-card">正在加载设置...</section>;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    try {
      const response = await api.updateSettings({
        ...form,
        device_preference: normalizeDevicePreference(form.device_preference),
      });
      const nextSettings = response.settings;
      setForm(nextSettings);
      setSaveStatus(response.message || "设置已保存");
      setEnvironment(await api.getEnvironment({ runtimeChannel: nextSettings.runtime_channel, refresh: true }));
      onRefresh();
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "保存设置失败");
    }
  }

  const cudaPhaseItems = cudaPhasePlan.map((phase, index) => {
    const previousThreshold = index === 0 ? 0 : cudaPhasePlan[index - 1].threshold;
    const isComplete = cudaProgress >= phase.threshold;
    const isActive = !isComplete && cudaProgress > previousThreshold;
    return {
      ...phase,
      state: isComplete ? "done" : isActive ? "active" : "pending",
    };
  });

  return (
    <div className="settings-page-wrapper">
      <aside className="settings-nav">
        <div className="settings-nav-header">
          <span className="settings-nav-label-small">BriefVid</span>
          <div className="settings-nav-brand-card">
            <div className="settings-nav-brand-copy">
              <span className="settings-nav-brand-kicker">设置</span>
              <strong>管理应用与运行配置</strong>
              <p>调整目录、模型、服务与环境配置。</p>
            </div>
            <div className="settings-nav-brand-metrics">
              <div className="settings-nav-metric">
                <span>服务</span>
                <strong>{serviceOnline ? "在线" : "离线"}</strong>
              </div>
              <div className="settings-nav-metric">
                <span>设备</span>
                <strong>{devicePreferenceLabel(form.whisper_device)}</strong>
              </div>
            </div>
          </div>
        </div>
        <div className="settings-nav-list">
          <div className="settings-nav-group">
            <span className="settings-nav-group-label">工作区</span>
            <nav className="settings-nav-links">
              {workspaceCategories.map((category) => (
                <button
                  key={category.id}
                  className={`settings-nav-item ${activeCategory === category.id ? "active" : ""}`}
                  type="button"
                  onClick={() => setActiveCategory(category.id)}
                >
                  <span className="settings-nav-icon">{category.icon}</span>
                  <span className="settings-nav-copy">
                    <span className="settings-nav-label">{category.label}</span>
                    <span className="settings-nav-description">{category.description}</span>
                  </span>
                </button>
              ))}
            </nav>
          </div>
          <div className="settings-nav-group">
            <span className="settings-nav-group-label">系统</span>
            <nav className="settings-nav-links">
              {systemCategories.map((category) => (
                <button
                  key={category.id}
                  className={`settings-nav-item ${activeCategory === category.id ? "active" : ""}`}
                  type="button"
                  onClick={() => setActiveCategory(category.id)}
                >
                  <span className="settings-nav-icon">{category.icon}</span>
                  <span className="settings-nav-copy">
                    <span className="settings-nav-label">{category.label}</span>
                    <span className="settings-nav-description">{category.description}</span>
                  </span>
                </button>
              ))}
            </nav>
          </div>
        </div>
        <div className="settings-nav-actions">
          <button className="primary-button settings-save-btn" type="button" onClick={async (e) => { e.preventDefault(); await save(e as FormEvent); }}>
            保存设置
          </button>
          <div className="settings-nav-summary">
            <div className="settings-nav-summary-row">
              <span>运行时</span>
              <strong>{environment?.runtimeChannel || form.runtime_channel || "base"}</strong>
            </div>
            <div className="settings-nav-summary-row">
              <span>LLM</span>
              <strong>{llmReady ? "已配置" : form.llm_enabled ? "待补全" : "关闭"}</strong>
            </div>
          </div>
          {saveStatus && <span className="settings-save-status">{saveStatus}</span>}
        </div>
      </aside>

      <main className="settings-content">
        <div className="settings-content-scroll">
          <header className="settings-page-hero">
            <div className="settings-page-hero-copy">
              <span className="settings-page-kicker">Settings</span>
              <h1>{activeCategoryMeta.label}</h1>
              <p>{activeCategoryMeta.description}</p>
            </div>
            <div className="settings-page-hero-meta">
              <span className={`settings-hero-chip ${serviceOnline ? "is-success" : "is-danger"}`}>
                {serviceOnline ? "服务在线" : "服务离线"}
              </span>
              <span className="settings-hero-chip">
                {environment?.runtimeChannel || form.runtime_channel || "base"}
              </span>
              <span className={`settings-hero-chip ${environment?.cudaAvailable ? "is-success" : ""}`}>
                {environment?.cudaAvailable ? "CUDA Ready" : "CPU Only"}
              </span>
              <span className={`settings-hero-chip ${llmReady ? "is-success" : ""}`}>
                {llmReady ? "LLM 已配置" : form.llm_enabled ? "LLM 待补全" : "LLM 关闭"}
              </span>
            </div>
          </header>

          {activeCategory === "overview" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>设置总览</h2>
                <p>查看当前配置、运行状态和常用操作。</p>
              </header>

              <div className="settings-story-card">
                <div className="settings-story-copy">
                  <span className="settings-story-kicker">概览</span>
                  <h3>当前配置与运行状态</h3>
                  <p>这里展示运行时、模型、摘要模式和服务状态。排障时请切换到环境检测或日志。</p>
                </div>
                <div className="settings-story-stats">
                  <div className="settings-story-stat">
                    <span>服务端口</span>
                    <strong>{form.host}:{form.port}</strong>
                  </div>
                  <div className="settings-story-stat">
                    <span>Whisper</span>
                    <strong>{form.fixed_model}</strong>
                  </div>
                  <div className="settings-story-stat">
                    <span>摘要模式</span>
                    <strong>{form.summary_mode === "llm" ? "LLM 智能摘要" : "抽取式摘要"}</strong>
                  </div>
                </div>
              </div>

              <div className="overview-status-grid">
                <div className="overview-status-card">
                  <div className="overview-status-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 6v6l4 2" />
                    </svg>
                  </div>
                  <div className="overview-status-info">
                    <span className="overview-status-label">服务状态</span>
                    <strong className={`overview-status-value ${serviceOnline ? "text-success" : "text-danger"}`}>
                      {serviceOnline ? "运行中" : "已停止"}
                    </strong>
                  </div>
                </div>
                <div className="overview-status-card">
                  <div className="overview-status-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="2" y="3" width="20" height="14" rx="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                    </svg>
                  </div>
                  <div className="overview-status-info">
                    <span className="overview-status-label">运行时</span>
                    <strong className="overview-status-value">{environment?.runtimeChannel || form.runtime_channel || "base"}</strong>
                  </div>
                </div>
                <div className="overview-status-card">
                  <div className="overview-status-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                    </svg>
                  </div>
                  <div className="overview-status-info">
                    <span className="overview-status-label">推理设备</span>
                    <strong className="overview-status-value">{devicePreferenceLabel(form.whisper_device)}</strong>
                  </div>
                </div>
                <div className="overview-status-card">
                  <div className="overview-status-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20.2 7.8l-7.7 7.7a4 4 0 0 1-5.7 0l-3-3a1 1 0 0 1 1.4-1.4l3 3a2 2 0 0 0 2.8 0l7.7-7.7a1 1 0 0 1 1.4 1.4z" />
                    </svg>
                  </div>
                  <div className="overview-status-info">
                    <span className="overview-status-label">LLM 摘要</span>
                    <strong className={`overview-status-value ${form.llm_enabled ? "text-success" : ""}`}>
                      {form.llm_enabled ? "已启用" : "已关闭"}
                    </strong>
                  </div>
                </div>
              </div>

              <div className="overview-section">
                <h3 className="overview-section-title">环境信息</h3>
                <div className="overview-info-grid">
                  <div className="overview-info-item">
                    <span className="overview-info-label">Python</span>
                    <span className="overview-info-value">{environment?.pythonVersion || "-"}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">Torch</span>
                    <span className={`overview-info-value ${environment?.torchInstalled ? "text-success" : ""}`}>
                      {environment?.torchInstalled ? environment?.torchVersion || "已安装" : "未安装"}
                    </span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">GPU</span>
                    <span className={`overview-info-value ${environment?.cudaAvailable ? "text-success" : ""}`}>
                      {environment?.cudaAvailable ? environment?.gpuName || "已就绪" : "未检测到"}
                    </span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">yt-dlp</span>
                    <span className="overview-info-value">{environment?.ytDlpVersion || "-"}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">faster-whisper</span>
                    <span className="overview-info-value">{environment?.fasterWhisperVersion || "-"}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">FFmpeg</span>
                    <span className={`overview-info-value ${environment?.ffmpegLocation ? "text-success" : ""}`}>
                      {environment?.ffmpegLocation ? "已安装" : "未安装"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="overview-section">
                <h3 className="overview-section-title">版本信息</h3>
                <div className="overview-info-grid">
                  <div className="overview-info-item">
                    <span className="overview-info-label">应用版本</span>
                    <span className="overview-info-value">v{desktop.version}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">监听地址</span>
                    <span className="overview-info-value">{form.host}:{form.port}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">语言</span>
                    <span className="overview-info-value">{form.language === "zh" ? "中文" : form.language === "en" ? "English" : "日本語"}</span>
                  </div>
                  <div className="overview-info-item">
                    <span className="overview-info-label">Whisper 模型</span>
                    <span className="overview-info-value">{form.fixed_model}</span>
                  </div>
                </div>
              </div>

              <div className="overview-section">
                <h3 className="overview-section-title">快速操作</h3>
                <div className="overview-actions">
                  <button className="tertiary-button" type="button" onClick={() => setActiveCategory("environment")}>环境设置</button>
                  <button className="tertiary-button" type="button" onClick={() => setActiveCategory("logs")}>查看日志</button>
                  <button className="tertiary-button" type="button" onClick={() => setActiveCategory("model")}>模型配置</button>
                  <button className="tertiary-button" type="button" onClick={() => setActiveCategory("llm")}>LLM 设置</button>
                </div>
              </div>
            </section>
          )}

          {activeCategory === "general" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>基础设置</h2>
                <p>服务监听地址和端口配置。</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">监听地址</span>
                  <input className="settings-input-field" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
                  <span className="settings-input-caption">服务绑定的 IP 地址，默认为 127.0.0.1</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">监听端口</span>
                  <input className="settings-input-field" type="number" value={form.port} onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) || 3838 })} />
                  <span className="settings-input-caption">服务端口号，默认 3838</span>
                </label>
              </div>
            </section>
          )}

          {activeCategory === "directories" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>目录设置</h2>
                <p>数据存储和缓存目录配置。</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">数据目录</span>
                  <input className="settings-input-field" value={String(form.data_dir)} onChange={(e) => setForm({ ...form, data_dir: e.target.value })} />
                  <span className="settings-input-caption">存储视频摘要和元数据</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">缓存目录</span>
                  <input className="settings-input-field" value={String(form.cache_dir)} onChange={(e) => setForm({ ...form, cache_dir: e.target.value })} />
                  <span className="settings-input-caption">临时缓存文件</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">任务目录</span>
                  <input className="settings-input-field" value={String(form.tasks_dir)} onChange={(e) => setForm({ ...form, tasks_dir: e.target.value })} />
                  <span className="settings-input-caption">任务历史记录</span>
                </label>
              </div>
            </section>
          )}

          {activeCategory === "model" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>模型设置</h2>
                <p>Whisper 模型和推理设备配置。</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">推理设备</span>
                  <select className="settings-select-field" value={normalizeDevicePreference(form.device_preference)} onChange={(e) => setForm({ ...form, device_preference: e.target.value })}>
                    <option value="auto">自动选择</option>
                    <option value="cuda">GPU (CUDA)</option>
                    <option value="cpu">CPU</option>
                  </select>
                  <span className="settings-input-caption">选择推理设备，GPU 需要 CUDA 支持</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">模型模式</span>
                  <select className="settings-select-field" value={form.model_mode} onChange={(e) => setForm({ ...form, model_mode: e.target.value })}>
                    <option value="fixed">固定模型</option>
                    <option value="auto">自动选择</option>
                  </select>
                  <span className="settings-input-caption">自动模式会根据设备选择最优模型</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">固定模型</span>
                  <input className="settings-input-field" value={form.fixed_model} onChange={(e) => setForm({ ...form, fixed_model: e.target.value })} placeholder="tiny / base / small / medium / large-v3" />
                  <span className="settings-input-caption">Whisper 模型名称，小模型速度快但精度低</span>
                </label>
              </div>
            </section>
          )}

          {activeCategory === "llm" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>LLM 设置</h2>
                <p>大语言模型摘要配置。</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">启用 LLM 摘要</span>
                  <select className="settings-select-field" value={form.llm_enabled ? "true" : "false"} onChange={(e) => setForm({ ...form, llm_enabled: e.target.value === "true" })}>
                    <option value="false">关闭</option>
                    <option value="true">开启</option>
                  </select>
                  <span className="settings-input-caption">使用大语言模型生成更高质量的视频摘要</span>
                </label>
                {form.llm_enabled && (
                  <>
                    <label className="settings-input-group">
                      <span className="settings-input-label">LLM 提供商</span>
                      <select className="settings-select-field" value={form.llm_provider} onChange={(e) => setForm({ ...form, llm_provider: e.target.value })}>
                        <option value="openai-compatible">OpenAI Compatible</option>
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="custom">自定义</option>
                      </select>
                    </label>
                    <label className="settings-input-group">
                      <span className="settings-input-label">API Base URL</span>
                      <input className="settings-input-field" value={form.llm_base_url} onChange={(e) => setForm({ ...form, llm_base_url: e.target.value })} placeholder="https://api.openai.com/v1" />
                      <span className="settings-input-caption">LLM API 的基础 URL 地址</span>
                    </label>
                    <label className="settings-input-group">
                      <span className="settings-input-label">API Key</span>
                      <input className="settings-input-field" type="password" value={form.llm_api_key} onChange={(e) => setForm({ ...form, llm_api_key: e.target.value })} placeholder="sk-..." />
                      <span className="settings-input-caption">LLM 服务的 API 密钥</span>
                    </label>
                    <label className="settings-input-group">
                      <span className="settings-input-label">模型名称</span>
                      <input className="settings-input-field" value={form.llm_model} onChange={(e) => setForm({ ...form, llm_model: e.target.value })} placeholder="gpt-4o-mini / claude-3-haiku" />
                      <span className="settings-input-caption">要使用的 LLM 模型名称</span>
                    </label>
                  </>
                )}
              </div>
            </section>
          )}

          {activeCategory === "summary" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>摘要参数</h2>
                <p>摘要生成算法参数配置。</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">摘要模式</span>
                  <select className="settings-select-field" value={form.summary_mode} onChange={(e) => setForm({ ...form, summary_mode: e.target.value })}>
                    <option value="llm">LLM 智能摘要</option>
                    <option value="extract">抽取式摘要</option>
                  </select>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">语言</span>
                  <select className="settings-select-field" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                    <option value="ja">日本語</option>
                  </select>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">分块目标字符数</span>
                  <input className="settings-input-field" type="number" value={form.summary_chunk_target_chars} onChange={(e) => setForm({ ...form, summary_chunk_target_chars: parseInt(e.target.value) || 2200 })} />
                  <span className="settings-input-caption">LLM 处理时分块的目标字符数</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">分块重叠段数</span>
                  <input className="settings-input-field" type="number" value={form.summary_chunk_overlap_segments} onChange={(e) => setForm({ ...form, summary_chunk_overlap_segments: parseInt(e.target.value) || 2 })} />
                  <span className="settings-input-caption">分块之间的重叠段数，保证连续性</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">并发数</span>
                  <input className="settings-input-field" type="number" value={form.summary_chunk_concurrency} onChange={(e) => setForm({ ...form, summary_chunk_concurrency: parseInt(e.target.value) || 2 })} />
                  <span className="settings-input-caption">同时处理的分块数量</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">重试次数</span>
                  <input className="settings-input-field" type="number" value={form.summary_chunk_retry_count} onChange={(e) => setForm({ ...form, summary_chunk_retry_count: parseInt(e.target.value) || 2 })} />
                  <span className="settings-input-caption">API 调用失败时的重试次数</span>
                </label>
              </div>
            </section>
          )}

          {activeCategory === "advanced" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>高级设置</h2>
                <p>CUDA 变体和运行时配置。</p>
              </header>
              <div className="settings-form-group">
                <label className="settings-input-group">
                  <span className="settings-input-label">CUDA 变体</span>
                  <select className="settings-select-field" value={form.cuda_variant} onChange={(e) => setForm({ ...form, cuda_variant: e.target.value })}>
                    <option value="cu128">CUDA 12.8</option>
                    <option value="cu126">CUDA 12.6</option>
                    <option value="cu124">CUDA 12.4</option>
                  </select>
                  <span className="settings-input-caption">PyTorch CUDA 版本</span>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">运行时通道</span>
                  <select className="settings-select-field" value={form.runtime_channel} onChange={(e) => setForm({ ...form, runtime_channel: e.target.value })}>
                    <option value="base">基础版</option>
                    <option value="gpu-cu128">GPU CUDA12.8</option>
                    <option value="gpu-cu126">GPU CUDA12.6</option>
                    <option value="gpu-cu124">GPU CUDA12.4</option>
                  </select>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">保留临时音频</span>
                  <select className="settings-select-field" value={form.preserve_temp_audio ? "true" : "false"} onChange={(e) => setForm({ ...form, preserve_temp_audio: e.target.value === "true" })}>
                    <option value="false">不保留</option>
                    <option value="true">保留</option>
                  </select>
                </label>
                <label className="settings-input-group">
                  <span className="settings-input-label">启用缓存</span>
                  <select className="settings-select-field" value={form.enable_cache ? "true" : "false"} onChange={(e) => setForm({ ...form, enable_cache: e.target.value === "true" })}>
                    <option value="true">开启</option>
                    <option value="false">关闭</option>
                  </select>
                </label>
              </div>
            </section>
          )}

          {activeCategory === "environment" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>运行环境</h2>
                <p>环境检测信息和 CUDA 配置。</p>
              </header>
              <div className="env-summary-grid settings-env-grid">
                <div className="metric-card">
                  <span className="metric-label">推荐设备</span>
                  <strong className="metric-value">{environment?.recommendedDevice || "-"}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">请求设备</span>
                  <strong className="metric-value">{devicePreferenceLabel(form.device_preference)}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">生效设备</span>
                  <strong className={`metric-value ${normalizeDevicePreference(form.whisper_device) === "cuda" ? "text-success" : ""}`}>{devicePreferenceLabel(form.whisper_device)}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">推荐模型</span>
                  <strong className="metric-value">{environment?.recommendedModel || "-"}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">GPU 状态</span>
                  <strong className={`metric-value ${environment?.cudaAvailable ? "text-success" : ""}`}>{environment?.cudaAvailable ? "已启用" : "未启用"}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">GPU 名称</span>
                  <strong className="metric-value">{environment?.gpuName || "未检测到"}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">Torch</span>
                  <strong className={`metric-value ${environment?.torchInstalled ? "text-success" : ""}`}>{environment?.torchInstalled ? environment?.torchVersion || "已安装" : "未安装"}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-label">Python</span>
                  <strong className="metric-value">{environment?.pythonVersion || "-"}</strong>
                </div>
              </div>
              <div className="settings-cuda-section">
                <h3 className="settings-cuda-title">CUDA 目标版本</h3>
                <div className="cuda-insight-grid">
                  <div className="setting-row">
                    <span className="setting-label">目标运行时</span>
                    <span className="setting-value">{targetRuntimeChannel}</span>
                  </div>
                  <div className="setting-row">
                    <span className="setting-label">当前运行时</span>
                    <span className="setting-value">{environment?.runtimeChannel || form.runtime_channel || "base"}</span>
                  </div>
                  <div className="setting-row">
                    <span className="setting-label">运行时状态</span>
                    <span className="setting-value">{environment?.runtimeReady === false ? "未就绪" : "已就绪"}</span>
                  </div>
                </div>
                <div className="settings-actions cuda-button-row">
                  <label className="input-row cuda-picker">
                    <span className="input-label">CUDA 目标版本</span>
                    <select
                      className="select-field"
                      value={form.cuda_variant}
                      disabled={cudaInstalling}
                      onChange={(event) => setForm({ ...form, cuda_variant: event.target.value })}
                    >
                      <option value="cu128">CUDA 12.8</option>
                      <option value="cu126">CUDA 12.6</option>
                      <option value="cu124">CUDA 12.4</option>
                    </select>
                  </label>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={cudaInstalling}
                    onClick={async () => {
                      try {
                        setCudaStatus("正在重新检测环境...");
                        const nextEnvironment = await api.getEnvironment({ runtimeChannel: form.runtime_channel, refresh: true });
                        setEnvironment(nextEnvironment);
                        setCudaStatus("环境检测完成");
                        onRefresh();
                      } catch (error) {
                        setCudaStatus(error instanceof Error ? error.message : "环境检测失败");
                      }
                    }}
                  >
                    重新检测
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={cudaInstalling}
                    onClick={async () => {
                      try {
                        setCudaInstalling(true);
                        setCudaStartedAt(Date.now());
                        setCudaProgress(8);
                        setCudaStage("准备 GPU 运行时目录");
                        setCudaStatus("CUDA 安装已开始，正在准备运行时...");
                        setCudaOutput("");
                        setCudaDetail(`将为 ${targetRuntimeChannel} 安装 PyTorch CUDA 依赖，并把运行时切换到该通道。`);
                        const result = await api.installCuda({ cuda_variant: form.cuda_variant });
                        const nextRuntimeChannel = result.runtimeChannel || form.runtime_channel;
                        setCudaInstalling(false);
                        setCudaProgress(100);
                        setCudaStage(result.restartRequired ? "CUDA 安装完成，等待重启切换运行时" : "CUDA 安装完成");
                        setCudaStatus(
                          result.restartRequired
                            ? "CUDA 安装完成，请重启应用后切换到新的 GPU 运行时"
                            : "CUDA 安装命令已执行"
                        );
                        setCudaOutput(result.stdoutTail || "");
                        setCudaDetail(`安装目标：${result.cudaVariant || form.cuda_variant}，运行时通道：${nextRuntimeChannel}。`);
                        setForm({ ...form, runtime_channel: nextRuntimeChannel, cuda_variant: result.cudaVariant || form.cuda_variant });
                        setEnvironment(await api.getEnvironment({ runtimeChannel: nextRuntimeChannel, refresh: true }));
                        onRefresh();
                      } catch (error) {
                        setCudaInstalling(false);
                        setCudaStage("CUDA 安装失败");
                        setCudaProgress((current) => (current > 0 ? current : 12));
                        setCudaStatus(error instanceof Error ? error.message : "CUDA 安装失败");
                        setCudaDetail("安装依赖失败。请查看下方输出和服务日志。");
                      }
                    }}
                  >
                    {cudaInstalling ? "安装中..." : "安装 CUDA 支持"}
                  </button>
                </div>
              </div>
              {(cudaInstalling || cudaProgress > 0 || cudaStatus) ? (
                <div className="cuda-progress-card">
                  <div className="progress-bar-wrapper">
                    <div className="progress-bar-simple">
                      <div
                        className={`progress-fill-simple ${cudaStatus.includes("失败") ? "error" : cudaProgress >= 100 ? "success" : ""}`}
                        style={{ width: `${Math.min(cudaProgress, 100)}%` }}
                      />
                    </div>
                    <div className="progress-info-simple">
                      <span className="progress-percent-simple">{Math.round(Math.min(cudaProgress, 100))}%</span>
                      <span className="progress-status-simple">{cudaStage || "等待开始"}</span>
                    </div>
                  </div>
                  <div className="cuda-stage-list">
                    {cudaPhaseItems.map((phase) => (
                      <div key={phase.label} className={`cuda-stage-item ${phase.state}`}>
                        <span>{phase.label}</span>
                        <strong>
                          {phase.state === "done" ? "已完成" : phase.state === "active" ? "进行中" : "待执行"}
                        </strong>
                      </div>
                    ))}
                  </div>
                  <p className="cuda-helper-text">
                    阶段进度为估计值；最终结果以安装输出和重新检测结果为准。
                  </p>
                </div>
              ) : null}
              {cudaStatus ? <div className="action-status">{cudaStatus}</div> : null}
              {cudaDetail ? <div className="cuda-helper-text">{cudaDetail}</div> : null}
              {cudaOutput ? (
                <label className="input-row">
                  <span className="input-label">CUDA 安装输出</span>
                  <textarea className="textarea-field log-viewer" rows={12} readOnly value={cudaOutput}></textarea>
                </label>
              ) : null}
              {environment?.runtimeError ? (
                <label className="input-row">
                  <span className="input-label">运行时错误详情</span>
                  <textarea className="textarea-field log-viewer" rows={8} readOnly value={environment.runtimeError}></textarea>
                </label>
              ) : null}
              {(cudaStatus.includes("完成") || cudaProgress >= 100) ? (
                <div className="cuda-next-steps">
                  <strong>下一步</strong>
                  <span>1. 点击"重新检测"确认 GPU runtime 已就绪。</span>
                  <span>2. 确认"运行时通道"已切换到目标 GPU 通道。</span>
                  <span>3. 若提示需要重启，请重启应用后再开始转写任务。</span>
                </div>
              ) : null}
            </section>
          )}

          {activeCategory === "logs" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>日志与控制</h2>
                <p>查看后端日志并控制服务。</p>
              </header>
              <div className="control-status-row">
                <span className={`helper-chip ${serviceOnline ? "status-success" : "status-failed"}`}>{serviceOnline ? "服务在线" : "服务离线"}</span>
                <span className={`helper-chip ${backendRunning ? (backendReady ? "status-success" : "status-running") : "status-pending"}`}>
                  {backendRunning ? (backendReady ? "内置后端运行中" : "内置后端启动中") : "内置后端未运行"}
                </span>
                {desktop.backend?.pid ? <span className="helper-chip">PID {desktop.backend.pid}</span> : null}
              </div>
              <div className="setting-list">
                <div className="setting-row"><span className="setting-label">服务名</span><span className="setting-value">{snapshot.systemInfo?.application?.name || "-"}</span></div>
                <div className="setting-row"><span className="setting-label">版本</span><span className="setting-value">{snapshot.systemInfo?.application?.version || "-"}</span></div>
                <div className="setting-row"><span className="setting-label">日志文件</span><span className="setting-value">{effectiveLogPath}</span></div>
              </div>
              <div className="desktop-actions">
                <button className="secondary-button" type="button" onClick={() => void refreshLogs()}>刷新日志</button>
                <button
                  className={backendRunning ? "secondary-button danger-button" : "primary-button"}
                  type="button"
                  onClick={async () => {
                    if (backendRunning) {
                      await window.desktop?.backend.stop();
                      setServiceStatus("内置后端已停止");
                    } else {
                      await window.desktop?.backend.start();
                      setServiceStatus("已请求启动内置后端");
                    }
                    onRefresh();
                    await refreshLogs();
                  }}
                >
                  {backendRunning ? "停止内置后端" : "启动内置后端"}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={async () => {
                    await window.desktop?.shell.openPath(effectiveLogPath);
                  }}
                >
                  打开日志文件
                </button>
                <button
                  className="secondary-button danger-button"
                  type="button"
                  disabled={!serviceOnline}
                  onClick={async () => {
                    await api.shutdownService();
                    setServiceStatus("已向服务发送关闭请求");
                    onRefresh();
                    await refreshLogs();
                  }}
                >
                  强制关闭服务
                </button>
              </div>
              {desktop.backend?.lastError ? <div className="action-status">{desktop.backend.lastError}</div> : null}
              {serviceStatus ? <div className="action-status">{serviceStatus}</div> : null}
              <label className="input-row">
                <span className="input-label">最近日志</span>
                <textarea className="textarea-field log-viewer" rows={20} readOnly value={logOutput}></textarea>
              </label>
            </section>
          )}

          {activeCategory === "updates" && (
            <section className="settings-category-section">
              <header className="settings-category-header">
                <h2>桌面应用更新</h2>
                <p>检查新版本并管理安装。</p>
              </header>
              <div className="settings-update-module">
                <div className="settings-update-overview">
                  <div className="settings-update-copy">
                    <span className="settings-story-kicker">Update</span>
                    <h3>手动检查桌面端更新</h3>
                    <p>{updateSummary}</p>
                  </div>
                  <div className="settings-update-badges">
                    <span className="helper-chip">当前版本 v{desktop.version || "-"}</span>
                    <span className={`helper-chip status-${updateStatusTone}`}>状态：{updateStatusLabel}</span>
                    {updateInfo.version ? <span className="helper-chip">最新版本 v{updateInfo.version}</span> : null}
                    {updateInfo.releaseDate ? <span className="helper-chip">发布时间 {formatShortDate(updateInfo.releaseDate)}</span> : null}
                  </div>
                </div>

                <div className="settings-update-grid">
                  <div className="settings-update-panel">
                    <span className="settings-update-label">当前安装版本</span>
                    <strong>v{desktop.version || "-"}</strong>
                    <p>检查、下载和安装更新。</p>
                  </div>

                  <div className={`settings-update-panel ${updateInfo.status === "available" || updateInfo.status === "downloaded" ? "is-highlight" : ""}`}>
                    <span className="settings-update-label">检查结果</span>
                    <strong>
                      {updateUnsupported
                        ? "当前环境不可更新"
                        : updateInfo.status === "available" || updateInfo.status === "downloaded"
                        ? `发现 v${updateInfo.version || "-"}`
                        : updateInfo.status === "not-available"
                          ? "已是最新版本"
                          : updateInfo.status === "error"
                            ? "检查失败"
                            : updateInfo.status === "checking"
                              ? "正在检查"
                              : updateInfo.status === "downloading"
                                ? `下载中 ${Math.round(updateInfo.downloadProgress)}%`
                                : updateInfo.status === "installing"
                                  ? "正在安装"
                                  : "等待检查"}
                    </strong>
                    <p>
                      {updateInfo.status === "available" || updateInfo.status === "downloaded"
                        ? `当前 v${desktop.version || "-"}，最新 v${updateInfo.version || "-"}`
                        : updateInfo.status === "error"
                          ? (updateInfo.errorMessage || "更新检查失败，请重试。")
                          : updateSummary}
                    </p>
                  </div>
                </div>

                <div className="settings-update-actions">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!updateSupported || updateActionBusy}
                    onClick={async () => {
                      try {
                        if (!updateSupported) {
                          return;
                        }
                        if (updateInfo.status === "available") {
                          await onDownloadUpdate();
                          return;
                        }
                        if (updateInfo.status === "downloaded") {
                          await onInstallUpdate();
                          return;
                        }
                        await onCheckUpdate();
                      } catch {}
                    }}
                  >
                    {!updateSupported
                      ? "当前环境不支持自动更新"
                      : updateInfo.status === "checking"
                        ? "检查中..."
                        : updateInfo.status === "downloading"
                          ? `下载中... ${Math.round(updateInfo.downloadProgress)}%`
                        : updateInfo.status === "installing"
                            ? "安装中..."
                            : updateInfo.status === "available"
                              ? "下载并重启安装"
                              : updateInfo.status === "downloaded"
                                ? "立即重启安装"
                                : updateInfo.status === "error"
                                  ? "重试检查"
                                  : "检查更新"}
                  </button>

                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!updateSupported}
                    onClick={onOpenUpdateDialog}
                  >
                    查看更新详情
                  </button>
                </div>

                {updateInfo.status === "available" || updateInfo.status === "downloaded" ? (
                  <div className="settings-update-next-step">
                    <strong>下一步</strong>
                    <span>
                      {updateInfo.status === "available"
                        ? "已检测到新版本，继续后会下载更新并自动重启安装。"
                        : "更新已下载完成，可以立即重启应用完成安装。"}
                    </span>
                  </div>
                ) : null}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
