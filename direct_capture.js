#!/usr/bin/env node

/**
 * Claude API Direct Capture Module
 *
 * This module intercepts HTTP/HTTPS requests made by the Claude CLI to capture
 * API calls to Anthropic. It can be used both as a library and standalone.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

// Configuration from environment variables
const os = require("os");
const logDir = process.env.CLAUDE_API_LOG_DIR || path.join(os.homedir(), ".claude_logs");
const timestamp = process.env.CLAUDE_API_LOG_NAME || new Date().toISOString().replace(/:/g, "-");
const logFile = path.join(logDir, `requests_${timestamp}.json`);
const responseLogFile = path.join(logDir, `responses_${timestamp}.json`);
const debugMode = process.env.CLAUDE_DEBUG === "true";
const logResponses = process.env.CLAUDE_LOG_RESPONSES !== "false";

// In-memory storage for logs
const requestLogs = [];
const responseLogs = [];

// Sensitive data patterns to redact
const sensitivePatterns = [
  { regex: /"x-api-key":\s*"([^"]+)"/g, replacement: '"x-api-key": "[REDACTED]"' },
  { regex: /"Authorization":\s*"([^"]+)"/gi, replacement: '"Authorization": "[REDACTED]"' },
  { regex: /"user_id":\s*"([^"]+)"/g, replacement: '"user_id": "[REDACTED]"' },
  { regex: /"session_id":\s*"([^"]+)"/g, replacement: '"session_id": "[REDACTED]"' },
];

// Debug logging function that only logs when debug mode is enabled
function debugLog(message) {
  if (debugMode) {
    console.error(`DEBUG: ${message}`);
  }
}

// Store original request methods before they're patched
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;

// Patch the http.request method
http.request = function () {
  debugLog("http.request intercepted");

  // Get URL from options
  const options = arguments[0];
  let url = "";
  if (typeof options === "string") {
    url = options;
  } else if (options.href) {
    url = options.href;
  } else {
    url = `http://${options.hostname || options.host}${options.path || "/"}`;
  }

  // Call original and capture request object
  const req = originalHttpRequest.apply(this, arguments);

  // Log request details
  logRequest("http", options, req, url);

  return req;
};

// Patch the https.request method
https.request = function () {
  debugLog("https.request intercepted");

  // Get URL from options
  const options = arguments[0];
  let url = "";
  if (typeof options === "string") {
    url = options;
  } else if (options.href) {
    url = options.href;
  } else {
    url = `https://${options.hostname || options.host}${options.path || "/"}`;
  }

  // Call original and capture request object
  const req = originalHttpsRequest.apply(this, arguments);

  // Log request details
  logRequest("https", options, req, url);

  return req;
};

// Redact sensitive information from a string
function redactSensitiveInfo(str) {
  if (typeof str !== "string") return str;

  let redacted = str;
  for (const pattern of sensitivePatterns) {
    redacted = redacted.replace(pattern.regex, pattern.replacement);
  }
  return redacted;
}

// Log a request and its response
function logRequest(protocol, options, req, url) {
  // Skip non-Claude API requests
  if (!url.includes("anthropic.com")) {
    return;
  }

  debugLog(`Found Claude API request to: ${url}`);

  // Create log data object
  const logData = {
    timestamp: new Date().toISOString(),
    protocol: protocol,
    url: url,
  };

  // Add method and headers if available (with sensitive data redacted)
  if (typeof options === "object") {
    logData.method = options.method || "GET";

    // Deep copy and redact headers
    if (options.headers) {
      logData.headers = JSON.parse(JSON.stringify(options.headers));

      // Explicitly redact sensitive headers
      if (logData.headers["x-api-key"]) {
        logData.headers["x-api-key"] = "[REDACTED]";
      }
      if (logData.headers["authorization"]) {
        logData.headers["authorization"] = "[REDACTED]";
      }
    } else {
      logData.headers = {};
    }
  }

  // Capture request body by monkey patching write and end
  const originalWrite = req.write;
  const originalEnd = req.end;
  let requestBody = [];

  req.write = function (chunk) {
    if (chunk) requestBody.push(chunk);
    return originalWrite.apply(this, arguments);
  };

  req.end = function (chunk) {
    if (chunk) requestBody.push(chunk);

    // Add body to log data if we captured any
    if (requestBody.length > 0) {
      try {
        const body = Buffer.concat(requestBody).toString();
        try {
          // Parse the body as JSON and redact sensitive fields
          const bodyObj = JSON.parse(body);

          // Redact user_id if present
          if (bodyObj.user_id) {
            bodyObj.user_id = "[REDACTED]";
          }

          logData.body = bodyObj;
        } catch (e) {
          // If not valid JSON, store as string with redacted sensitive info
          logData.body = redactSensitiveInfo(body);
        }
      } catch (e) {
        logData.body = "Error capturing body: " + e.message;
      }
    }

    // Store request log in memory
    requestLogs.push(logData);

    // Call original method
    return originalEnd.apply(this, arguments);
  };

  // Capture response data if enabled
  if (logResponses) {
    req.on("response", (res) => {
      const responseData = {
        timestamp: new Date().toISOString(),
        requestUrl: url,
        statusCode: res.statusCode,
        headers: res.headers,
      };

      // Collect response body chunks
      let responseBody = "";
      res.on("data", (chunk) => {
        responseBody += chunk;
      });

      // Process complete response
      res.on("end", () => {
        if (res.headers["content-type"] && res.headers["content-type"].includes("text/event-stream")) {
          // Parse SSE responses
          try {
            responseData.events = responseBody
              .split("\n\n")
              .filter((event) => event.trim())
              .map((event) => {
                const lines = event.split("\n");
                const result = {};
                for (const line of lines) {
                  if (line.startsWith("event: ")) {
                    result.event = line.substring(7);
                  } else if (line.startsWith("data: ")) {
                    try {
                      const data = JSON.parse(line.substring(6));

                      // Redact user_id in SSE events if present
                      if (data.user_id) {
                        data.user_id = "[REDACTED]";
                      }

                      result.data = data;
                    } catch (e) {
                      result.data = line.substring(6);
                    }
                  }
                }
                return result;
              });
          } catch (e) {
            responseData.sseParseError = e.message;
          }
        } else {
          // For non-SSE responses, try to parse as JSON
          try {
            const parsedBody = JSON.parse(responseBody);

            // Redact sensitive information
            if (parsedBody.user_id) {
              parsedBody.user_id = "[REDACTED]";
            }

            responseData.parsedBody = parsedBody;
          } catch (e) {
            // If not JSON, store the body (with sensitive data redacted)
            responseData.body = redactSensitiveInfo(responseBody);
          }
        }

        // Store in memory
        responseLogs.push(responseData);
      });
    });
  }
}

// Write logs function - can be called explicitly or on exit
function writeLogsToFile() {
  if (requestLogs.length === 0) {
    debugLog("No Claude API requests were captured in this session.");
    return;
  }

  debugLog("Writing captured Claude API logs to files...");

  try {
    // Make sure the log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Write request logs
    const requestContent = JSON.stringify(requestLogs, null, 2);
    fs.writeFileSync(logFile, requestContent);
    debugLog(`Requests saved to: ${logFile}`);

    // Write response logs if we captured any and logging is enabled
    if (logResponses && responseLogs.length > 0) {
      const responseContent = JSON.stringify(responseLogs, null, 2);
      fs.writeFileSync(responseLogFile, responseContent);
      debugLog(`Responses saved to: ${responseLogFile}`);
    }
  } catch (err) {
    console.error(`Error writing logs: ${err.message}`);
  }
}

// Handle logs on exit
process.on("exit", writeLogsToFile);

// Create the log directory if it doesn't exist
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
  debugLog(`Created log directory: ${logDir}`);
}

// Try to write an empty array to make sure we can write to the files
try {
  fs.writeFileSync(logFile, "[]");
  debugLog(`Successfully created test log file: ${logFile}`);
} catch (err) {
  console.error(`ERROR: Cannot write to log file: ${err.message}`);
}

// If running directly and not as a module
if (require.main === module) {
  debugLog("Direct capture module loaded, HTTP/HTTPS interception active");

  // Listen for termination signals
  process.on("SIGTERM", () => {
    debugLog("Capture process received SIGTERM, exiting");
    writeLogsToFile(); // Write logs before exiting
    process.exit(0);
  });

  process.on("SIGINT", () => {
    debugLog("Capture process received SIGINT, exiting");
    writeLogsToFile(); // Write logs before exiting
    process.exit(0);
  });

  // Auto-exit after 30 minutes to prevent orphaned processes
  setTimeout(
    () => {
      debugLog("Capture process timeout reached, exiting");
      writeLogsToFile(); // Write logs before exiting
      process.exit(0);
    },
    30 * 60 * 1000,
  );
}

// Make this module available for use
module.exports = {
  requestLogs,
  responseLogs,
  writeLogsToFile,
  logDir,
  logFile,
  responseLogFile,
};
