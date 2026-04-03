import { escapeHtml } from "../utils.js";

export function renderHomeView(state) {
  const latestTask = state.tasks[0];
  const latestStatus = latestTask ? latestTask.status : "暂无任务";
  const latestTitle = latestTask ? latestTask.title || latestTask.source : "先提交一个视频链接";
  const latestUpdated = latestTask ? latestTask.updated_at : "-";

  // 获取状态样式
  const getStatusClass = (status) => {
    if (status === "completed") return "status-success";
    if (status === "running") return "status-running";
    if (status === "failed") return "status-failed";
    return "";
  };

  // 获取状态图标
  const getStatusIcon = (status) => {
    if (status === "completed") return "✓";
    if (status === "running") return "⟳";
    if (status === "failed") return "✕";
    return "○";
  };

  return `
    <!-- Hero区域 -->
    <section class="home-grid">
      <article class="hero-card">
        <div class="hero-content">
          <p class="eyebrow">🚀 欢迎使用</p>
          <h3>本地视频总结服务</h3>
          <p>
            快速为视频生成摘要和关键要点，所有处理都在本地完成，保护您的隐私安全。
          </p>
          <div class="hero-actions">
            <button class="primary-button" onclick="window.location.hash='#tasks'">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              新建任务
            </button>
          </div>
        </div>
      </article>

      <article class="grid-card status-overview">
        <div class="panel-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            最近任务
          </h2>
          <p>快速查看服务运行状态</p>
        </div>
        <div class="info-list">
          <div class="info-row">
            <span class="info-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
              </svg>
              状态
            </span>
            <span class="info-value status-text ${getStatusClass(latestTask?.status)}">
              ${getStatusIcon(latestTask?.status)} ${escapeHtml(latestStatus)}
            </span>
          </div>
          <div class="info-row">
            <span class="info-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              标题
            </span>
            <span class="info-value" title="${escapeHtml(latestTitle)}">${escapeHtml(latestTitle)}</span>
          </div>
          <div class="info-row">
            <span class="info-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              更新时间
            </span>
            <span class="info-value">${escapeHtml(latestUpdated)}</span>
          </div>
        </div>
      </article>
    </section>

    <!-- 系统信息 -->
    <section class="view-grid">
      <article class="grid-card">
        <div class="panel-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
            后端信息
          </h2>
          <p>当前运行服务详情</p>
        </div>
        <div class="info-list">
          <div class="info-row">
            <span class="info-label">服务名</span>
            <span class="info-value">${escapeHtml(state.systemInfo?.application?.name || "-")}</span>
          </div>
          <div class="info-row">
            <span class="info-label">版本</span>
            <span class="info-value">
              <span class="version-badge">${escapeHtml(state.systemInfo?.application?.version || "-")}</span>
            </span>
          </div>
          <div class="info-row">
            <span class="info-label">监听地址</span>
            <span class="info-value code">${escapeHtml(`${state.systemInfo?.service?.host || "-"}:${state.systemInfo?.service?.port || "-"}`)}</span>
          </div>
          <div class="info-row">
            <span class="info-label">转写模型</span>
            <span class="info-value">${escapeHtml(state.systemInfo?.runtime?.whisper_model || "-")}</span>
          </div>
          <div class="info-row">
            <span class="info-label">摘要模型</span>
            <span class="info-value">
              ${state.systemInfo?.runtime?.llm_enabled 
                ? `<span class="badge badge-primary">${escapeHtml(state.systemInfo?.runtime?.llm_model || "已启用")}</span>`
                : `<span class="badge badge-secondary">规则摘要</span>`
              }
            </span>
          </div>
        </div>
      </article>

      <article class="grid-card">
        <div class="panel-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path>
            </svg>
            快速统计
          </h2>
          <p>任务处理概况</p>
        </div>
        <div class="stats-grid">
          <div class="stat-item">
            <span class="stat-value">${state.tasks?.length || 0}</span>
            <span class="stat-label">总任务</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">${state.tasks?.filter(t => t.status === "completed")?.length || 0}</span>
            <span class="stat-label">已完成</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">${state.tasks?.filter(t => t.status === "running")?.length || 0}</span>
            <span class="stat-label">进行中</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">${state.tasks?.filter(t => t.status === "failed")?.length || 0}</span>
            <span class="stat-label">失败</span>
          </div>
        </div>
      </article>
    </section>
  `;
}
