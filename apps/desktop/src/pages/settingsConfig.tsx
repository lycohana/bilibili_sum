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

export type SettingsCategory = "overview" | "video" | "transcription" | "generation" | "knowledge" | "files" | "performance" | "prompts" | "maintenance" | "runtime" | "updates" | "logs";
export type SettingsCategoryGroup = "workflow" | "system";

export const settingsCategories: Array<{
  id: SettingsCategory;
  label: string;
  description: string;
  group: SettingsCategoryGroup;
  icon: ReactNode;
}> = [
  { id: "overview", label: "快速开始", description: "确认能否开始总结，并跳到缺失配置。", group: "workflow", icon: <OverviewIcon /> },
  { id: "video", label: "视频获取", description: "B 站登录态、下载缓存和临时文件策略。", group: "workflow", icon: <FileTextIcon /> },
  { id: "transcription", label: "语音转文字", description: "选择云端或本地 ASR，配置模型和设备。", group: "workflow", icon: <CpuIcon /> },
  { id: "generation", label: "摘要生成", description: "AI 摘要、模型接入、语言和导图开关。", group: "workflow", icon: <RobotIcon /> },
  { id: "knowledge", label: "知识库与问答", description: "知识库开关、索引策略、问答模型和依赖。", group: "workflow", icon: <StorageIcon /> },
  { id: "files", label: "输出与文件", description: "输出目录、数据目录和空间清理。", group: "workflow", icon: <FolderIcon /> },
  { id: "performance", label: "性能与资源", description: "并发、CUDA 版本和运行环境通道。", group: "system", icon: <SlidersIcon /> },
  { id: "prompts", label: "提示词", description: "知识笔记、摘要和导图的高级文本模板。", group: "system", icon: <FileTextIcon /> },
  { id: "maintenance", label: "维护与诊断", description: "服务地址、端口和配置维护入口。", group: "system", icon: <SettingsIcon /> },
  { id: "runtime", label: "运行环境", description: "检查并维护 Python、Torch、CUDA、ASR 与扩展依赖。", group: "system", icon: <MonitorIcon /> },
  { id: "updates", label: "应用更新", description: "检查桌面应用新版本并管理安装。", group: "system", icon: <SettingsIcon /> },
  { id: "logs", label: "日志与控制", description: "查看服务日志并控制后端进程。", group: "system", icon: <TerminalIcon /> },
];
