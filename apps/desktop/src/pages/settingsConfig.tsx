import type { ReactNode } from "react";

import {
  CpuIcon,
  FileTextIcon,
  FolderIcon,
  MonitorIcon,
  OverviewIcon,
  RobotIcon,
  SettingsIcon,
  SlidersIcon,
  StorageIcon,
  TerminalIcon,
} from "../components/AppIcons";

export type SettingsCategory = "overview" | "general" | "directories" | "fileManagement" | "model" | "llm" | "knowledge" | "summary" | "performance" | "advanced" | "environment" | "updates" | "logs";
export type SettingsCategoryGroup = "workspace" | "system";

export const settingsCategories: Array<{
  id: SettingsCategory;
  label: string;
  description: string;
  group: SettingsCategoryGroup;
  icon: ReactNode;
}> = [
  { id: "overview", label: "概览", description: "查看服务状态、运行时与关键配置。", group: "workspace", icon: <OverviewIcon /> },
  { id: "general", label: "服务入口", description: "服务监听地址、端口和基础连接参数。", group: "workspace", icon: <SettingsIcon /> },
  { id: "directories", label: "目录设置", description: "数据、缓存和任务文件存储位置。", group: "workspace", icon: <FolderIcon /> },
  { id: "fileManagement", label: "空间清理", description: "查看空间占用并清理缓存与孤儿文件。", group: "workspace", icon: <StorageIcon /> },
  { id: "model", label: "转写模型", description: "云端 ASR、本地 ASR、Whisper 模型和设备偏好。", group: "workspace", icon: <CpuIcon /> },
  { id: "llm", label: "摘要 LLM", description: "主摘要大模型能力与 API 接入参数。", group: "workspace", icon: <RobotIcon /> },
  { id: "summary", label: "摘要与导图", description: "摘要模式、语言、切块策略和导图生成。", group: "workspace", icon: <FileTextIcon /> },
  { id: "knowledge", label: "知识库", description: "知识库开关、索引策略、问答模型和依赖安装。", group: "workspace", icon: <StorageIcon /> },
  { id: "environment", label: "运行时", description: "检查并维护 Python、Torch、CUDA、ASR 与扩展依赖。", group: "system", icon: <MonitorIcon /> },
  { id: "performance", label: "性能", description: "任务级并发和摘要吞吐控制。", group: "system", icon: <SlidersIcon /> },
  { id: "advanced", label: "高级", description: "CUDA 变体、运行时通道和缓存行为。", group: "system", icon: <SlidersIcon /> },
  { id: "updates", label: "应用更新", description: "检查桌面应用新版本并管理安装。", group: "system", icon: <SettingsIcon /> },
  { id: "logs", label: "日志与控制", description: "查看服务日志并控制后端进程。", group: "system", icon: <TerminalIcon /> },
];
