import { escapeHtml } from "../utils.js";

export function renderTasksView(state) {
  const detail = state.selectedTaskDetail;
  const events = state.selectedTaskEvents || [];
  const latestProgress = events.length ? Math.max(...events.map((item) => Number(item.progress || 0))) : 0;
  const latestEvent = events.length ? events[events.length - 1] : null;

  // 获取状态样式和图标
  const getStatusInfo = (status) => {
    const map = {
      completed: { class: "status-success", icon: "✓", label: "已完成" },
      running: { class: "status-running", icon: "⟳", label: "进行中" },
      failed: { class: "status-failed", icon: "✕", label: "失败" },
      pending: { class: "status-pending", icon: "○", label: "等待中" },
    };
    return map[status] || { class: "", icon: "○", label: status };
  };

  const statusInfo = getStatusInfo(detail?.status);

  return `
    <section class="task-layout">
      <!-- 左侧边栏 -->
      <section class="task-sidebar">
        <!-- 新建任务表单 -->
        <article class="grid-card task-form-card">
          <div class="panel-header">
            <h2>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              新建任务
            </h2>
            <p>提交视频链接开始处理</p>
          </div>

          <form id="task-form" class="task-form">
            <label class="input-group">
              <span class="input-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                </svg>
                视频链接
              </span>
              <input 
                id="url-input" 
                type="url" 
                placeholder="https://www.bilibili.com/video/..." 
                required 
                class="input-field"
              />
            </label>
            <label class="input-group">
              <span class="input-label">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
                标题（可选）
              </span>
              <input 
                id="title-input" 
                type="text" 
                placeholder="不填则由后端自动探测" 
                class="input-field"
              />
            </label>
            <button class="primary-button submit-btn" id="submit-button" type="submit">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              提交任务
            </button>
            ${state.submitStatus ? `
              <div id="submit-status" class="submit-status ${state.submitStatus.includes('成功') ? 'success' : state.submitStatus.includes('失败') ? 'error' : ''}">
                ${escapeHtml(state.submitStatus)}
              </div>
            ` : ''}
          </form>
        </article>

        <!-- 任务列表 -->
        <article class="grid-card task-list-card">
          <div class="panel-header">
            <h2>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              任务列表
              <span class="task-count">${state.tasks?.length || 0}</span>
            </h2>
            <p>点击任务查看详情</p>
          </div>
          <div id="task-list" class="task-list">
            ${renderTaskCards(state)}
          </div>
        </article>
      </section>

      <!-- 右侧详情区 -->
      <section class="task-detail">
        ${detail ? `
          <!-- 状态概览 -->
          <div class="task-detail-top">
            <div class="status-summary-card">
              <div class="status-summary-row">
                <div class="status-main">
                  <span class="status-badge-large ${statusInfo.class}">
                    <span class="status-icon">${statusInfo.icon}</span>
                    ${escapeHtml(statusInfo.label)}
                  </span>
                  <div class="status-message">${escapeHtml(latestEvent?.message || "等待任务执行")}</div>
                </div>
                <div class="status-meta">
                  <div class="meta-item">
                    <span class="meta-label">任务ID</span>
                    <span class="meta-value code">${escapeHtml(detail.task_id?.slice(0, 8) || "-")}</span>
                  </div>
                  <div class="meta-item">
                    <span class="meta-label">创建时间</span>
                    <span class="meta-value">${escapeHtml(detail.created_at)}</span>
                  </div>
                </div>
              </div>
              <div class="progress-section">
                <div class="progress-track">
                  <div class="progress-fill" style="width: ${latestProgress}%"></div>
                </div>
                <div class="progress-info">
                  <span class="progress-label">处理进度</span>
                  <span class="progress-value">${latestProgress}%</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 任务元信息 -->
          <div id="task-meta" class="task-meta">
            ${renderMeta(detail)}
          </div>

          <!-- 结果展示 -->
          <div class="result-grid">
            <section class="grid-card result-card">
              <div class="card-header">
                <h3>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 11 12 14 22 4"></polyline>
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                  </svg>
                  关键要点
                </h3>
                <span class="result-count">${detail.result?.key_points?.length || 0} 条</span>
              </div>
              <ul id="key-points" class="bullet-list ${detail.result?.key_points?.length ? "" : "empty-state"}">
                ${detail.result?.key_points?.length
                  ? detail.result.key_points.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
                  : "<div class='empty-placeholder'>暂无关键要点</div>"}
              </ul>
            </section>

            <section class="grid-card result-card">
              <div class="card-header">
                <h3>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                  </svg>
                  时间轴
                </h3>
                <span class="result-count">${detail.result?.timeline?.length || 0} 段</span>
              </div>
              <div id="timeline" class="timeline ${detail.result?.timeline?.length ? "" : "empty-state"}">
                ${detail.result?.timeline?.length ? renderTimeline(detail.result.timeline) : "<div class='empty-placeholder'>暂无时间轴数据</div>"}
              </div>
            </section>
          </div>

          <!-- 转写全文 -->
          <section class="grid-card transcript-card">
            <div class="card-header">
              <h3>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="16" y1="13" x2="8" y2="13"></line>
                  <line x1="16" y1="17" x2="8" y2="17"></line>
                  <polyline points="10 9 9 9 8 9"></polyline>
                </svg>
                转写全文
              </h3>
              <div class="header-actions">
                ${detail.result?.transcript_text ? `
                  <button class="icon-button" onclick="copyTranscript()" title="复制文本">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </button>
                ` : ''}
              </div>
            </div>
            <pre id="transcript" class="transcript ${detail.result?.transcript_text ? "" : "empty-state"}">${escapeHtml(detail.result?.transcript_text || "暂无转写内容")}</pre>
          </section>

          <!-- 处理事件 -->
          <section class="grid-card events-card">
            <div class="card-header">
              <h3>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 20h9"></path>
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                </svg>
                处理事件
              </h3>
              <span class="result-count">${events.length} 条</span>
            </div>
            <div id="events" class="events ${events.length ? "" : "empty-state"}">
              ${events.length ? renderEvents(events) : "<div class='empty-placeholder'>暂无事件记录</div>"}
            </div>
          </section>
        ` : `
          <!-- 空状态 -->
          <div class="empty-detail">
            <div class="empty-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
            </div>
            <h3>选择一个任务查看详情</h3>
            <p>从左侧任务列表中选择一个任务，或创建新任务开始处理</p>
          </div>
        `}
      </section>
    </section>
  `;
}

function renderTaskCards(state) {
  if (!state.tasks.length) {
    return `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 5v14M5 12h14"></path>
          </svg>
        </div>
        <p>还没有任务</p>
        <span>在上方提交一个视频链接开始</span>
      </div>
    `;
  }

  const getStatusClass = (status) => {
    if (status === "completed") return "status-success";
    if (status === "running") return "status-running";
    if (status === "failed") return "status-failed";
    return "status-pending";
  };

  const getStatusIcon = (status) => {
    if (status === "completed") return "✓";
    if (status === "running") return "⟳";
    if (status === "failed") return "✕";
    return "○";
  };

  return state.tasks
    .map((task) => {
      const active = task.task_id === state.selectedTaskId ? "active" : "";
      const statusClass = getStatusClass(task.status);
      const statusIcon = getStatusIcon(task.status);
      const title = task.title || task.source;
      const shortTitle = title.length > 35 ? title.slice(0, 35) + "..." : title;
      const shortSource = task.source.length > 40 ? task.source.slice(0, 40) + "..." : task.source;

      return `
        <article class="task-card ${active}" data-task-id="${task.task_id}">
          <div class="task-card-header">
            <span class="task-status ${statusClass}">
              <span class="status-icon">${statusIcon}</span>
              ${escapeHtml(task.status)}
            </span>
            <span class="task-time">${escapeHtml(task.created_at?.split(' ')[0] || "")}</span>
          </div>
          <h3 class="task-title">${escapeHtml(shortTitle)}</h3>
          <p class="task-source" title="${escapeHtml(task.source)}">${escapeHtml(shortSource)}</p>
        </article>
      `;
    })
    .join("");
}

function renderMeta(detail) {
  return `
    <div class="meta-grid">
      <div class="meta-item">
        <span class="meta-label">状态</span>
        <span class="meta-value">${escapeHtml(detail.status)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">任务ID</span>
        <span class="meta-value code">${escapeHtml(detail.task_id)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">来源</span>
        <span class="meta-value" title="${escapeHtml(detail.source)}">${escapeHtml(detail.source.length > 50 ? detail.source.slice(0, 50) + '...' : detail.source)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">创建时间</span>
        <span class="meta-value">${escapeHtml(detail.created_at)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">更新时间</span>
        <span class="meta-value">${escapeHtml(detail.updated_at)}</span>
      </div>
    </div>
  `;
}

function renderTimeline(items) {
  return items
    .map(
      (item, index) => `
        <article class="timeline-item">
          <div class="timeline-marker">${index + 1}</div>
          <div class="timeline-content">
            <h4>${escapeHtml(item.title || "章节")}</h4>
            <div class="timeline-meta">
              <span class="timeline-time">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                ${formatTime(item.start)}
              </span>
            </div>
            <p>${escapeHtml(item.summary || "")}</p>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderEvents(items) {
  return items
    .map(
      (item) => `
        <article class="event-item">
          <div class="event-header">
            <span class="event-stage">${escapeHtml(item.stage)}</span>
            <span class="event-progress">${escapeHtml(String(item.progress))}%</span>
          </div>
          <p>${escapeHtml(item.message)}</p>
          <span class="event-time">${escapeHtml(item.created_at || "")}</span>
        </article>
      `,
    )
    .join("");
}

function formatTime(seconds) {
  if (!seconds && seconds !== 0) return "-";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
