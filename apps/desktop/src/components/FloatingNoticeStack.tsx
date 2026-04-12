type FloatingNoticeTone = "info" | "success" | "error";

export type FloatingNotice = {
  id: string;
  message: string;
  tone?: FloatingNoticeTone;
};

function inferTone(message: string): FloatingNoticeTone {
  if (/失败|错误|不可用|未就绪|停止|关闭/i.test(message)) {
    return "error";
  }
  if (/完成|成功|已复制|已保存|已刷新|已开始|已请求|已切换/i.test(message)) {
    return "success";
  }
  return "info";
}

export function FloatingNoticeStack({ notices }: { notices: FloatingNotice[] }) {
  const visibleNotices = notices.filter((notice) => notice.message.trim());

  if (!visibleNotices.length) {
    return null;
  }

  return (
    <div className="floating-notice-stack" aria-live="polite" aria-atomic="true">
      {visibleNotices.map((notice) => {
        const tone = notice.tone ?? inferTone(notice.message);
        return (
          <div className={`floating-notice-pill tone-${tone}`} key={notice.id} role="status">
            <span className="floating-notice-dot" aria-hidden="true" />
            <span className="floating-notice-copy">{notice.message}</span>
          </div>
        );
      })}
    </div>
  );
}
