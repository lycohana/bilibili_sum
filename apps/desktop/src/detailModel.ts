import type { TaskDetail, TaskResult, TaskSummary } from "./types";

export type DetailTab = "knowledge" | "summary" | "mindmap";
export type TaskPanelState = "collapsed" | "expanded";
export type KnowledgeCardKind = "overview" | "key-point" | "chapter";

export type KnowledgeCard = {
  id: string;
  kind: KnowledgeCardKind;
  eyebrow: string;
  title: string;
  content: string;
  meta?: string;
  timestampSeconds?: number | null;
};

export type TaskContentState = {
  tone: "empty" | "pending" | "failed";
  title: string;
  description: string;
  detail?: string;
};

export type MindMapPlaceholderState = {
  tone: "default" | "pending" | "failed" | "accent";
  title: string;
  description: string;
  actionLabel?: string;
  actionEnabled?: boolean;
};

export function pickDetailTaskId(tasks: TaskSummary[], preferredTaskId?: string | null): string | null {
  if (preferredTaskId && tasks.some((item) => item.task_id === preferredTaskId)) {
    return preferredTaskId;
  }
  const latestCompleted = tasks.find((item) => item.status === "completed");
  return latestCompleted?.task_id ?? tasks[0]?.task_id ?? null;
}

export function buildKnowledgeCards(result?: TaskResult | null): KnowledgeCard[] {
  if (!result) {
    return [];
  }

  const cards: KnowledgeCard[] = [];
  const overview = String(result.overview || "").trim();
  const keyPoints = Array.isArray(result.key_points) ? result.key_points : [];
  const timeline = Array.isArray(result.timeline) ? result.timeline : [];
  const segmentSummaries = Array.isArray(result.segment_summaries) ? result.segment_summaries : [];
  const chapterCount = timeline.length || segmentSummaries.length;

  if (overview) {
    cards.push({
      id: "overview",
      kind: "overview",
      eyebrow: "Overview",
      title: "核心概览",
      content: overview,
      meta: `${keyPoints.length} 个要点 · ${chapterCount} 个章节`,
    });
  }

  keyPoints
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item, index) => {
      cards.push({
        id: `key-point-${index}`,
        kind: "key-point",
        eyebrow: "Key Point",
        title: `要点 ${index + 1}`,
        content: item,
      });
    });

  if (timeline.length) {
    timeline.forEach((item, index) => {
      const title = String(item.title || "").trim() || `章节 ${index + 1}`;
      const content = String(item.summary || "").trim();
      cards.push({
        id: `chapter-${index}`,
        kind: "chapter",
        eyebrow: "Chapter",
        title,
        content: content || "当前章节暂未生成摘要。",
        timestampSeconds: typeof item.start === "number" ? item.start : null,
      });
    });
  } else {
    segmentSummaries
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item, index) => {
        cards.push({
          id: `chapter-${index}`,
          kind: "chapter",
          eyebrow: "Chapter",
          title: `章节 ${index + 1}`,
          content: item,
        });
      });
  }

  return cards;
}

export function describeTaskContentState(task?: Pick<TaskDetail, "status" | "result" | "error_message"> | null): TaskContentState | null {
  if (task?.result) {
    return null;
  }
  if (!task) {
    return {
      tone: "empty",
      title: "还没有可展示的任务内容",
      description: "开始处理后，这里会整理出摘要结果和知识卡片。",
    };
  }
  if (task.status === "running" || task.status === "queued") {
    return {
      tone: "pending",
      title: "当前任务还在处理中",
      description: "可以先查看顶部任务药丸中的实时进度，结果生成后这里会自动可用。",
    };
  }
  if (task.status === "failed" || task.status === "cancelled") {
    return {
      tone: "failed",
      title: "当前任务未生成可用结果",
      description: "可以切换到其他已完成任务，或重新发起摘要生成。",
      detail: task.error_message || undefined,
    };
  }
  return {
    tone: "empty",
    title: "当前任务还没有结果",
    description: "请选择其他已完成任务，或者重新生成摘要。",
  };
}

export function describeMindMapPlaceholder(task?: Pick<TaskDetail, "status" | "result" | "error_message"> | null): MindMapPlaceholderState {
  if (!task) {
    return {
      tone: "default",
      title: "主题树入口已预留",
      description: "当任务产出结果后，这里会承接按主题组织的知识导图视图。",
      actionLabel: "按需生成（即将开放）",
      actionEnabled: false,
    };
  }
  if (task.status === "running" || task.status === "queued") {
    return {
      tone: "pending",
      title: "主题树将在结果完成后可用",
      description: "当前任务仍在处理中。后续版本会支持基于本次结果按需生成主题树。",
      actionLabel: "处理中",
      actionEnabled: false,
    };
  }
  if (task.status === "failed" || task.status === "cancelled") {
    return {
      tone: "failed",
      title: "当前任务暂时无法生成主题树",
      description: task.error_message || "这次处理没有产出可用于导图组织的结果。",
      actionLabel: "重新生成导图（即将开放）",
      actionEnabled: false,
    };
  }
  return {
    tone: "accent",
    title: "主题树视图即将开放",
    description: "后续版本会基于当前任务结果按主题聚合概览、关键要点和章节内容。",
    actionLabel: "按需生成（即将开放）",
    actionEnabled: false,
  };
}
