import { useEffect, useRef, useState } from "react";

export function TitleBar({
  darkMode,
  onToggleTheme,
  serviceOnline,
  backendRunning,
  runtimeDeviceLabel,
  version,
}: {
  darkMode: boolean;
  onToggleTheme(): void;
  serviceOnline: boolean;
  backendRunning?: boolean;
  runtimeDeviceLabel: string;
  version: string;
}) {
  const [isMaximized, setIsMaximized] = useState(false);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const statusPopoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    async function checkMaximized() {
      if (window.desktop) {
        const maximized = await window.desktop.window.isMaximized();
        setIsMaximized(maximized);
      }
    }
    void checkMaximized();
  }, []);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!statusPopoverRef.current?.contains(event.target as Node)) {
        setStatusPopoverOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, []);

  const handleMaximize = async () => {
    if (window.desktop) {
      await window.desktop.window.maximize();
      const maximized = await window.desktop.window.isMaximized();
      setIsMaximized(maximized);
    }
  };

  const handleMinimize = async () => {
    if (window.desktop) {
      await window.desktop.window.minimize();
    }
  };

  const handleClose = async () => {
    if (window.desktop) {
      await window.desktop.window.close();
    }
  };

  const serviceStatusText = serviceOnline ? "在线" : backendRunning ? "启动中" : "离线";

  return (
    <div className="title-bar">
      <div className="title-bar-sidebar-brand">
        <div className="title-bar-brand-mark">
          <img src="/static/assets/icons/icon.svg" alt="" />
        </div>
        <span className="title-bar-brand-text">BriefVid</span>
      </div>
      <div className="title-bar-drag-region" />
      <div className="title-bar-controls">
        <div
          className={`title-bar-status-wrap ${statusPopoverOpen ? "is-open" : ""}`}
          ref={statusPopoverRef}
          onMouseEnter={() => setStatusPopoverOpen(true)}
          onMouseLeave={() => setStatusPopoverOpen(false)}
        >
          <button
            className={`title-bar-status-pill ${serviceOnline ? "is-success" : ""}`}
            type="button"
            onClick={() => setStatusPopoverOpen((current) => !current)}
            aria-label="查看运行状态"
            aria-expanded={statusPopoverOpen}
            title="运行状态"
          >
            <span className={`title-bar-status-dot ${serviceOnline ? "is-success" : backendRunning ? "is-pending" : ""}`} />
            <span>运行状态</span>
          </button>

          <div className={`title-bar-status-popover ${statusPopoverOpen ? "is-visible" : ""}`} role="dialog" aria-label="运行状态详情">
            <div className="title-bar-status-header">
              <h2>运行状态</h2>
            </div>
            <div className="title-bar-status-stack">
              <div className={`sidebar-status-item ${serviceOnline ? "is-success" : ""}`}>
                <span>服务</span>
                <strong>{serviceStatusText}</strong>
              </div>
              <div className="sidebar-status-item">
                <span>设备</span>
                <strong>{runtimeDeviceLabel}</strong>
              </div>
              <div className="sidebar-status-item">
                <span>版本</span>
                <strong>{version || "-"}</strong>
              </div>
            </div>
          </div>
        </div>
        <button
          className="title-bar-button"
          type="button"
          onClick={onToggleTheme}
          aria-label={darkMode ? "切换到浅色模式" : "切换到深色模式"}
          title={darkMode ? "浅色模式" : "深色模式"}
        >
          {darkMode ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2.5v2.25M12 19.25v2.25M4.75 12H2.5M21.5 12h-2.25M5.9 5.9 4.3 4.3M19.7 19.7l-1.6-1.6M18.1 5.9l1.6-1.6M4.3 19.7l1.6-1.6" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 15.5A8.5 8.5 0 1 1 12.5 4a6.5 6.5 0 0 0 7.5 11.5Z" />
            </svg>
          )}
        </button>
        <button
          className="title-bar-button"
          type="button"
          onClick={handleMinimize}
          aria-label="最小化"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 6H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <button
          className="title-bar-button"
          type="button"
          onClick={handleMaximize}
          aria-label={isMaximized ? "还原" : "最大化"}
        >
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1.5" y="3.5" width="7" height="7" stroke="currentColor" strokeWidth="1.5" />
              <path d="M3.5 3.5V1.5H9.5V3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </button>
        <button
          className="title-bar-button close"
          type="button"
          onClick={handleClose}
          aria-label="关闭"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
