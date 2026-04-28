#!/usr/bin/env node

const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const RELEASES_URL = "https://github.com/lycohana/BiliSum/releases/latest";
const REPO_URL = "https://github.com/lycohana/BiliSum";
const DEFAULT_IMAGE = "lycohana/bilisum:latest";
const DEFAULT_PORT = "3838";

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
  console.log("  npx bilisum                         Start BiliSum with Docker");
  console.log("  npx bilisum start [options]          Start BiliSum with Docker");
  console.log("  npx bilisum --version                Print package version");
  console.log("  npx bilisum release                  Open the latest GitHub release");
  console.log("  npx bilisum docker                   Print the Docker command");
  console.log("");
  console.log("Options:");
  console.log("  --port <port>                        Host port, default 3838");
  console.log("  --image <image>                      Docker image, default lycohana/bilisum:latest");
  console.log("  --name <name>                        Container name, default bilisum");
  console.log("  --data <volume-or-path>              Data volume/path, default bilisum-data");
  console.log("  --env KEY=VALUE                      Pass an environment variable");
  console.log("  --pull                               Pull the image before starting");
  console.log("  --detach, -d                         Run container in background");
  console.log("  --no-open                            Do not open the browser");
  console.log("");
  console.log(`Latest release: ${RELEASES_URL}`);
  console.log(`Repository:     ${REPO_URL}`);
}

function parseStartOptions(args) {
  const options = {
    port: process.env.BILISUM_PORT || DEFAULT_PORT,
    image: process.env.BILISUM_DOCKER_IMAGE || DEFAULT_IMAGE,
    name: process.env.BILISUM_CONTAINER_NAME || "bilisum",
    data: process.env.BILISUM_DATA || "bilisum-data",
    env: [],
    pull: false,
    detach: false,
    open: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port" || arg === "-p") {
      options.port = readOptionValue(args, ++index, arg);
    } else if (arg === "--image") {
      options.image = readOptionValue(args, ++index, arg);
    } else if (arg === "--name") {
      options.name = readOptionValue(args, ++index, arg);
    } else if (arg === "--data") {
      options.data = readOptionValue(args, ++index, arg);
    } else if (arg === "--env" || arg === "-e") {
      options.env.push(readOptionValue(args, ++index, arg));
    } else if (arg === "--pull") {
      options.pull = true;
    } else if (arg === "--detach" || arg === "-d") {
      options.detach = true;
    } else if (arg === "--no-open") {
      options.open = false;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readOptionValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function dockerCommand(options) {
  const args = ["run", "--rm"];
  if (options.detach) {
    args.push("-d");
  } else {
    args.push("-it");
  }

  args.push("--name", options.name);
  args.push("-p", `${options.port}:3838`);
  args.push("-v", `${options.data}:/data`);

  const envKeys = [
    "VIDEO_SUM_LLM_ENABLED",
    "VIDEO_SUM_LLM_BASE_URL",
    "VIDEO_SUM_LLM_MODEL",
    "VIDEO_SUM_LLM_API_KEY",
    "VIDEO_SUM_TRANSCRIPTION_PROVIDER",
    "VIDEO_SUM_SILICONFLOW_ASR_BASE_URL",
    "VIDEO_SUM_SILICONFLOW_ASR_MODEL",
    "VIDEO_SUM_SILICONFLOW_ASR_API_KEY",
    "VIDEO_SUM_YTDLP_COOKIES_FILE",
  ];
  for (const key of envKeys) {
    if (process.env[key]) {
      args.push("-e", `${key}=${process.env[key]}`);
    }
  }
  for (const value of options.env) {
    args.push("-e", value);
  }

  args.push(options.image);
  return args;
}

function printDockerCommand(options = parseStartOptions([])) {
  console.log(["docker", ...dockerCommand(options)].join(" "));
}

function ensureDocker() {
  const result = spawnSync("docker", ["--version"], { stdio: "ignore", windowsHide: true });
  if (result.status !== 0) {
    throw new Error("Docker was not detected. Install Docker Desktop, then run npx bilisum again.");
  }
}

function startService(args) {
  const options = parseStartOptions(args);
  ensureDocker();

  if (options.pull) {
    execFileSync("docker", ["pull", options.image], { stdio: "inherit" });
  }

  const url = `http://127.0.0.1:${options.port}`;
  console.log(`Starting BiliSum at ${url}`);
  console.log("");
  printDockerCommand(options);
  console.log("");

  const child = spawn("docker", dockerCommand(options), {
    stdio: "inherit",
    windowsHide: false,
  });

  if (options.open) {
    setTimeout(() => openUrl(url), 1800);
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code || 0;
  });
}

function openUrl(url) {
  const platform = process.platform;
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    console.log(url);
  });
  child.unref();
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  try {
    if (!command) {
      startService([]);
      return;
    }

    if (command === "start" || command === "serve") {
      startService(args);
      return;
    }

    if (command === "help" || command === "-h" || command === "--help") {
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
      printDockerCommand(parseStartOptions(args));
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    printHelp();
    process.exitCode = 1;
  }
}

main();
