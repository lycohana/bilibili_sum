import type { TaskDetail, TaskMindMapResponse, TaskResult, TaskSummary, TimelineItem } from "./types";

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

export type ChapterGroup = {
  id: string;
  title: string;
  meta: string;
  items: KnowledgeCard[];
};

export type TaskContentState = {
  tone: "empty" | "pending" | "failed";
  title: string;
  description: string;
  detail?: string;
};

export type MindMapWorkspaceState = {
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
        title: "",
        content: item,
      });
    });

  if (timeline.length) {
    timeline.forEach((item, index) => {
      const title = resolveContentTitle(String(item.title || "").trim(), [], String(item.summary || "").trim(), `章节 ${index + 1}`);
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

export function buildChapterGroups(cards: KnowledgeCard[], result?: TaskResult | null): ChapterGroup[] {
  const backendGroups = Array.isArray(result?.chapter_groups) ? result?.chapter_groups : [];
  if (backendGroups.length) {
    const groups: ChapterGroup[] = [];
    backendGroups.forEach((group, groupIndex) => {
      if (!group || typeof group !== "object") {
        return;
      }
      const children = Array.isArray(group.children) ? group.children : [];
      const items = children
        .map((item, childIndex) => buildChapterCardFromTimelineItem(item, `${groupIndex}-${childIndex}`))
        .filter((item): item is KnowledgeCard => Boolean(item));

      if (!items.length) {
        return;
      }

      const title = resolveContentTitle(String(group.title || "").trim(), items.map((item) => item.title), String(group.summary || "").trim(), "主题");
      const explicitMeta = String(group.summary || "").trim();
      const timeRange = [
        formatOptionalMarkdownDuration(typeof group.start === "number" ? group.start : items[0]?.timestampSeconds),
        formatOptionalMarkdownDuration(items[items.length - 1]?.timestampSeconds),
      ]
        .filter(Boolean)
        .join(" - ");
      const meta = explicitMeta || [timeRange, `${items.length} 个小章节`].filter(Boolean).join(" · ");

      groups.push({
        id: `chapter-group-${groupIndex}`,
        title,
        meta,
        items,
      });
    });

    if (groups.length) {
      return groups;
    }
  }

  const chapterCards = cards.filter((item) => item.kind === "chapter");
  if (!chapterCards.length) {
    return [];
  }

  const groupSize = chapterCards.length <= 4 ? 2 : 3;
  const groups: ChapterGroup[] = [];

  for (let index = 0; index < chapterCards.length; index += groupSize) {
    const items = chapterCards.slice(index, index + groupSize);
    const first = items[0];
    const last = items[items.length - 1];
    const title = resolveContentTitle("", items.map((item) => item.title), items.map((item) => item.title).join("；"), "主题");
    const timeRange = [formatOptionalMarkdownDuration(first.timestampSeconds), formatOptionalMarkdownDuration(last.timestampSeconds)]
      .filter(Boolean)
      .join(" - ");
    const meta = [timeRange, `${items.length} 个小章节`].filter(Boolean).join(" · ");

    groups.push({
      id: `chapter-group-${groups.length}`,
      title,
      meta,
      items,
    });
  }

  return groups;
}

function buildChapterCardFromTimelineItem(item: TimelineItem, idSuffix: string): KnowledgeCard | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const summary = String(item.summary || "").trim();
  const title = resolveContentTitle(String(item.title || "").trim(), [], summary, "章节");
  const content = String(item.summary || "").trim();
  if (!title && !content) {
    return null;
  }
  return {
    id: `chapter-${idSuffix}`,
    kind: "chapter",
    eyebrow: "Chapter",
    title: title || "章节",
    content: content || "当前章节暂未生成摘要。",
    timestampSeconds: typeof item.start === "number" ? item.start : null,
  };
}

function resolveContentTitle(title: string, childTitles: string[], fallbackText: string, prefix: string) {
  const normalizedTitle = normalizeTitle(title);
  if (normalizedTitle && !isPlaceholderTitle(normalizedTitle)) {
    return normalizedTitle;
  }

  for (const childTitle of childTitles) {
    const normalizedChildTitle = normalizeTitle(childTitle);
    if (normalizedChildTitle && !isPlaceholderTitle(normalizedChildTitle)) {
      return normalizedChildTitle;
    }
  }

  const derived = deriveTitleFromText(fallbackText);
  if (derived) {
    return derived;
  }

  return prefix;
}

function normalizeTitle(value: string) {
  return value.trim().replace(/^[\-•\d.()、\s]+/, "").slice(0, 24);
}

function isPlaceholderTitle(value: string) {
  const normalized = value.trim().toLowerCase();
  return /^(大)?章节\s*\d+$/.test(value.trim())
    || /^第?\s*\d+\s*(章|节|部分)$/.test(value.trim())
    || /^(part|section|chapter)\s*[-:：]?\s*\d+$/.test(normalized);
}

function deriveTitleFromText(value: string) {
  const compact = value
    .trim()
    .replace(/^(这一部分|本部分|这里|该部分|这一章|本章|本节|这一节)(主要)?(讲|介绍|讨论|说明|分析|围绕)?/, "")
    .split(/[。；!！?？\n]/)[0]
    ?.trim()
    .replace(/^[：:\-]+|[，,、；;：:]+$/g, "")
    .replace(/\s+/g, "");
  if (!compact) {
    return "";
  }
  return compact.slice(0, 24);
}

export function resolveKnowledgeNoteMarkdown(result?: TaskResult | null): string {
  if (!result) {
    return "";
  }

  const directMarkdown = String(result.knowledge_note_markdown || "").trim();
  if (directMarkdown) {
    return directMarkdown;
  }

  const sections: string[] = [];
  const overview = String(result.overview || "").trim();
  const keyPoints = Array.isArray(result.key_points) ? result.key_points.map((item) => item.trim()).filter(Boolean) : [];
  const timeline = Array.isArray(result.timeline) ? result.timeline : [];

  if (overview) {
    sections.push("## 摘要概览", "", overview);
  }

  if (keyPoints.length) {
    sections.push("", "## 关键要点", "");
    sections.push(...keyPoints.map((item) => `- ${item}`));
  }

  if (timeline.length) {
    sections.push("", "## 时间轴", "");
    timeline.forEach((item, index) => {
      const title = String(item.title || "").trim() || `章节 ${index + 1}`;
      const summary = String(item.summary || "").trim();
      const start = typeof item.start === "number" ? item.start : null;
      sections.push(`### ${title}`);
      if (start != null) {
        sections.push("", `- 时间点：${formatMarkdownDuration(start)}`);
      }
      if (summary) {
        sections.push("", summary);
      }
      sections.push("");
    });
  }

  return sections.join("\n").trim();
}

function formatMarkdownDuration(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatOptionalMarkdownDuration(totalSeconds?: number | null) {
  if (typeof totalSeconds !== "number") {
    return "";
  }
  return formatMarkdownDuration(totalSeconds);
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

export function describeMindMapWorkspace(
  task?: Pick<TaskDetail, "status" | "result" | "error_message"> | null,
  mindmap?: Pick<TaskMindMapResponse, "status" | "error_message" | "mindmap"> | null,
): MindMapWorkspaceState | null {
  if (mindmap?.status === "ready" && mindmap.mindmap) {
    return null;
  }
  if (!task) {
    return {
      tone: "default",
      title: "当前还没有可生成导图的任务",
      description: "请选择一个已完成任务。导图会基于当前任务的知识卡片和知识笔记按需生成。",
      actionLabel: "等待可用任务",
      actionEnabled: false,
    };
  }
  if (mindmap?.status === "generating" || task.result?.mindmap_status === "generating") {
    return {
      tone: "pending",
      title: "思维导图正在生成",
      description: "系统正在基于当前任务的摘要结果组织主题树，稍后会自动显示在这里。",
      actionLabel: "生成中",
      actionEnabled: false,
    };
  }
  if (mindmap?.status === "failed" || task.result?.mindmap_status === "failed") {
    return {
      tone: "failed",
      title: "思维导图生成失败",
      description: mindmap?.error_message || task.result?.mindmap_error_message || task.error_message || "这次处理没有成功生成可展示的导图。",
      actionLabel: "重新生成导图",
      actionEnabled: true,
    };
  }
  if (task.status === "running" || task.status === "queued") {
    return {
      tone: "pending",
      title: "任务完成后才能生成导图",
      description: "当前任务仍在处理中。等摘要和知识笔记准备好后，就可以按需生成思维导图。",
      actionLabel: "处理中",
      actionEnabled: false,
    };
  }
  if (task.status === "failed" || task.status === "cancelled") {
    return {
      tone: "failed",
      title: "当前任务暂时无法生成导图",
      description: task.error_message || "这次处理没有产出可用于导图组织的结果。",
      actionLabel: "等待可用结果",
      actionEnabled: false,
    };
  }
  return {
    tone: "accent",
    title: "当前任务已可生成思维导图",
    description: "导图会按主题重组知识卡片、章节结构和知识笔记，并在叶子节点保留可回看时间点。",
    actionLabel: "生成思维导图",
    actionEnabled: true,
  };
}
