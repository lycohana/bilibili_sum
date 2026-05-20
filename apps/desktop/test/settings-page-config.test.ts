import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function run(name: string, fn: () => void) {
  fn();
  console.log(`ok - ${name}`);
}

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const settingsPageSource = readFileSync(join(projectRoot, "src/pages/SettingsPage.tsx"), "utf8");
const settingsConfigSource = readFileSync(join(projectRoot, "src/pages/settingsConfig.tsx"), "utf8");

function uniqueMatches(source: string, pattern: RegExp): string[] {
  return Array.from(new Set(Array.from(source.matchAll(pattern), (match) => match[1]).filter(Boolean)));
}

const categoryIds = uniqueMatches(settingsConfigSource, /\{\s*id:\s*"([^"]+)"/g);
const categorySet = new Set(categoryIds);

run("settings page uses only configured category ids", () => {
  assert.ok(categoryIds.length > 0, "expected settings categories to be discoverable");

  const referencedCategories = [
    ...uniqueMatches(settingsPageSource, /category:\s*"([^"]+)"/g),
    ...uniqueMatches(settingsPageSource, /activeCategory === "([^"]+)"/g),
    ...uniqueMatches(settingsPageSource, /setActiveCategory\("([^"]+)"\)/g),
  ];

  for (const category of referencedCategories) {
    assert.ok(categorySet.has(category), `unknown settings category: ${category}`);
  }
});

run("settings search items target rendered focus anchors", () => {
  const searchTargets = uniqueMatches(settingsPageSource, /targetKey:\s*"([^"]+)"/g);
  const focusTargets = new Set(uniqueMatches(settingsPageSource, /registerFocusTarget\("([^"]+)"\)/g));

  assert.ok(searchTargets.length > 0, "expected settings search targets to be discoverable");

  for (const target of searchTargets) {
    assert.ok(focusTargets.has(target), `missing focus target for search/config key: ${target}`);
  }
});

run("legacy settings category ids were fully migrated", () => {
  const legacyIds = ["general", "directories", "fileManagement", "model", "llm", "summary", "advanced", "environment"];

  for (const legacyId of legacyIds) {
    assert.equal(categorySet.has(legacyId), false, `legacy category still configured: ${legacyId}`);
    assert.equal(settingsPageSource.includes(`category: "${legacyId}"`), false, `legacy category still referenced: ${legacyId}`);
    assert.equal(settingsPageSource.includes(`activeCategory === "${legacyId}"`), false, `legacy active category still rendered: ${legacyId}`);
    assert.equal(settingsPageSource.includes(`setActiveCategory("${legacyId}")`), false, `legacy category still navigated: ${legacyId}`);
  }
});

run("video settings can trigger bilibili cookie capture", () => {
  assert.ok(settingsPageSource.includes("captureBilibiliLoginCookies"), "missing settings cookie capture handler");
  assert.ok(settingsPageSource.includes("window.desktop?.bilibili"), "settings cookie capture should reuse desktop bilibili bridge");
  assert.ok(settingsPageSource.includes("createBilibiliCookieQrcode"), "settings cookie capture should support web qrcode fallback");
  assert.ok(settingsPageSource.includes("pollBilibiliCookieQrcode"), "settings cookie capture should poll web qrcode login");
  assert.ok(settingsPageSource.includes("登录获取"), "missing visible cookie capture button");
});

run("prompt presets can hide builtin presets from homepage routing", () => {
  assert.ok(settingsPageSource.includes("hiddenPromptPresetIds"), "settings should track hidden builtin prompt presets");
  assert.ok(settingsPageSource.includes("settings-preset-hide-button"), "builtin preset cards should expose a hide action");
  assert.ok(settingsPageSource.includes("hiddenBuiltinPresets.map"), "hidden builtin presets should be recoverable");
  assert.ok(settingsPageSource.includes("bilisum:prompt-presets-visibility-changed"), "homepage should be notified when prompt visibility changes");
});

run("prompt templates are validated before settings save", () => {
  assert.ok(settingsPageSource.includes("validatePromptTemplates"), "missing prompt template validation");
  assert.ok(settingsPageSource.includes("{transcript}"), "summary template validation should require transcript variable");
  assert.ok(settingsPageSource.includes("knowledgeNoteMarkdown"), "knowledge note validation should preserve parseable output field");
  assert.ok(settingsPageSource.includes("{visual_observations_json}"), "visual note validation should require visual observations variable");
});
run("prompt floating toolbar can be dragged, closed, and restored", () => {
  assert.ok(settingsPageSource.includes("promptToolbarClosed"), "toolbar should track closed state");
  assert.ok(settingsPageSource.includes("setPromptToolbarClosed(false)"), "toolbar should restore when returning to prompt settings");
  assert.ok(settingsPageSource.includes("startPromptToolbarDrag"), "toolbar should support vertical dragging");
  assert.ok(settingsPageSource.includes("settings-prompt-toolbar-close"), "toolbar should expose a close button");
  assert.ok(settingsPageSource.includes("settings-prompt-toolbar-drag"), "toolbar should expose a drag handle");
});
run("prompt page floating fab returns to top", () => {
  assert.ok(settingsPageSource.includes("settingsContentScrollRef"), "settings content scroll container should be addressable");
  assert.ok(settingsPageSource.includes("scrollSettingsToTop"), "floating fab should call the return-to-top handler");
  assert.ok(settingsPageSource.includes("aria-label=\"回到顶部\""), "floating fab should be labelled as return to top");
  assert.equal(settingsPageSource.includes("title=\"折叠所有外层分类\""), false, "floating fab should no longer be labelled as collapse all");
});
run("settings return-to-top fab is available across categories", () => {
  const fabIndex = settingsPageSource.indexOf("settings-collapse-all-fab");
  const performanceIndex = settingsPageSource.indexOf('activeCategory === "performance"');
  const contentCloseIndex = settingsPageSource.indexOf('</main>', performanceIndex);
  assert.ok(fabIndex > performanceIndex, "return-to-top fab should be rendered after category sections, not inside prompts only");
  assert.ok(fabIndex < contentCloseIndex, "return-to-top fab should stay inside the settings content area");
});

run("home prompt router calls match API and filters hidden presets", () => {
  const homePageSource = readFileSync(join(projectRoot, "src/pages/HomePage.tsx"), "utf8");
  assert.ok(homePageSource.includes("api.matchPrompt(title)"), "home page should ask backend to match a prompt for the current input");
  assert.ok(homePageSource.includes("promptRouterMode === \"auto\""), "auto prompt routing should apply the matched preset");
  assert.ok(homePageSource.includes("AI 识别场景"), "home page should expose AI scene recognition mode");
  assert.ok(homePageSource.includes("onPromptRouterModeChange(mode)"), "home page prompt mode selector should persist router mode");
  assert.ok(homePageSource.includes("hiddenPromptPresetIds.has(result.preset.id)"), "hidden matched presets should not be recommended or auto-selected");
  assert.ok(homePageSource.includes("selectablePromptPresets.map"), "home prompt dropdown should only render visible presets");
});

run("home prompt presets can jump to settings editor", () => {
  const homePageSource = readFileSync(join(projectRoot, "src/pages/HomePage.tsx"), "utf8");
  const appSource = readFileSync(join(projectRoot, "src/App.tsx"), "utf8");
  assert.ok(homePageSource.includes("onContextMenu={openPromptContextMenu}"), "home prompt selector should expose a context menu");
  assert.ok(homePageSource.includes("onEditPromptPreset(promptContextMenu.presetId)"), "context menu should request prompt preset editing");
  assert.ok(appSource.includes("navigateToPromptPreset"), "app should route prompt edit requests to settings");
  assert.ok(settingsPageSource.includes("promptPresetRequest"), "settings page should accept prompt preset navigation requests");
  assert.ok(settingsPageSource.includes("prompt_presets_library"), "settings page should focus the prompt preset library");
});
