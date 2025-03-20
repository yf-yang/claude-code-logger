#!/usr/bin/env node

/**
 * Claude API Direct Capture Module
 *
 * This module intercepts HTTP/HTTPS requests made by the Claude CLI to capture
 * API calls to Anthropic. It can be used both as a library and standalone.
 */

const fs = require("fs");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

// Configuration from environment variables
const logFile = process.env.CLAUDE_API_LOG_FILE;
const debugMode = process.env.CLAUDE_DEBUG === "true";

// In-memory store for accumulating logs
const apiLogs = [];

// Sensitive data patterns to redact
const sensitivePatterns = [
  {
    regex: /"x-api-key":\s*"([^"]+)"/g,
    replacement: '"x-api-key": "[REDACTED]"',
  },
  {
    regex: /"Authorization":\s*"([^"]+)"/gi,
    replacement: '"Authorization": "[REDACTED]"',
  },
  { regex: /"user_id":\s*"([^"]+)"/g, replacement: '"user_id": "[REDACTED]"' },
  {
    regex: /"session_id":\s*"([^"]+)"/g,
    replacement: '"session_id": "[REDACTED]"',
  },
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

  // Create log data object with request/response structure
  const logEntry = {
    request: {
      timestamp: new Date().toISOString(),
      protocol: protocol,
      url: url,
    },
    response: null, // Will be populated when response is received
  };
  apiLogs.push(logEntry);

  // Add method and headers if available (with sensitive data redacted)
  if (typeof options === "object") {
    logEntry.request.method = options.method || "GET";

    // Deep copy and redact headers
    if (options.headers) {
      logEntry.request.headers = JSON.parse(JSON.stringify(options.headers));

      // Explicitly redact sensitive headers
      if (logEntry.request.headers["x-api-key"]) {
        logEntry.request.headers["x-api-key"] = "[REDACTED]";
      }
      if (logEntry.request.headers["authorization"]) {
        logEntry.request.headers["authorization"] = "[REDACTED]";
      }
    } else {
      logEntry.request.headers = {};
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

          logEntry.request.body = bodyObj;
        } catch (e) {
          // If not valid JSON, store as string with redacted sensitive info
          logEntry.request.body = redactSensitiveInfo(body);
        }
      } catch (e) {
        logEntry.request.body = "Error capturing body: " + e.message;
      }
    }

    // Call original method
    return originalEnd.apply(this, arguments);
  };

  // Capture response data
  req.on("response", (res) => {
    const responseData = {
      timestamp: new Date().toISOString(),
      statusCode: res.statusCode,
      headers: res.headers,
    };

    // Collect response body chunks
    const responseChunks = [];
    res.on("data", (chunk) => {
      responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    // Process complete response
    res.on("end", () => {
      let responseBody = "";
      try {
        const buffer = Buffer.concat(responseChunks);
        if (res.headers["content-encoding"] === "gzip") {
          responseBody = zlib.gunzipSync(buffer).toString();
        } else if (res.headers["content-encoding"] === "br") {
          responseBody = zlib.brotliDecompressSync(buffer).toString();
        } else if (res.headers["content-encoding"] === "deflate") {
          responseBody = zlib.inflateSync(buffer).toString();
        } else {
          responseBody = buffer.toString();
        }
      } catch (e) {
        responseData.bodyError = "Error processing response body: " + e.message;
        logEntry.response = responseData;
        return;
      }

      if (
        res.headers["content-type"] &&
        res.headers["content-type"].includes("text/event-stream")
      ) {
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

      logEntry.response = responseData;
    });
  });
}

// Write logs function - can be called explicitly or on exit
function writeLogsToFile() {
  if (apiLogs.length === 0) {
    debugLog("No Claude API requests were captured in this session.");
    return;
  }

  debugLog("Writing captured Claude API logs to file...");

  try {
    const logsContent = JSON.stringify(apiLogs, null, 2);
    fs.writeFileSync(logFile, logsContent);
    debugLog(`API logs saved to: ${logFile}`);
  } catch (err) {
    console.error(`Error writing logs: ${err.message}`);
  }
}

// Handle logs on exit
process.on("exit", writeLogsToFile);

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
    writeLogsToFile();
    process.exit(1);
  });

  process.on("SIGINT", () => {
    debugLog("Capture process received SIGINT, exiting");
    writeLogsToFile();
    process.exit(1);
  });
}

// Make this module available for use
module.exports = {
  apiLogs,
  writeLogsToFile,
  logFile,
};
