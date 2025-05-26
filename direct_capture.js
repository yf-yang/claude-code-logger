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
const projectName = process.env.CLAUDE_PROJECT_NAME || "project";
const debugMode = process.env.CLAUDE_DEBUG === "true";
const version = process.env.CLAUDE_LOGGER_VERSION || "unknown";

// In-memory store for accumulating logs
const apiLogs = [];

// Log startup with version information
debugLog(`Claude Logger v${version} started`);

// Sensitive data patterns to redact
const sensitivePatterns = [
  // Header-related patterns
  {
    regex: /"x-api-key":\s*"([^"]+)"/g,
    replacement: '"x-api-key": "[REDACTED]"',
  },
  {
    regex: /"Authorization":\s*"([^"]+)"/gi,
    replacement: '"Authorization": "[REDACTED]"',
  },
  
  // User identification patterns
  // JSON format patterns (for request/response bodies)
  { regex: /"(user_id|account_id|account_uuid)":\s*"([^"]+)"/g, replacement: '"$1": "[REDACTED]"' },
  // URL parameter patterns (for query strings)
  { regex: /(user_id|account_id|account_uuid)=([^&"\s]+)/g, replacement: '$1=[REDACTED]' },
  
  // Organization patterns
  // JSON format patterns (for request/response bodies)
  { regex: /"(organization_id|org_id)":\s*"([^"]+)"/g, replacement: '"$1": "[REDACTED]"' },
  // URL parameter patterns (for query strings)
  { regex: /(organization_id|org_id)=([^&"\s]+)/g, replacement: '$1=[REDACTED]' },
  
  // Session-related patterns
  // JSON format pattern (for request/response bodies)
  { regex: /"session_id":\s*"([^"]+)"/g, replacement: '"session_id": "[REDACTED]"' },
  // URL parameter pattern (for query strings)
  { regex: /session_id=([^&"\s]+)/g, replacement: 'session_id=[REDACTED]' },
  
  // Token and authentication patterns
  // JSON format patterns (for request/response bodies)
  { regex: /"(token|refresh_token|access_token)":\s*"([^"]+)"/g, replacement: '"$1": "[REDACTED]"' },
  
  // API key patterns
  // JSON format pattern (for request/response bodies)
  { regex: /"api_key":\s*"([^"]+)"/g, replacement: '"api_key": "[REDACTED]"' },
  // URL parameter pattern (for query strings)
  { regex: /api_key=([^&"\s]+)/g, replacement: 'api_key=[REDACTED]' },
  
  // UUID patterns (commonly used for identifiers)
  { regex: /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi, replacement: '[UUID_REDACTED]' },
  
  // Email patterns (for privacy)
  { regex: /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g, replacement: '[EMAIL_REDACTED]' },
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

// Store original fetch if it exists
const originalFetch = global.fetch;

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

  // Get current datetime for the log entry
  const timestamp = new Date().toISOString();
  
  // Create log data object with request/response structure
  const logEntry = {
    request: {
      timestamp: timestamp,
      protocol: protocol,
      url: url,
    },
    response: null, // Will be populated when response is received
  };
  
  // Add project metadata
  logEntry.project = {
    name: projectName,
    timestamp: timestamp,
    version: version
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
        
        // Check for compression by content-encoding header or by detecting magic bytes
        const isGzip = res.headers["content-encoding"] === "gzip" || 
                      (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b);
        
        if (isGzip) {
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

// Track which logs have been written to file
let lastWrittenLogIndex = -1;


/**
 * Writes accumulated logs to the log file
 * Handles errors gracefully and creates backups when necessary
 * @returns {boolean} - True if logs were written successfully, false otherwise
 */
function writeLogsToFile() {
  // Exit early if there are no new logs to write
  if (apiLogs.length === 0 || lastWrittenLogIndex === apiLogs.length - 1) {
    debugLog("No new Claude API requests to write.");
    return true;
  }

  debugLog(`Writing logs: ${lastWrittenLogIndex + 1} to ${apiLogs.length - 1}`);

  try {
    // Get only the logs that haven't been written yet
    const newLogs = apiLogs.slice(lastWrittenLogIndex + 1);
    
    // Ensure parent directory exists
    const logFileDir = require('path').dirname(logFile);
    if (!fs.existsSync(logFileDir)) {
      fs.mkdirSync(logFileDir, { recursive: true });
      debugLog(`Created log directory: ${logFileDir}`);
    }
    
    // Read and parse existing logs if the file exists
    let allLogs = [];
    if (fs.existsSync(logFile)) {
      try {
        const content = fs.readFileSync(logFile, 'utf8');
        if (content && content.trim() !== '[]') {
          allLogs = JSON.parse(content);
          // Validate that we have an array
          if (!Array.isArray(allLogs)) {
            throw new Error("Existing log file does not contain a valid array");
          }
        }
      } catch (parseErr) {
        debugLog(`Error parsing existing log file: ${parseErr.message}`);
        
        // Create a backup of the original file instead of overwriting
        const backupFile = `${logFile}.backup-${Date.now()}`;
        try {
          fs.copyFileSync(logFile, backupFile);
          debugLog(`Backed up original log file to: ${backupFile}`);
        } catch (backupErr) {
          console.error(`Failed to create backup of corrupted log file: ${backupErr.message}`);
        }
        
        // Start fresh with an empty array
        allLogs = [];
      }
    }

    // Combine existing logs with new logs
    allLogs = allLogs.concat(newLogs);
    
    // Format logs as JSON
    const logsContent = JSON.stringify(allLogs, null, 2);
    
    // Save to log file (write to temp file first, then rename for atomicity)
    const tempLogFile = `${logFile}.temp-${Date.now()}`;
    fs.writeFileSync(tempLogFile, logsContent);
    fs.renameSync(tempLogFile, logFile);
    debugLog(`API logs saved to: ${logFile}`);
    
    // Update the last written index
    lastWrittenLogIndex = apiLogs.length - 1;
    return true;
  } catch (err) {
    console.error(`Error writing logs: ${err.message}`);
    return false;
  }
}

// Set up a periodic log writing interval (every 5 seconds)
const logInterval = setInterval(() => {
  if (apiLogs.length > 0) {
    writeLogsToFile();
  }
}, 5000);

/**
 * Set up process signal handlers to ensure logs are written before exit
 */
function setupSignalHandlers() {
  // Handle normal exit
  process.on("exit", () => {
    clearInterval(logInterval);
    writeLogsToFile();
    debugLog("Claude logger exiting gracefully");
  });

  // Handle termination signals
  const handleSignal = (signal) => {
    return () => {
      debugLog(`Capture process received ${signal}, flushing logs and exiting`);
      clearInterval(logInterval);
      writeLogsToFile();
      process.exit(0);  // Exit with success code
    };
  };

  // Set up handlers for common termination signals
  process.on("SIGTERM", handleSignal("SIGTERM"));
  process.on("SIGINT", handleSignal("SIGINT"));
  
  // Handle uncaught exceptions - attempt to save logs before crashing
  process.on("uncaughtException", (err) => {
    console.error(`FATAL: Uncaught exception: ${err.message}`);
    console.error(err.stack);
    clearInterval(logInterval);
    writeLogsToFile();
    process.exit(1);  // Exit with error code
  });
}

// Set up signal handlers
setupSignalHandlers();

// Log when module is loaded
debugLog("Direct capture module loaded");
debugLog(`Process PID: ${process.pid}`);
debugLog(`Parent PID: ${process.ppid}`);
debugLog(`Log file: ${logFile}`);
debugLog(`Process title: ${process.title}`);
debugLog(`Exec path: ${process.execPath}`);

// If running directly and not as a module
if (require.main === module) {
  debugLog("Direct capture module loaded, HTTP/HTTPS interception active");
  console.log(`Claude API Logger v${version} started - capturing requests to anthropic.com`);
} else {
  debugLog("Module loaded via require()");
}

// Patch fetch if it exists
if (typeof global.fetch === 'function') {
  debugLog("Patching global.fetch");
  
  global.fetch = async function(url, options = {}) {
    const urlString = typeof url === 'string' ? url : url.toString();
    
    debugLog(`Intercepted fetch request to: ${urlString}`);
    
    // Check if this is a Claude API request
    if (urlString.includes('anthropic.com')) {
      requestCounter++;
      const requestId = `req-${Date.now()}-${requestCounter}`;
      debugLog(`Found Claude API fetch request #${requestCounter} (ID: ${requestId}) to: ${urlString}`);
      
      const timestamp = new Date().toISOString();
      
      // Create log entry
      const logEntry = {
        requestId: requestId,
        request: {
          timestamp: timestamp,
          protocol: 'fetch',
          url: urlString,
          method: (options.method || 'GET').toUpperCase(),
          headers: options.headers || {}
        },
        response: null,
        project: {
          name: projectName,
          timestamp: timestamp,
          version: version
        }
      };
      
      // Redact authorization header
      if (logEntry.request.headers['authorization']) {
        logEntry.request.headers['authorization'] = '[REDACTED]';
      }
      if (logEntry.request.headers['Authorization']) {
        logEntry.request.headers['Authorization'] = '[REDACTED]';
      }
      
      // Add body if present
      if (options.body) {
        try {
          logEntry.request.body = typeof options.body === 'string' ? 
            JSON.parse(options.body) : options.body;
        } catch (e) {
          logEntry.request.body = options.body;
        }
      }
      
      apiLogs.push(logEntry);
      
      try {
        // Call original fetch
        const response = await originalFetch(url, options);
        
        // Clone response to read it without consuming
        const responseClone = response.clone();
        
        // Log response
        const responseData = {
          timestamp: new Date().toISOString(),
          statusCode: response.status,
          headers: {}
        };
        
        // Copy headers
        response.headers.forEach((value, key) => {
          responseData.headers[key] = value;
        });
        
        try {
          const responseBody = await responseClone.text();
          const contentType = response.headers.get('content-type');
          
          if (contentType && contentType.includes('application/json')) {
            try {
              const parsedBody = JSON.parse(responseBody);
              
              // Redact sensitive information
              if (parsedBody.user_id) parsedBody.user_id = "[REDACTED]";
              if (parsedBody.account) {
                if (parsedBody.account.uuid) parsedBody.account.uuid = "[REDACTED]";
                if (parsedBody.account.email) parsedBody.account.email = "[EMAIL_REDACTED]";
                if (parsedBody.account.full_name) parsedBody.account.full_name = "[REDACTED]";
              }
              if (parsedBody.organization) {
                if (parsedBody.organization.uuid) parsedBody.organization.uuid = "[REDACTED]";
                if (parsedBody.organization.name) parsedBody.organization.name = "[REDACTED]";
              }
              
              responseData.body = parsedBody;
            } catch (e) {
              responseData.body = redactSensitiveInfo(responseBody);
            }
          } else if (contentType && contentType.includes('text/event-stream')) {
            // Handle SSE responses
            responseData.body = responseBody;
            responseData.streaming = true;
          } else {
            responseData.body = redactSensitiveInfo(responseBody);
          }
        } catch (e) {
          responseData.bodyError = 'Error reading response body: ' + e.message;
        }
        
        logEntry.response = responseData;
        
        // Trigger immediate write
        debugLog(`Fetch response complete for request ${requestId}`);
        setImmediate(() => {
          writeLogsToFile();
        });
        
        return response;
      } catch (error) {
        // Log error
        logEntry.response = {
          timestamp: new Date().toISOString(),
          error: error.message
        };
        
        // Trigger write on error
        setImmediate(() => {
          writeLogsToFile();
        });
        
        throw error;
      }
    }
    
    // For non-Claude requests, just pass through
    return originalFetch(url, options);
  };
} else {
  debugLog("No global.fetch found, skipping fetch patching");
}

/**
 * Module exports for the Claude API Direct Capture
 * @module claude-logger/direct-capture
 */
module.exports = {
  // Expose the log data structure - can be used by parent module
  apiLogs,
  
  // Core functions
  writeLogsToFile,
  redactSensitiveInfo,
  
  // Log file paths
  logFile,
  
  // Configuration
  debugMode
};
