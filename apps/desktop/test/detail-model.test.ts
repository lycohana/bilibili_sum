import assert from "node:assert/strict";

import { buildKnowledgeCards, describeMindMapPlaceholder, describeTaskContentState, pickDetailTaskId } from "../src/detailModel.ts";
import type { TaskDetail, TaskResult, TaskSummary } from "../src/types.ts";

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
    transcript_text: "逐字稿内容",
    segment_summaries: ["片段摘要一", "片段摘要二"],
    key_points: ["要点一", "要点二"],
    timeline: [
      { title: "章节一", start: 12, summary: "章节一摘要" },
      { title: "章节二", start: 88, summary: "章节二摘要" },
    ],
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

run("returns an accent placeholder for a completed task mind map entry", () => {
  const state = describeMindMapPlaceholder(createTaskDetail({ status: "completed" }));

  assert.equal(state.tone, "accent");
  assert.equal(state.actionEnabled, false);
});
