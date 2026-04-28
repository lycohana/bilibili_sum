#!/usr/bin/env node

const { execFileSync, spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const RELEASES_URL = "https://github.com/lycohana/BiliSum/releases/latest";
const REPO_URL = "https://github.com/lycohana/BiliSum";
const DOCKER_IMAGE = "lycohana/bilisum:latest";

function readVersion() {
  const packagePath = join(__dirname, "..", "package.json");
  if (!existsSync(packagePath)) {
    return "unknown";
  }
  return JSON.parse(readFileSync(packagePath, "utf8")).version || "unknown";
}

function printHelp() {
  const version = readVersion();
  console.log(`BiliSum ${version}`);
  console.log("");
  console.log("AI 视频总结与知识库工具，深度优化 B 站体验，同时支持 YouTube 和本地视频。");
  console.log("");
  console.log("Usage:");
  console.log("  npx bilisum                 Show this help");
  console.log("  npx bilisum --version       Print package version");
  console.log("  npx bilisum release         Open the latest GitHub release");
  console.log("  npx bilisum docker          Print a Docker quick-start command");
  console.log("");
  console.log(`Latest release: ${RELEASES_URL}`);
  console.log(`Repository:     ${REPO_URL}`);
}

function printDockerCommand() {
  console.log("Docker quick start:");
  console.log("");
  console.log(`docker run --rm -it -p 3838:3838 -v bilisum-data:/data ${DOCKER_IMAGE}`);
  console.log("");
  console.log("Then open http://127.0.0.1:3838");
}

function openUrl(url) {
  const platform = process.platform;
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {
      console.log(url);
    });
    child.unref();
    console.log(`Opened ${url}`);
  } catch {
    console.log(url);
  }
}

function isDockerAvailable() {
  try {
    execFileSync("docker", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const [command] = process.argv.slice(2);

  if (!command || command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "version" || command === "-v" || command === "--version") {
    console.log(readVersion());
    return;
  }

  if (command === "release" || command === "releases" || command === "download") {
    openUrl(RELEASES_URL);
    return;
  }

  if (command === "repo" || command === "github") {
    openUrl(REPO_URL);
    return;
  }

  if (command === "docker") {
    printDockerCommand();
    if (!isDockerAvailable()) {
      console.log("");
      console.log("Docker was not detected on this machine.");
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("");
  printHelp();
  process.exitCode = 1;
}

main();
