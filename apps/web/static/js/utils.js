export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function routeMeta(route) {
  if (route === "tasks") {
    return { eyebrow: "任务页", title: "任务与结果" };
  }
  if (route === "settings") {
    return { eyebrow: "设置页", title: "服务配置与后端信息" };
  }
  return { eyebrow: "主页", title: "本地工作台" };
}
