#!/usr/bin/env node

/**
 * Claude API Logger - Captures Claude API requests and responses
 * Usage: claude-log [--log_dir=DIR] [--save-responses] [claude options]
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const os = require("os");

// Parse command line arguments
const args = process.argv.slice(2);
let logDir = path.join(os.homedir(), ".claude_logs");
let skipResponses = true;
let printDebug = false;
let claudeArgs = [];

// Process arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("--log_dir=")) {
    logDir = arg.substring("--log_dir=".length);
  } else if (arg === "--log_dir" && i < args.length - 1) {
    logDir = args[i + 1];
    i++;
  } else if (arg === "--save-responses") {
    skipResponses = false;
  } else if (arg === "--print") {
    printDebug = true;
  } else {
    claudeArgs.push(arg);
  }
}

// Create log directory if it doesn't exist
const absoluteLogDir = path.resolve(logDir);
if (!fs.existsSync(absoluteLogDir)) {
  fs.mkdirSync(absoluteLogDir, { recursive: true });
}

// Generate unique identifiers for this run
const timestamp = new Date().toISOString().replace(/:/g, "-");
const runId = `${timestamp}_${crypto.randomBytes(4).toString("hex")}`;
const logFile = path.join(absoluteLogDir, `${runId}.json`);

console.log(
  "Starting Claude" +
    (claudeArgs.includes("-p") ? " with prompt" : " in interactive mode")
);
console.log(`Logs will be saved to: ${absoluteLogDir}`);

// Run Claude with our direct_capture.js module loaded to intercept requests
console.log("Initializing request capture...");

// Set up environment for direct_capture.js
const captureEnv = {
  ...process.env,
  CLAUDE_API_LOG_FILE: logFile,
  CLAUDE_LOG_RESPONSES: skipResponses ? "false" : "true",
  CLAUDE_DEBUG: printDebug ? "true" : "false",
  NODE_OPTIONS: `--require "${path.join(__dirname, "direct_capture.js")}"`,
};

// Fix for cursor position - pass stdin directly to the claude process
// and use stdio: 'inherit' for stdout so that terminal control sequences work properly
const claudeProcess = spawn("claude", claudeArgs, {
  env: captureEnv,
  stdio: ["inherit", "inherit", "pipe"], // Pass stdin and stdout directly, only capture stderr
});

// Capture and filter stderr (to hide debug messages when not in debug mode)
let stderrBuffer = "";
claudeProcess.stderr.on("data", (data) => {
  const text = data.toString();
  stderrBuffer += text;

  // Only print stderr if it's not debug output or if debug mode is enabled
  if (
    printDebug ||
    (!text.includes("DEBUG:") &&
      !text.includes("intercepted") &&
      !text.includes("Intercepted") &&
      !text.includes("Environment Variables"))
  ) {
    process.stderr.write(data);
  }
});

// Handle process exit
claudeProcess.on("close", (code) => {
  console.log(`Logs written to ${logFile}`);
  process.exit(code);
});

claudeProcess.on("error", (err) => {
  console.log(`Logs written to ${logFile}`);
  console.error(`Error running Claude: ${err.message}`);
  process.exit(1);
});
