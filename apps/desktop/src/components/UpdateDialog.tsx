import { useEffect, useState } from "react";

import { MarkdownContent } from "./MarkdownContent";

export type UpdateStatus = "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "installing" | "error";

export type UpdateInfo = {
  status: UpdateStatus;
  version: string;
  releaseDate: string;
  releaseNotes: string | null;
  downloadProgress: number;
  errorMessage: string | null;
};

type UpdateDialogProps = {
  isOpen: boolean;
  updateInfo: UpdateInfo | null;
  currentVersion: string;
  onClose: () => void;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
};

export function UpdateDialog({
  isOpen,
  updateInfo,
  currentVersion,
  onClose,
  onCheck,
  onDownload,
  onInstall,
}: UpdateDialogProps) {
  const [isChecking, setIsChecking] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    if (updateInfo?.status === "checking") {
      setIsChecking(true);
    } else {
      setIsChecking(false);
    }

    if (updateInfo?.status === "downloading") {
      setIsDownloading(true);
    } else {
      setIsDownloading(false);
    }
  }, [updateInfo]);

  if (!isOpen) {
    return null;
  }

  const handleCheck = async () => {
    setIsChecking(true);
    try {
      await onCheck();
    } catch {}
  };

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      await onDownload();
    } catch {}
  };

  const renderErrorAlert = () => {
    if (!updateInfo?.errorMessage || (updateInfo.status !== "error" && updateInfo.status !== "not-available")) {
      return null;
    }

    return (
      <div className="error-alert">
        <svg className="error-alert-icon" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
          <path d="M12 8V12M12 16H12.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <div className="error-alert-content">
          <h4>{updateInfo.status === "not-available" ? "自动更新不可用" : "检查更新失败"}</h4>
          <p>{updateInfo.errorMessage}</p>
        </div>
      </div>
    );
  };

  const getStatusText = () => {
    if (!updateInfo) return "未检查更新";

    switch (updateInfo.status) {
      case "checking":
        return "正在检查更新...";
      case "available":
        return `发现新版本：${updateInfo.version}`;
      case "not-available":
        return updateInfo.errorMessage ? `自动更新不可用：${updateInfo.errorMessage}` : "已是最新版本";
      case "downloading":
        return `正在下载更新并准备安装... ${Math.round(updateInfo.downloadProgress)}%`;
      case "downloaded":
        return `更新已下载完成：${updateInfo.version}`;
      case "installing":
        return `正在重启并安装更新：${updateInfo.version}`;
      case "error":
        return `更新出错：${updateInfo.errorMessage}`;
      default:
        return "未检查更新";
    }
  };

  const getStatusIcon = () => {
    if (!updateInfo) return null;

    switch (updateInfo.status) {
      case "checking":
        return (
          <svg className="status-icon" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4" />
          </svg>
        );
      case "available":
        return (
          <svg className="status-icon accent" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L15 8L21 9L17 14L18 20L12 17L6 20L7 14L3 9L9 8L12 2Z" fill="currentColor" />
          </svg>
        );
      case "not-available":
        return (
          <svg className="status-icon success" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.2" />
            <path d="M8 12L11 15L16 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case "downloading":
        return (
          <svg className="status-icon accent" viewBox="0 0 24 24" fill="none">
            <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points="17 8 12 3 7 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case "downloaded":
        return (
          <svg className="status-icon success" viewBox="0 0 24 24" fill="none">
            <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <polyline points="7 10 12 15 17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case "installing":
        return (
          <svg className="status-icon accent" viewBox="0 0 24 24" fill="none">
            <path d="M12 3V7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M12 17V21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M3 12H7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M17 12H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M5.64 5.64L8.46 8.46" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M15.54 15.54L18.36 18.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M18.36 5.64L15.54 8.46" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M8.46 15.54L5.64 18.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        );
      case "error":
        return (
          <svg className="status-icon error" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
            <path d="M12 8V12M12 16H12.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        );
      default:
        return null;
    }
  };

  const formatReleaseDate = (dateString: string) => {
    if (!dateString) return "";
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
    } catch {
      return dateString;
    }
  };

  const renderReleaseNotes = () => {
    // 当已是最新版本时，如果有更新日志则显示，否则显示提示
    if (updateInfo?.status === "not-available") {
      if (updateInfo.releaseNotes) {
        const notes = updateInfo.releaseNotes.trim();
        const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(notes);
        if (looksLikeHtml) {
          return <div className="release-notes-content" dangerouslySetInnerHTML={{ __html: notes }} />;
        }
        return <MarkdownContent className="release-notes-content" content={notes} />;
      }
      return <p className="release-notes-empty">当前已是最新版本，暂无更新日志</p>;
    }
    
    if (!updateInfo?.releaseNotes) {
      return <p className="release-notes-empty">暂无更新日志</p>;
    }

    const notes = updateInfo.releaseNotes.trim();
    const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(notes);

    if (looksLikeHtml) {
      return <div className="release-notes-content" dangerouslySetInnerHTML={{ __html: notes }} />;
    }

    return <MarkdownContent className="release-notes-content" content={notes} />;
  };

  return (
    <div className="update-dialog-overlay" onClick={onClose}>
      <div className="update-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="update-dialog-header">
          <h2>检查更新</h2>
          <button className="close-button" onClick={onClose} aria-label="关闭">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="update-dialog-body">
          <div className="current-version">
            <span>当前版本</span>
            <code>v{currentVersion}</code>
          </div>

          <div className="update-status">
            {getStatusIcon()}
            <span className="status-text">{getStatusText()}</span>
          </div>

          {updateInfo?.status === "error" && renderErrorAlert()}

          {updateInfo?.status === "downloading" && (
            <div className="download-progress">
              <div className="progress-bar">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${updateInfo.downloadProgress}%` }}
                />
              </div>
            </div>
          )}

          {(updateInfo?.status === "available" || updateInfo?.status === "downloaded") && (
            <div className="update-info">
              <div className="new-version">
                <span>新版本</span>
                <strong>v{updateInfo.version}</strong>
              </div>
              {updateInfo.releaseDate && (
                <div className="release-date">
                  <span>发布日期</span>
                  <time>{formatReleaseDate(updateInfo.releaseDate)}</time>
                </div>
              )}
            </div>
          )}

          <div className="release-notes-section">
            <h3>更新日志</h3>
            <div className="release-notes">
              {updateInfo?.status === "checking" ? (
                <p className="release-notes-loading">正在加载更新日志...</p>
              ) : updateInfo?.status === "idle" ? (
                <p className="release-notes-empty">点击"检查更新"按钮查看更新日志</p>
              ) : (
                renderReleaseNotes()
              )}
            </div>
          </div>
        </div>

        <div className="update-dialog-footer">
          {updateInfo?.status === "idle" || updateInfo?.status === "not-available" ? (
            <button className="primary-button" onClick={handleCheck} disabled={isChecking}>
              {isChecking ? "检查中..." : "检查更新"}
            </button>
          ) : null}

          {updateInfo?.status === "error" ? (
            <button className="primary-button" onClick={handleCheck} disabled={isChecking}>
              {isChecking ? "检查中..." : "重试"}
            </button>
          ) : null}

          {updateInfo?.status === "available" ? (
            <>
              <button className="secondary-button" onClick={onClose}>
                稍后提醒
              </button>
              <button className="primary-button" onClick={handleDownload} disabled={isDownloading}>
                {isDownloading ? "下载中..." : "下载并重启安装"}
              </button>
            </>
          ) : null}

          {updateInfo?.status === "downloaded" ? (
            <>
              <button className="secondary-button" onClick={onClose}>
                稍后安装
              </button>
              <button className="primary-button" onClick={onInstall}>
                立即重启安装
              </button>
            </>
          ) : null}

          {updateInfo?.status === "downloading" ? (
            <button className="secondary-button" onClick={onClose} disabled>
              下载中...
            </button>
          ) : null}

          {updateInfo?.status === "checking" ? (
            <button className="secondary-button" onClick={onClose} disabled>
              检查中...
            </button>
          ) : null}

          {updateInfo?.status === "installing" ? (
            <button className="secondary-button" onClick={onClose} disabled>
              安装中...
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
