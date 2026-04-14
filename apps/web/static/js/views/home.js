import { escapeHtml, formatDateTime, formatDuration, formatTaskDuration, formatTokenCount, taskStatusLabel } from "../utils.js";

function getStatusTone(message) {
  if (/失败|错误|不可用|未就绪|无效|已取消|关闭/i.test(message)) {
    return "error";
  }
  if (/完成|成功|已保存|已刷新|已开始|已删除|已更新|已复制|已请求/i.test(message)) {
    return "success";
  }
  return "info";
}

function renderStatusNotice(message, className, statusKey) {
  if (!message) {
    return "";
  }
  const tone = getStatusTone(message);
  return `
    <div class="${className} tone-${tone}">
      <span class="${className}-copy">${escapeHtml(message)}</span>
      <button class="${className}-close" type="button" data-dismiss-status="${statusKey}" aria-label="关闭提示">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
        </svg>
      </button>
    </div>
  `;
}

export function renderHomeView(state) {
  return state.page === "video-detail" ? renderVideoDetailPage(state) : renderLibraryPage(state);
}

export function renderHomeRegions(state) {
  return state.page === "video-detail" ? renderVideoDetailRegions(state) : renderLibraryRegions(state);
}

export function buildTaskProgressView(events) {
  const displayEvents = getDisplayProgressEvents(events);
  const stages = [
    { key: "queued", label: "排队中" },
    { key: "preparing", label: "准备" },
    { key: "probing", label: "探测" },
    { key: "downloading", label: "下载" },
    { key: "transcribing", label: "转写" },
    { key: "summarizing", label: "摘要" },
    { key: "exporting", label: "导出" },
    { key: "completed", label: "完成" },
  ];

  const stageMap = new Map();
  let currentStageIndex = -1;
  let currentEvent = null;
  let failedEvent = null;

  for (const event of events) {
    if (event.stage === "failed") {
      failedEvent = event;
      continue;
    }
    stageMap.set(event.stage, event);
    const stageIndex = stages.findIndex((stage) => stage.key === event.stage);
    if (stageIndex >= currentStageIndex) {
      currentStageIndex = stageIndex;
      currentEvent = event;
    }
  }

  const hasError = Boolean(failedEvent);
  const isCompleted = stageMap.has("completed");
  const completedCount = isCompleted ? stages.length : Math.max(currentStageIndex + 1, 0);
  const headlineEvent = hasError ? failedEvent : currentEvent;
  const fallbackProgress = Math.min((completedCount / stages.length) * 100, 100);
  const headlineProgress = Number(headlineEvent?.progress);
  const progress =
    isCompleted ? 100 :
    Number.isFinite(headlineProgress) ? Math.max(0, Math.min(100, Math.round(headlineProgress))) :
    fallbackProgress;

  return {
    stages,
    currentEvent,
    failedEvent,
    hasError,
    isCompleted,
    progress,
    headlineEvent,
    title: headlineEvent ? `当前阶段：${getStageLabel(headlineEvent.stage, stages)}` : "阶段详情",
    subtitle: displayEvents.length ? `${displayEvents.length} 条进度记录` : "任务开始后会在这里显示阶段记录",
  };
}

export function renderTaskProgressEvents(events) {
  const view = buildTaskProgressView(events);
  const displayEvents = getDisplayProgressEvents(events);
  return displayEvents.length
    ? displayEvents.map((event) => renderStageEventCard(event, view.stages, view.currentEvent, view.failedEvent)).join("")
    : `<div class="empty-placeholder">暂无进度记录</div>`;
}

function getDisplayProgressEvents(events) {
  const displayEvents = [];
  const mergedStageIndexes = new Map();
  const mergeableStages = new Set(["downloading", "transcribing"]);

  for (const event of events) {
    if (!mergeableStages.has(event.stage)) {
      displayEvents.push(event);
      continue;
    }

    const mergedIndex = mergedStageIndexes.get(event.stage);
    if (mergedIndex == null) {
      displayEvents.push(event);
      mergedStageIndexes.set(event.stage, displayEvents.length - 1);
      continue;
    }

    displayEvents[mergedIndex] = event;
  }

  return displayEvents;
}

function renderLibraryPage(state) {
  const regions = renderLibraryRegions(state);
  return `
    <section class="library-page">
      <section class="library-topbar">
        <div id="library-intake-region">${regions.intake}</div>
        <div id="library-summary-region">${regions.summary}</div>
      </section>

      <div id="library-grid-region">${regions.grid}</div>
    </section>
  `;
}

function renderLibraryRegions(state) {
  const videos = (state.videos || []).filter((video) => {
    const keyword = state.librarySearch.trim().toLowerCase();
    if (!keyword) return true;
    return video.title.toLowerCase().includes(keyword) || video.source_url.toLowerCase().includes(keyword);
  });

  return {
    intake: `
      <article class="grid-card library-intake-card">
        <div class="panel-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="16"></line>
              <line x1="12" y1="12" x2="16" y2="12"></line>
            </svg>
            开始总结
          </h2>
          <p>输入视频链接或直接填写 BV 号后，系统会抓取封面和标题，并立即开始本地总结。</p>
        </div>
        <form id="probe-form" class="task-form">
          <label class="input-row">
            <span class="input-label">视频链接</span>
            <input id="probe-url-input" type="text" class="input-field" placeholder="https://www.bilibili.com/video/... 或 BV1xx411c7mD" required autocomplete="off" />
          </label>
          <div class="hero-actions">
            <button class="primary-button" type="submit">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
              开始总结
            </button>
          </div>
          ${renderStatusNotice(state.submitStatus, "submit-status", "submitStatus")}
        </form>
        ${state.probePreview ? renderProbePreview(state.probePreview) : ""}
      </article>
    `,
    summary: `
      <article class="grid-card library-summary-card">
        <div class="panel-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path>
            </svg>
            视频库概览
          </h2>
          <p>封面、本地缓存和任务结果统一管理</p>
        </div>
        <div class="library-summary-grid">
          <div class="summary-metric">
            <strong>${state.videos.length}</strong>
            <span>视频总数</span>
          </div>
          <div class="summary-metric">
            <strong>${state.videos.filter((item) => item.latest_status === "completed").length}</strong>
            <span>已完成</span>
          </div>
          <div class="summary-metric">
            <strong>${state.videos.filter((item) => item.latest_status === "running").length}</strong>
            <span>处理中</span>
          </div>
          <div class="summary-metric">
            <strong>${state.videos.filter((item) => item.has_result).length}</strong>
            <span>有摘要结果</span>
          </div>
        </div>
      </article>
    `,
    grid: `
      <section class="grid-card library-grid-card">
        <div class="card-header">
          <div>
            <h2 style="font-size: 16px; margin-bottom: 4px;">视频库</h2>
            <p style="font-size: 13px; color: var(--text-secondary); margin: 0;">${state.videos.length} 个视频资产，点击卡片打开详情</p>
          </div>
          <div class="library-toolbar">
            <input id="library-search" class="input-field" type="search" value="${escapeHtml(state.librarySearch)}" placeholder="搜索标题或链接..." aria-label="搜索视频" style="min-width: 280px;" />
          </div>
        </div>
        <div id="library-list-region" class="video-grid">
          ${videos.length ? videos.map((video) => renderVideoCard(video)).join("") : renderEmptyLibrary()}
        </div>
      </section>
    `,
    list: `${videos.length ? videos.map((video) => renderVideoCard(video)).join("") : renderEmptyLibrary()}`,
  };
}

function renderVideoDetailPage(state) {
  const video = state.selectedVideoDetail;
  if (!video) {
    return `
      <article class="grid-card video-detail-empty">
        <div class="empty-detail">
          <svg class="empty-icon" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <h3>没有找到这个视频</h3>
          <p>它可能已被删除，或者本地服务还没有同步到最新数据。</p>
          <button class="secondary-button" data-action="back-library" style="margin-top: 16px;">返回视频库</button>
        </div>
      </article>
    `;
  }

  const regions = renderVideoDetailRegions(state);
  return `
    <section class="video-detail-page">
      <div class="detail-page-toolbar">
        <button class="secondary-button" data-action="back-library">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="19" y1="12" x2="5" y2="12"></line>
            <polyline points="12 19 5 12 12 5"></polyline>
          </svg>
          返回视频库
        </button>
      </div>

      <div id="video-detail-hero-region">${regions.hero}</div>

      <section class="video-detail-main">
        <div id="video-detail-result-region">${regions.result}</div>

        <aside class="video-detail-sidebar">
          <div id="video-detail-progress-region">${regions.progress}</div>
          <div id="video-detail-history-region">${regions.history}</div>
        </aside>
      </section>
    </section>
  `;
}

function renderVideoDetailRegions(state) {
  const video = state.selectedVideoDetail;
  const latestTask = state.selectedTaskDetail;
  const events = state.selectedTaskEvents || [];

  return {
    hero: `
      <article class="video-detail-hero">
        <a class="video-detail-cover" href="${escapeHtml(video.source_url)}" target="_blank" rel="noreferrer" aria-label="打开视频原链接：${escapeHtml(video.title)}">
          ${video.cover_url ? `<img src="${escapeHtml(video.cover_url)}" alt="${escapeHtml(video.title)}" loading="lazy" />` : `<div class="video-card-placeholder">VIDEO</div>`}
        </a>
        <div class="video-detail-copy">
          <div class="hero-chip-row">
            <span class="mini-chip ${video.latest_status === 'completed' ? 'success' : video.latest_status === 'running' ? 'running' : ''}">${escapeHtml(taskStatusLabel(video.latest_status))}</span>
            <span class="mini-chip">${escapeHtml(formatDuration(video.duration))}</span>
            <span class="mini-chip">${escapeHtml(formatDateTime(video.updated_at))}</span>
          </div>
          <h1 class="video-detail-title">${escapeHtml(video.title)}</h1>
          <div class="detail-hero-actions">
            <button class="primary-button" data-action="start-task" data-video-id="${video.video_id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
              ${video.latest_task_id ? "重新生成摘要" : "生成摘要"}
            </button>
            <button class="secondary-button" data-action="refresh-video" data-video-id="${video.video_id}" data-video-url="${escapeHtml(video.source_url)}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <polyline points="23 4 23 10 17 10"></polyline>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
              </svg>
              刷新视频信息
            </button>
            ${latestTask ? `<button class="secondary-button" data-action="delete-task" data-task-id="${latestTask.task_id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
              </svg>
              删除本次任务
            </button>` : ""}
            <button class="secondary-button danger-outline" data-action="delete-video" data-video-id="${video.video_id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
              </svg>
              从视频库删除
            </button>
          </div>
        </div>
      </article>
    `,
    result: `
      <section class="video-detail-primary">
        <article class="grid-card detail-section-card">
          <div class="panel-header">
            <h2>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
              </svg>
              摘要结果
            </h2>
            <p>当前视频的最新结果</p>
          </div>
          ${video.latest_result ? renderResultPanels(video.latest_result) : `<div class="empty-placeholder">当前还没有可展示的摘要结果。</div>`}
        </article>
      </section>
    `,
    progress: `
      <article class="grid-card detail-side-card">
        <div class="panel-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            处理进度
          </h2>
          <p>${latestTask ? `当前任务 ${escapeHtml(latestTask.task_id.slice(0, 8))}` : "尚未开始处理"}</p>
        </div>
        ${latestTask ? renderTaskProgressSimple(events) : `<div class="empty-placeholder">点击"开始总结"后，这里会展示处理进度。</div>`}
      </article>
    `,
    history: `
      <article class="grid-card detail-side-card">
        <div class="panel-header">
          <h2>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
            任务历史
          </h2>
          <p>${state.selectedVideoTasks.length} 条任务记录</p>
        </div>
        <div class="task-history-list">
          ${state.selectedVideoTasks.length ? state.selectedVideoTasks.map((task) => renderTaskHistoryItemSimple(task, state.selectedTaskId)).join("") : `<div class="empty-placeholder">暂无历史任务</div>`}
        </div>
      </article>
    `,
  };
}

function renderProbePreview(preview) {
  return `
    <article class="probe-preview">
      ${preview.cover_url ? `<img src="${escapeHtml(preview.cover_url)}" alt="${escapeHtml(preview.title)}" loading="lazy" />` : `<div class="video-card-placeholder">VIDEO</div>`}
      <div class="probe-preview-copy">
        <strong>${escapeHtml(preview.title)}</strong>
        <span>${escapeHtml(formatDuration(preview.duration))}</span>
      </div>
    </article>
  `;
}

function renderVideoCard(video) {
  const badgeClass =
    video.latest_status === "completed"
      ? "status-success"
      : video.latest_status === "running"
        ? "status-running"
        : video.latest_status === "failed"
          ? "status-failed"
          : "status-pending";
  
  // 截断过长的时间显示
  const timeStr = formatDateTime(video.updated_at);
  const shortTime = timeStr.length > 16 ? timeStr.slice(0, 16) + "..." : timeStr;
  
  return `
    <article class="video-card" data-video-id="${video.video_id}" role="button" tabindex="0" aria-label="打开视频详情：${escapeHtml(video.title)}">
      <div class="video-card-cover">
        ${video.cover_url ? `<img src="${escapeHtml(video.cover_url)}" alt="${escapeHtml(video.title)}" loading="lazy" />` : `<div class="video-card-placeholder">VIDEO</div>`}
        <span class="video-duration">${escapeHtml(formatDuration(video.duration))}</span>
      </div>
      <div class="video-card-body">
        <h3 title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</h3>
        <div class="video-card-meta">
          <span class="task-status ${badgeClass}">${escapeHtml(taskStatusLabel(video.latest_status))}</span>
          <span style="color: var(--text-tertiary);" title="${escapeHtml(timeStr)}">${escapeHtml(shortTime)}</span>
        </div>
      </div>
    </article>
  `;
}

function renderTaskProgressSimple(events) {
  const view = buildTaskProgressView(events);
  const fillClass = view.hasError ? "error" : view.isCompleted ? "success" : "";

  return `
    <div class="task-progress-simple">
      <div class="progress-bar-wrapper">
        <div id="task-progress-bar" class="progress-bar-simple" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(view.progress)}" aria-label="任务进度">
          <div id="task-progress-fill" class="progress-fill-simple ${fillClass}" style="width: ${view.progress}%"></div>
        </div>
        <div class="progress-info-simple">
          <span id="task-progress-percent" class="progress-percent-simple">${Math.round(view.progress)}%</span>
          <span id="task-progress-status" class="progress-status-simple">${view.headlineEvent ? escapeHtml(view.headlineEvent.message) : "等待开始..."}</span>
        </div>
      </div>

      <details class="progress-stage-card">
        <summary>
          <div>
            <strong id="task-progress-title">${escapeHtml(view.title)}</strong>
            <span id="task-progress-subtitle">${escapeHtml(view.subtitle)}</span>
          </div>
          <span class="progress-stage-toggle">展开详细</span>
        </summary>
        <div id="task-progress-events" class="progress-stage-list">
          ${renderTaskProgressEvents(events)}
        </div>
      </details>
    </div>
  `;
}

function renderResultPanels(result) {
  return `
    <div class="detail-result-stack">
      <section class="grid-card result-card">
        <div class="card-header">
          <h3>摘要概览</h3>
        </div>
        <div class="timeline ${result.overview ? "" : "empty-state"}">
          ${result.overview ? `<p>${escapeHtml(result.overview)}</p>` : `<div class="empty-placeholder">暂无摘要概览</div>`}
        </div>
      </section>
      <section class="grid-card result-card">
        <div class="card-header">
          <h3>关键要点</h3>
          <span class="result-count">${result.key_points?.length || 0} 条</span>
        </div>
        <ul class="bullet-list ${result.key_points?.length ? "" : "empty-state"}">
          ${result.key_points?.length ? result.key_points.map((item) => `<li>${escapeHtml(item)}</li>`).join("") : `<div class="empty-placeholder">暂无关键要点</div>`}
        </ul>
      </section>
      <section class="grid-card result-card">
        <div class="card-header">
          <h3>时间轴</h3>
          <span class="result-count">${result.timeline?.length || 0} 段</span>
        </div>
        <div class="timeline ${result.timeline?.length ? "" : "empty-state"}">
          ${result.timeline?.length ? result.timeline.map((item, index) => `
            <article class="timeline-item">
              <div class="timeline-marker" aria-hidden="true">${index + 1}</div>
              <div class="timeline-content">
                <h4>${escapeHtml(item.title || "章节")}</h4>
                <div class="timeline-meta">
                  <span class="timeline-time">${escapeHtml(formatDuration(item.start))}</span>
                </div>
                <p>${escapeHtml(item.summary || "")}</p>
              </div>
            </article>
          `).join("") : `<div class="empty-placeholder">暂无时间轴</div>`}
        </div>
      </section>
      <section class="grid-card transcript-card">
        <div class="card-header">
          <h3>转写全文</h3>
        </div>
        <pre class="transcript ${result.transcript_text ? "" : "empty-state"}">${escapeHtml(result.transcript_text || "暂无转写全文")}</pre>
      </section>
    </div>
  `;
}

function renderTaskHistoryItemSimple(task, selectedTaskId) {
  const active = task.task_id === selectedTaskId;
  const statusClass = task.status === "completed" ? "status-success" :
                      task.status === "failed" ? "status-failed" :
                      task.status === "running" ? "status-running" : "status-pending";
  
  return `
    <details class="task-history-item ${active ? "active" : ""}" ${active ? "open" : ""}>
      <summary class="task-history-summary" data-action="select-task" data-task-id="${task.task_id}">
        <div class="task-history-main">
          <span class="task-history-status ${statusClass}">${escapeHtml(taskStatusLabel(task.status))}</span>
          <span class="task-history-time">${escapeHtml(formatDateTime(task.created_at))}</span>
        </div>
        <div class="task-history-meta">
          ${active ? `<span class="task-history-item-current">当前查看</span>` : ""}
          <span class="task-history-id">${escapeHtml(task.task_id.slice(0, 8))}</span>
          <svg class="expand-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
      </summary>
      <div class="task-history-details">
        <div class="task-history-info">
          <div class="info-row">
            <span class="info-label">任务 ID</span>
            <span class="info-value code">${escapeHtml(task.task_id)}</span>
          </div>
          <div class="info-row">
            <span class="info-label">创建时间</span>
            <span class="info-value">${escapeHtml(formatDateTime(task.created_at))}</span>
          </div>
          <div class="info-row">
            <span class="info-label">更新时间</span>
            <span class="info-value">${escapeHtml(formatDateTime(task.updated_at))}</span>
          </div>
          <div class="info-row">
            <span class="info-label">LLM Token</span>
            <span class="info-value">${escapeHtml(formatTokenCount(task.llm_total_tokens))}</span>
          </div>
          <div class="info-row">
            <span class="info-label">任务耗时</span>
            <span class="info-value">${escapeHtml(formatTaskDuration(task.task_duration_seconds))}</span>
          </div>
          ${task.error_message ? `
          <div class="info-row error">
            <span class="info-label">错误信息</span>
            <span class="info-value">${escapeHtml(task.error_message)}</span>
          </div>
          ` : ""}
        </div>
        <div class="task-history-actions">
          <button class="tertiary-button danger" data-action="delete-task" data-task-id="${task.task_id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
            </svg>
            删除
          </button>
        </div>
      </div>
    </details>
  `;
}

function getStageLabel(stageKey, stages) {
  if (stageKey === "failed") return "失败";
  return stages.find((stage) => stage.key === stageKey)?.label || stageKey || "未知阶段";
}

function renderStageEventCard(event, stages, currentEvent, failedEvent) {
  const isFailed = event.stage === "failed";
  const isCurrent = currentEvent?.event_id === event.event_id;
  const statusClass = isFailed ? "error" : isCurrent ? "active" : "completed";

  return `
    <article class="progress-event-card ${statusClass}">
      <div class="progress-event-index">${escapeHtml(getStageLabel(event.stage, stages))}</div>
      <div class="progress-event-copy">
        <div class="progress-event-topline">
          <strong>${escapeHtml(event.message || getStageLabel(event.stage, stages))}</strong>
          <span>${escapeHtml(formatDateTime(event.created_at))}</span>
        </div>
        ${event.progress != null ? `<div class="progress-event-meta">阶段进度 ${escapeHtml(String(Math.round(Number(event.progress))))}%</div>` : ""}
        ${failedEvent?.event_id === event.event_id ? `<div class="progress-event-meta error-text">任务执行中断</div>` : ""}
      </div>
    </article>
  `;
}

function renderEmptyLibrary() {
  return `
    <div class="empty-placeholder">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 12px; opacity: 0.5;" aria-hidden="true">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <p>还没有视频，先输入一个链接开始总结。</p>
    </div>
  `;
}
