#!/usr/bin/env node

/**
 * Claude API Logger - Captures Claude API requests and responses
 * Usage: claude-log [--log_dir=DIR] [claude options]
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const os = require("os");
const { execSync } = require("child_process");

// Get version from package.json
const packageJson = require("./package.json");
const version = packageJson.version;

// Parse command line arguments
const args = process.argv.slice(2);
let logDir = null;
let projectLogEnabled = true;
let printDebug = false;
let claudeArgs = [];

// Process arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("--log_dir=")) {
    logDir = arg.split("=")[1];
  } else if (arg === "--log_dir" && i < args.length - 1) {
    logDir = args[i + 1];
    i++;
  } else if (arg === "--print") {
    printDebug = true;
  } else if (arg === "--no-project-log") {
    console.log("Error: --no-project-log is no longer supported as project logs are the only option.");
    process.exit(1);
  } else {
    claudeArgs.push(arg);
  }
}

// Get current working directory (project directory)
const cwd = process.cwd();
const projectName = path.basename(cwd);

// Generate unique identifiers for this run
const timestamp = new Date().toISOString().replace(/:/g, "-");
const runId = `${timestamp}_${crypto.randomBytes(4).toString("hex")}`;

// Determine log directory - use specified log_dir if provided, otherwise use project directory
const projectLogsDir = logDir ? logDir : path.join(cwd, "logs");
if (!fs.existsSync(projectLogsDir)) {
  fs.mkdirSync(projectLogsDir, { recursive: true });
}

// Create log file
const logFile = path.join(projectLogsDir, `${projectName}_${timestamp}.json`);

// Create an empty log file to make sure we can write to it
try {
  fs.writeFileSync(logFile, "[]");
  if (printDebug) {
    console.log(`Logs will be saved to: ${logFile}`);
  }
} catch (err) {
  console.error(`Error: Cannot write to log file: ${err.message}`);
  process.exit(1);
}

// Check if this is the first run in the project
checkForFirstRunAndSuggestAlias();

console.log(
  `Claude Logger v${version} - Starting Claude` +
    (claudeArgs.includes("-p") ? " with prompt" : " in interactive mode")
);
console.log(`Logs will be saved to: ${path.dirname(logFile)}`);

// Run Claude with our direct_capture.js module loaded to intercept requests
console.log("Initializing request capture...");

// Set up environment for direct_capture.js
const captureEnv = {
  ...process.env,
  CLAUDE_API_LOG_FILE: logFile,
  CLAUDE_PROJECT_NAME: projectName,
  CLAUDE_DEBUG: printDebug ? "true" : "false",
  CLAUDE_LOGGER_VERSION: version,
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

/**
 * Checks if this is the first run in a project directory and suggests setting
 * up the claude alias if it's not already set up
 */
function checkForFirstRunAndSuggestAlias() {
  // Only suggest if this appears to be the first run in this project
  const isFirstProjectRun = !fs.existsSync(path.join(cwd, "logs")) || 
                            fs.readdirSync(path.join(cwd, "logs")).length === 0;
  
  if (!isFirstProjectRun) {
    return;
  }
  
  // Check for the alias in common shell config files
  const homeDir = os.homedir();
  const configFiles = [
    { path: path.join(homeDir, ".bashrc"), type: "bash" },
    { path: path.join(homeDir, ".bash_profile"), type: "bash" },
    { path: path.join(homeDir, ".zshrc"), type: "zsh" },
    { path: path.join(homeDir, ".config", "fish", "config.fish"), type: "fish" }
  ];
  
  let aliasFound = false;
  
  for (const config of configFiles) {
    if (fs.existsSync(config.path)) {
      try {
        const content = fs.readFileSync(config.path, "utf8");
        if (content.includes("alias claude='claude-log'")) {
          aliasFound = true;
          break;
        }
      } catch (err) {
        // Skip if we can't read the file
      }
    }
  }
  
  if (!aliasFound) {
    console.log("\n========================================================");
    console.log("💡 First time using claude-logger in this project!");
    console.log("   For convenience, you can set up an alias in your shell:");
    console.log("");
    console.log("   For Bash/Zsh (add to .bashrc or .zshrc):");
    console.log("   alias claude='claude-log'");
    console.log("");
    console.log("   For Fish shell:");
    console.log("   alias claude='claude-log'");
    console.log("   funcsave claude");
    console.log("========================================================\n");
  }
}
