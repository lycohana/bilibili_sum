import type { FormEvent } from "react";

import type { ConfigHealth } from "../appModel";
import { platformLabel } from "../appModel";
import { LinkIcon } from "../components/AppIcons";
import { FloatingNoticeStack } from "../components/FloatingNoticeStack";
import { VideoCard } from "../components/VideoCard";
import type { VideoAssetSummary } from "../types";
import { formatDuration } from "../utils";

type HomePageProps = {
  configHealth: ConfigHealth;
  probePreview: VideoAssetSummary | null;
  probeUrl: string;
  setProbeUrl(value: string): void;
  submitStatus: string;
  onProbe(event: FormEvent): Promise<void>;
  onOpenSetupAssistant(issueKey?: string): void;
  onOpenConfigIssue(issueKey: string): void;
  recentVideos: VideoAssetSummary[];
};

export function HomePage({
  configHealth,
  probePreview,
  probeUrl,
  setProbeUrl,
  submitStatus,
  onProbe,
  onOpenSetupAssistant,
  onOpenConfigIssue,
  recentVideos,
}: HomePageProps) {
  return (
    <section className="home-page">
      <FloatingNoticeStack notices={[{ id: "home-submit-status", message: submitStatus }]} />
      <div className="section">
        <h2 className="section-title">开始总结</h2>
        <form className="task-form" onSubmit={onProbe}>
          <div className="task-form-row">
            <label className="input-row input-row-hero" style={{ flex: 1 }}>
              <div className="input-with-icon" style={{ flex: 1 }}>
                <span className="input-icon" aria-hidden="true"><LinkIcon /></span>
                <input
                  className="input-field input-field-hero"
                  type="text"
                  value={probeUrl}
                  onChange={(event) => setProbeUrl(event.target.value)}
                  placeholder="粘贴视频链接或直接输入 BV 号，例如 BV1xx411c7mD"
                  required
                />
              </div>
            </label>
            <button className="primary-button primary-button-hero" type="submit">开始总结</button>
          </div>
        </form>

        {configHealth.checked && !configHealth.isConfigured ? (
          <article className={`config-alert-card tone-${configHealth.state}`}>
            <div className="config-alert-copy">
              <span className="section-kicker">运行配置提醒</span>
              <strong>{configHealth.hasBlockingIssues ? "当前缺少开始总结所需配置" : "当前有增强配置待补全"}</strong>
              <p>{configHealth.summary}</p>
              <div className="config-alert-list">
                {configHealth.issues.map((issue) => (
                  <button className="config-alert-item" type="button" key={issue.key} onClick={() => onOpenConfigIssue(issue.key)}>
                    <strong>{issue.title}</strong>
                    <span>{issue.description}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="config-alert-actions">
              <button
                className={configHealth.hasBlockingIssues ? "primary-button danger-button" : "secondary-button"}
                type="button"
                onClick={() => onOpenSetupAssistant(configHealth.blockingIssues[0]?.key || configHealth.issues[0]?.key)}
              >
                {configHealth.actionText}
              </button>
            </div>
          </article>
        ) : null}

        {probePreview && (
          <article className="probe-preview">
            <img src={probePreview.cover_url} alt={probePreview.title} />
            <div className="probe-preview-copy">
              <span className="section-kicker">即将加入视频库</span>
              <strong>{probePreview.title}</strong>
              <small>{formatDuration(probePreview.duration)} · {platformLabel(probePreview.platform)}</small>
            </div>
          </article>
        )}
      </div>

      <div className="section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h2 className="section-title" style={{ margin: 0 }}>最近视频</h2>
          <span className="helper-chip">{recentVideos.length} 个视频</span>
        </div>

        {recentVideos.length > 0 ? (
          <div className="video-grid">
            {recentVideos.map((video) => <VideoCard key={video.video_id} video={video} />)}
          </div>
        ) : (
          <div className="empty-placeholder">
            还没有视频，先输入一个链接开始总结吧。
          </div>
        )}
      </div>
    </section>
  );
}
