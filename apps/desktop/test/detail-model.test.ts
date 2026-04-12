import assert from "node:assert/strict";

import { buildChapterGroups, buildKnowledgeCards, describeMindMapWorkspace, describeTaskContentState, pickDetailTaskId, resolveKnowledgeNoteMarkdown } from "../src/detailModel.ts";
import type { TaskDetail, TaskMindMapResponse, TaskResult, TaskSummary } from "../src/types.ts";

function run(name: string, fn: () => void) {
  fn();
  console.log(`ok - ${name}`);
}

function createTaskSummary(overrides: Partial<TaskSummary>): TaskSummary {
  return {
    task_id: "task-default",
    video_id: "video-1",
    status: "queued",
    input_type: "url",
    source: "https://example.com/video",
    title: "测试视频",
    created_at: "2026-04-10T08:00:00.000Z",
    updated_at: "2026-04-10T08:05:00.000Z",
    llm_total_tokens: null,
    task_duration_seconds: null,
    ...overrides,
  };
}

function createTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    overview: "这是一段概览。",
    knowledge_note_markdown: "",
    transcript_text: "逐字稿内容",
    segment_summaries: ["片段摘要一", "片段摘要二"],
    key_points: ["要点一", "要点二"],
    timeline: [
      { title: "章节一", start: 12, summary: "章节一摘要" },
      { title: "章节二", start: 88, summary: "章节二摘要" },
    ],
    chapter_groups: [],
    artifacts: {},
    llm_prompt_tokens: 100,
    llm_completion_tokens: 80,
    llm_total_tokens: 180,
    ...overrides,
  };
}

function createTaskDetail(overrides: Partial<TaskDetail>): TaskDetail {
  return {
    ...createTaskSummary({ task_id: "task-detail", status: "completed" }),
    result: createTaskResult(),
    error_code: null,
    error_message: null,
    ...overrides,
  };
}

run("prefers the latest completed task over a newer running task", () => {
  const tasks = [
    createTaskSummary({ task_id: "task-running", status: "running", created_at: "2026-04-10T10:00:00.000Z" }),
    createTaskSummary({ task_id: "task-completed", status: "completed", created_at: "2026-04-10T09:00:00.000Z" }),
  ];

  assert.equal(pickDetailTaskId(tasks), "task-completed");
});

run("falls back to the latest task when no completed task exists", () => {
  const tasks = [
    createTaskSummary({ task_id: "task-running", status: "running" }),
    createTaskSummary({ task_id: "task-failed", status: "failed" }),
  ];

  assert.equal(pickDetailTaskId(tasks), "task-running");
});

run("keeps the preferred task when it still exists", () => {
  const tasks = [
    createTaskSummary({ task_id: "task-running", status: "running" }),
    createTaskSummary({ task_id: "task-completed", status: "completed" }),
  ];

  assert.equal(pickDetailTaskId(tasks, "task-running"), "task-running");
});

run("builds overview, key point, and chapter cards from a completed result", () => {
  const cards = buildKnowledgeCards(createTaskResult());

  assert.equal(cards.filter((item) => item.kind === "overview").length, 1);
  assert.equal(cards.filter((item) => item.kind === "key-point").length, 2);
  assert.equal(cards.filter((item) => item.kind === "chapter").length, 2);
  assert.equal(cards.find((item) => item.kind === "chapter")?.timestampSeconds, 12);
});

run("uses segment summaries as chapter cards when timeline is missing", () => {
  const cards = buildKnowledgeCards(createTaskResult({ timeline: [] }));

  assert.equal(cards.filter((item) => item.kind === "chapter").length, 2);
  assert.equal(cards.find((item) => item.kind === "chapter")?.timestampSeconds, undefined);
});

run("tolerates legacy results with missing array fields", () => {
  const cards = buildKnowledgeCards({
    overview: "旧数据概览",
    knowledge_note_markdown: "",
    transcript_text: "旧数据逐字稿",
    key_points: undefined as unknown as string[],
    timeline: undefined as unknown as TaskResult["timeline"],
    segment_summaries: undefined as unknown as string[],
    artifacts: {},
  });

  assert.equal(cards.filter((item) => item.kind === "overview").length, 1);
  assert.equal(cards.filter((item) => item.kind === "key-point").length, 0);
  assert.equal(cards.filter((item) => item.kind === "chapter").length, 0);
});

run("prefers explicit knowledge note markdown when available", () => {
  const markdown = resolveKnowledgeNoteMarkdown(createTaskResult({ knowledge_note_markdown: "# 知识笔记\n\n公式 $f(x)$" }));

  assert.equal(markdown, "# 知识笔记\n\n公式 $f(x)$");
});

run("builds legacy knowledge note markdown from existing result fields", () => {
  const markdown = resolveKnowledgeNoteMarkdown(createTaskResult({ knowledge_note_markdown: "" }));

  assert.match(markdown, /## 摘要概览/);
  assert.match(markdown, /## 关键要点/);
  assert.match(markdown, /### 章节一/);
});

run("groups chapter cards into collapsible major chapters", () => {
  const cards = buildKnowledgeCards(
    createTaskResult({
      timeline: [
        { title: "章节一", start: 10, summary: "摘要一" },
        { title: "章节二", start: 90, summary: "摘要二" },
        { title: "章节三", start: 180, summary: "摘要三" },
        { title: "章节四", start: 260, summary: "摘要四" },
        { title: "章节五", start: 340, summary: "摘要五" },
      ],
    }),
  );

  const groups = buildChapterGroups(cards);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].items.length, 3);
  assert.equal(groups[1].items.length, 2);
  assert.match(groups[0].meta, /个小章节/);
});

run("prefers backend chapter groups when available", () => {
  const result = createTaskResult({
    chapter_groups: [
      {
        title: "函数基础",
        start: 0,
        summary: "定义到符号约定",
        children: [
          { title: "定义", start: 0, summary: "定义摘要" },
          { title: "符号", start: 30, summary: "符号摘要" },
        ],
      },
    ],
  });

  const cards = buildKnowledgeCards(result);
  const groups = buildChapterGroups(cards, result);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "函数基础");
  assert.equal(groups[0].items.length, 2);
  assert.match(groups[0].meta, /定义到符号约定/);
});

run("replaces placeholder chapter-group titles with content titles", () => {
  const result = createTaskResult({
    chapter_groups: [
      {
        title: "大章节 1",
        start: 0,
        summary: "函数定义与符号规范；典型函数示例分析",
        children: [
          { title: "章节 1", start: 0, summary: "函数定义与符号规范，解释映射关系。" },
          { title: "章节 2", start: 30, summary: "典型函数示例分析，对比绝对值函数。" },
        ],
      },
    ],
  });

  const cards = buildKnowledgeCards(result);
  const groups = buildChapterGroups(cards, result);

  assert.match(groups[0].title, /函数定义与符号规范/);
  assert.match(groups[0].items[0].title, /函数定义与符号规范/);
});

run("describes a pending workspace state when the selected task is still running", () => {
  const state = describeTaskContentState(createTaskDetail({ status: "running", result: null }));

  assert.equal(state?.tone, "pending");
  assert.match(state?.description || "", /顶部任务药丸/);
});

run("describes a failed workspace state when the selected task failed", () => {
  const state = describeTaskContentState(createTaskDetail({ status: "failed", result: null, error_message: "LLM 请求失败" }));

  assert.equal(state?.tone, "failed");
  assert.equal(state?.detail, "LLM 请求失败");
});

run("returns an accent state for a completed task that can generate mind map", () => {
  const state = describeMindMapWorkspace(createTaskDetail({ status: "completed" }));

  assert.equal(state.tone, "accent");
  assert.equal(state.actionEnabled, true);
});

run("returns null when a ready mind map exists", () => {
  const mindmap: TaskMindMapResponse = {
    task_id: "task-detail",
    status: "ready",
    error_message: null,
    updated_at: null,
    mindmap: {
      version: 1,
      title: "导图",
      root: "root",
      nodes: [{ id: "root", label: "导图", type: "root", summary: "", children: [], source_chapter_titles: [], source_chapter_starts: [] }],
    },
  };

  const state = describeMindMapWorkspace(createTaskDetail({ status: "completed" }), mindmap);

  assert.equal(state, null);
});
