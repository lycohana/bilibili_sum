import type { ConfigHealth } from "../appModel";

type SetupAssistantDialogProps = {
  isOpen: boolean;
  configHealth: ConfigHealth;
  onClose(): void;
  onOpenSettings(): void;
  onNavigateToIssue(issueKey: string): void;
};

export function SetupAssistantDialog({
  isOpen,
  configHealth,
  onClose,
  onOpenSettings,
  onNavigateToIssue,
}: SetupAssistantDialogProps) {
  if (!isOpen || !configHealth.checked || configHealth.issues.length === 0) {
    return null;
  }

  return (
    <div className="update-dialog-overlay" onClick={onClose}>
      <div className="update-dialog setup-assistant-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="update-dialog-header">
          <h2>首次启动辅助配置</h2>
          <button className="close-button" type="button" onClick={onClose} aria-label="关闭">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="update-dialog-body setup-assistant-body">
          <div className={`setup-assistant-hero tone-${configHealth.state}`}>
            <span className="section-kicker">Setup Assistant</span>
            <strong>{configHealth.hasBlockingIssues ? "先补全关键配置，才能顺利开始总结" : "当前建议先补全增强能力配置"}</strong>
            <p>{configHealth.summary}</p>
          </div>

          <div className="setup-assistant-sequence">
            <div className="setup-assistant-step">
              <span>1</span>
              <div>
                <strong>先补基础转写能力</strong>
                <p>优先保证“云端转写 API Key”或“本地 ASR 运行时”可用，这是开始处理视频的前提。</p>
              </div>
            </div>
            <div className="setup-assistant-step">
              <span>2</span>
              <div>
                <strong>再补 LLM 增强能力</strong>
                <p>如果你希望获得更好的摘要和知识笔记，再补齐 LLM 的 Base URL、模型名和 API Key。</p>
              </div>
            </div>
            <div className="setup-assistant-step">
              <span>3</span>
              <div>
                <strong>保存后回到首页开始总结</strong>
                <p>完成保存后，运行状态会自动刷新，红色告警也会消失。</p>
              </div>
            </div>
          </div>

          <div className="setup-assistant-issues">
            {configHealth.issues.map((issue) => (
              <button
                className={`setup-assistant-issue tone-${issue.severity === "critical" ? "critical" : "warning"}`}
                type="button"
                key={issue.key}
                onClick={() => onNavigateToIssue(issue.key)}
              >
                <strong>{issue.title}</strong>
                <p>{issue.description}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="update-dialog-footer">
          <button className="secondary-button" type="button" onClick={onClose}>稍后再说</button>
          <button className={configHealth.hasBlockingIssues ? "primary-button danger-button" : "primary-button"} type="button" onClick={onOpenSettings}>
            {configHealth.actionText}
          </button>
        </div>
      </div>
    </div>
  );
}
