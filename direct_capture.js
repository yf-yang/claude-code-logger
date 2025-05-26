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
const JsonLinesLogger = require("./jsonl_logger");

// Configuration from environment variables
const logFile = process.env.CLAUDE_API_LOG_FILE;
const projectName = process.env.CLAUDE_PROJECT_NAME || "project";
const debugMode = process.env.CLAUDE_DEBUG === "true";
const version = process.env.CLAUDE_LOGGER_VERSION || "unknown";

// Initialize JSON Lines logger
let jsonLinesLogger = null;
if (logFile) {
  // Log file should already have .jsonl extension from claude_logger.js
  jsonLinesLogger = new JsonLinesLogger(logFile, {
    maxQueueSize: 10,  // Smaller queue for more frequent writes
    flushInterval: 2000
  });
}

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

debugLog("Patching http/https request methods");

// Counter for tracking requests
let requestCounter = 0;

// Store original fetch if it exists
const originalFetch = global.fetch;

// Track active connections for debugging
const activeConnections = new Map();

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

  // Track connection reuse
  if (req.socket) {
    const socketKey = `${req.socket.localAddress}:${req.socket.localPort}->${req.socket.remoteAddress}:${req.socket.remotePort}`;
    if (activeConnections.has(socketKey)) {
      debugLog(`Reusing existing connection: ${socketKey}`);
      activeConnections.set(socketKey, activeConnections.get(socketKey) + 1);
    } else {
      debugLog(`New connection established: ${socketKey}`);
      activeConnections.set(socketKey, 1);
    }
  }

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

  debugLog(`Request details - URL: ${url}, Method: ${options.method || 'GET'}`);

  // Call original and capture request object
  const req = originalHttpsRequest.apply(this, arguments);

  // Track connection reuse for HTTPS
  req.on('socket', (socket) => {
    const socketKey = `${socket.localAddress || 'unknown'}:${socket.localPort || 'unknown'}->${socket.remoteAddress || options.hostname}:${socket.remotePort || options.port || 443}`;
    if (activeConnections.has(socketKey)) {
      const count = activeConnections.get(socketKey) + 1;
      debugLog(`HTTPS: Reusing existing connection: ${socketKey} (request #${count})`);
      activeConnections.set(socketKey, count);
    } else {
      debugLog(`HTTPS: New connection established: ${socketKey}`);
      activeConnections.set(socketKey, 1);
    }
  });

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
  // Log all requests for debugging
  debugLog(`Intercepted ${protocol} request to: ${url}`);
  
  // Skip non-Claude API requests
  if (!url.includes("anthropic.com")) {
    debugLog(`Skipping non-Claude request: ${url}`);
    return;
  }

  requestCounter++;
  const requestId = `req-${Date.now()}-${requestCounter}`;
  debugLog(`Found Claude API request #${requestCounter} (ID: ${requestId}) to: ${url}`);
  debugLog(`Logging API request #${requestCounter}`);

  // Get current datetime for the log entry
  const timestamp = new Date().toISOString();
  
  // Create log data object with request/response structure
  const logEntry = {
    requestId: requestId,
    request: {
      timestamp: timestamp,
      protocol: protocol,
      url: url,
    },
    response: null, // Will be populated when response is received
  };
  
  // Store requestId on the request object for later reference
  req._logRequestId = requestId;
  req._logEntry = logEntry;
  
  // Add project metadata
  logEntry.project = {
    name: projectName,
    timestamp: timestamp,
    version: version
  };
  
  // Don't log yet - wait for response

  // Add method and headers if available (with sensitive data redacted)
  if (typeof options === "object") {
    logEntry.request.method = options.method || "GET";

    // Deep copy and redact headers
    if (options.headers) {
      logEntry.request.headers = JSON.parse(JSON.stringify(options.headers));

      // Explicitly redact sensitive headers (case-insensitive)
      for (const key in logEntry.request.headers) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === "x-api-key" || lowerKey === "authorization") {
          logEntry.request.headers[key] = "[REDACTED]";
        }
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
    if (chunk) {
      // Ensure chunk is a Buffer
      requestBody.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return originalWrite.apply(this, arguments);
  };

  req.end = function (chunk) {
    if (chunk) {
      // Ensure chunk is a Buffer
      requestBody.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

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
    let responseTimeout = null;
    let isStreamingResponse = false;
    let streamingLogWritten = false;
    
    // Handle response stream errors
    res.on('error', (error) => {
      debugLog(`Response stream error for ${requestId}: ${error.message}`);
      responseData.error = `Response error: ${error.message}`;
      
      // Clear timeout on error
      if (responseTimeout) {
        clearTimeout(responseTimeout);
      }
      
      // Log the error if not already logged
      if (!streamingLogWritten && jsonLinesLogger) {
        logEntry.response = responseData;
        jsonLinesLogger.log(logEntry).catch(err => {
          console.error('Error logging response error:', err);
        });
      }
    });
    
    // Check if this is a streaming response
    if (res.headers["content-type"] && res.headers["content-type"].includes("text/event-stream")) {
      isStreamingResponse = true;
      debugLog("Detected streaming (SSE) response");
      
      // For streaming responses, log the request immediately with a placeholder response
      responseData.streaming = true;
      responseData.streamStarted = new Date().toISOString();
      logEntry.response = responseData;
      
      // Write the initial request/response pair immediately for streaming
      if (jsonLinesLogger) {
        jsonLinesLogger.log(logEntry).catch(err => {
          console.error('Error logging streaming request:', err);
        });
      }
      streamingLogWritten = true;
      debugLog(`Logged streaming request ${req._logRequestId}`);
    }
    
    // Set a timeout for response collection
    // Use longer timeout for streaming responses (5 minutes vs 30 seconds)
    const timeoutDuration = isStreamingResponse ? 300000 : 30000;
    responseTimeout = setTimeout(() => {
      debugLog(`Response timeout reached after ${timeoutDuration/1000}s, logging partial response`);
      responseData.timeout = true;
      responseData.partialBody = responseChunks.length > 0 ? 
        `Partial response collected (${responseChunks.length} chunks, ${Buffer.concat(responseChunks).length} bytes)` : 
        "No response data collected";
      
      // Don't overwrite if already written for streaming
      if (!streamingLogWritten) {
        logEntry.response = responseData;
        // Log the timeout response
        if (jsonLinesLogger) {
          jsonLinesLogger.log(logEntry).catch(err => {
            console.error('Error logging timeout request:', err);
          });
        }
      }
    }, timeoutDuration);
    
    res.on("data", (chunk) => {
      responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      debugLog(`Response chunk received: ${chunk.length} bytes`);
    });

    // Process complete response
    res.on("end", () => {
      // Clear timeout since response completed
      if (responseTimeout) {
        clearTimeout(responseTimeout);
      }
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
        
        // Only update and write if not already written for streaming
        if (!streamingLogWritten) {
          logEntry.response = responseData;
          
          // Still trigger write even on error
          debugLog("Response error, triggering log write");
          setImmediate(() => {
            writeLogsToFile();
          });
        }
        return;
      }

      if (
        res.headers["content-type"] &&
        res.headers["content-type"].includes("text/event-stream")
      ) {
        debugLog(`Processing SSE response, total size: ${responseBody.length} bytes`);
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
          
          // Redact account information
          if (parsedBody.account) {
            if (parsedBody.account.uuid) parsedBody.account.uuid = "[REDACTED]";
            if (parsedBody.account.email) parsedBody.account.email = "[EMAIL_REDACTED]";
            if (parsedBody.account.full_name) parsedBody.account.full_name = "[REDACTED]";
          }
          
          // Redact organization information
          if (parsedBody.organization) {
            if (parsedBody.organization.uuid) parsedBody.organization.uuid = "[REDACTED]";
            if (parsedBody.organization.name) parsedBody.organization.name = "[REDACTED]";
          }

          responseData.body = parsedBody;
        } catch (e) {
          // If not JSON, store the body (with sensitive data redacted)
          responseData.body = redactSensitiveInfo(responseBody);
        }
      }

      // Only update response if not already written for streaming
      if (!streamingLogWritten) {
        logEntry.response = responseData;
        
        // Log the complete request/response pair
        if (jsonLinesLogger) {
          jsonLinesLogger.log(logEntry).catch(err => {
            console.error('Error logging request:', err);
          });
        }
        
        const reqId = req._logRequestId || 'unknown';
        debugLog(`Response complete for request ${reqId}`);
        debugLog(`Response had ${responseChunks.length} chunks, total size: ${Buffer.concat(responseChunks).length} bytes`);
      } else {
        debugLog(`Streaming response ended for request ${req._logRequestId}, already logged`);
      }
    });
    
    // Also track response errors
    res.on("error", (error) => {
      const reqId = req._logRequestId || 'unknown';
      debugLog(`Response error for request ${reqId}: ${error.message}`);
      responseData.error = error.message;
      
      // Only update and write if not already written for streaming
      if (!streamingLogWritten) {
        logEntry.response = responseData;
        
        // Log the complete request/response pair (even with error)
        if (jsonLinesLogger) {
          jsonLinesLogger.log(logEntry).catch(err => {
            console.error('Error logging request:', err);
          });
        }
        
        // Clear timeout on error
        if (responseTimeout) {
          clearTimeout(responseTimeout);
        }
        
        // Log the error response
        if (jsonLinesLogger) {
          jsonLinesLogger.log(logEntry).catch(err => {
            console.error('Error logging error response:', err);
          });
        }
      }
    });
  });
  
  // Track request errors
  req.on("error", (error) => {
    debugLog(`Request error for ${requestId}: ${error.message}`);
    logEntry.request.error = error.message;
    
    // Create minimal response entry for failed requests
    if (!logEntry.response) {
      logEntry.response = {
        timestamp: new Date().toISOString(),
        error: `Request failed: ${error.message}`
      };
    }
    
    // Log the connection error
    if (jsonLinesLogger && req._logEntry) {
      jsonLinesLogger.log(req._logEntry).catch(err => {
        console.error('Error logging connection error:', err);
      });
    }
  });
  
  // Handle socket errors to prevent crashes
  req.on('socket', (socket) => {
    // Store original listeners count to avoid interfering with existing handlers
    const originalErrorListenerCount = socket.listenerCount('error');
    const originalCloseListenerCount = socket.listenerCount('close');
    
    // Only add our listeners if we haven't already
    if (!socket._loggerListenersAdded) {
      socket._loggerListenersAdded = true;
      
      // Add our error handler without removing existing ones
      socket.prependListener('error', (error) => {
        debugLog(`Socket error for ${requestId}: ${error.message}`);
        // Log but don't prevent other handlers from running
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
          debugLog(`Socket closed unexpectedly for ${requestId}`);
        }
      });
      
      socket.prependListener('close', (hadError) => {
        if (hadError) {
          debugLog(`Socket closed with error for ${requestId}`);
        }
      });
    }
  });
  
  // Handle request abort/destroy
  req.on('abort', () => {
    debugLog(`Request aborted for ${requestId}`);
    if (!logEntry.response) {
      logEntry.response = {
        timestamp: new Date().toISOString(),
        error: 'Request aborted - this may be due to Claude CLI timeout during compaction or other long operations',
        abortReason: 'Client cancelled request'
      };
      if (jsonLinesLogger) {
        jsonLinesLogger.log(logEntry).catch(err => {
          console.error('Error logging aborted request:', err);
        });
      }
    }
  });
  
  req.on('close', () => {
    debugLog(`Request closed for ${requestId}`);
    // If request closed without response, log it
    if (!logEntry.response && !req._headerSent) {
      logEntry.response = {
        timestamp: new Date().toISOString(),
        error: 'Request closed without response'
      };
      if (jsonLinesLogger) {
        jsonLinesLogger.log(logEntry).catch(err => {
          console.error('Error logging closed request:', err);
        });
      }
    }
  });
}

// Track which logs have been written to file
let lastWrittenLogIndex = -1;

// Maximum number of logs to keep in memory before forcing a write
const MAX_LOGS_IN_MEMORY = 50;

// Force immediate write after completing a request/response pair
let pendingWrites = 0;

// Queue for pending write operations
const writeQueue = [];


/**
 * Writes accumulated logs to the log file
 * Handles errors gracefully and creates backups when necessary
 * @returns {boolean} - True if logs were written successfully, false otherwise
 */
function writeLogsToFile(forceWrite = false) {
  // Exit early if there are no new logs to write
  if (apiLogs.length === 0 || lastWrittenLogIndex >= apiLogs.length - 1) {
    debugLog("No new Claude API requests to write.");
    
    // Process any queued writes
    if (writeQueue.length > 0 && pendingWrites === 0) {
      const queuedWrite = writeQueue.shift();
      if (queuedWrite) {
        debugLog("Processing queued write request");
        setImmediate(() => writeLogsToFile());
      }
    }
    return true;
  }

  // Queue this write if one is already in progress
  if (pendingWrites > 0) {
    debugLog("Write already in progress, queueing...");
    writeQueue.push(Date.now());
    return false;
  }
  
  pendingWrites++;
  
  // Capture the current state to avoid race conditions
  const currentLogCount = apiLogs.length;
  const startIndex = lastWrittenLogIndex + 1;
  
  // Filter logs to only include those with responses (unless forceWrite is true)
  let logsToWrite = [];
  let lastCompleteIndex = lastWrittenLogIndex;
  
  for (let i = startIndex; i < currentLogCount; i++) {
    const log = apiLogs[i];
    if (forceWrite || log.response !== null) {
      logsToWrite.push(log);
      lastCompleteIndex = i;
    } else {
      // Stop at the first incomplete log (unless force writing)
      if (!forceWrite) {
        break;
      }
    }
  }
  
  // If no complete logs to write, exit early
  if (logsToWrite.length === 0 && !forceWrite) {
    debugLog("No complete logs to write yet.");
    pendingWrites--;
    return false;
  }
  
  debugLog(`Writing ${logsToWrite.length} complete logs (indices ${startIndex} to ${lastCompleteIndex})`);

  try {
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
    allLogs = allLogs.concat(logsToWrite);
    
    // Format logs as JSON
    const logsContent = JSON.stringify(allLogs, null, 2);
    
    // Save to log file (write to temp file first, then rename for atomicity)
    const tempLogFile = `${logFile}.temp-${Date.now()}`;
    fs.writeFileSync(tempLogFile, logsContent);
    fs.renameSync(tempLogFile, logFile);
    debugLog(`API logs saved to: ${logFile} (${logsToWrite.length} new entries)`);
    
    // Update the last written index to what we actually wrote
    lastWrittenLogIndex = lastCompleteIndex;
    
    // Don't clean up memory immediately - let it accumulate a bit more
    // This prevents losing logs that might be added during cleanup
    if (apiLogs.length > MAX_LOGS_IN_MEMORY * 3) {
      // Only remove logs that we're certain have been written
      const safeRemoveCount = Math.min(lastWrittenLogIndex + 1, apiLogs.length - MAX_LOGS_IN_MEMORY);
      if (safeRemoveCount > 0) {
        debugLog(`Cleaning up memory: removing ${safeRemoveCount} written logs`);
        apiLogs.splice(0, safeRemoveCount);
        lastWrittenLogIndex -= safeRemoveCount;
      }
    }
    
    pendingWrites--;
    
    // Process any queued writes
    if (writeQueue.length > 0) {
      const queuedWrite = writeQueue.shift();
      if (queuedWrite) {
        debugLog("Processing queued write after successful write");
        setImmediate(() => writeLogsToFile());
      }
    }
    
    return true;
  } catch (err) {
    console.error(`Error writing logs: ${err.message}`);
    pendingWrites--;
    
    // Schedule retry for failed writes
    setTimeout(() => {
      debugLog("Retrying failed write...");
      writeLogsToFile();
    }, 1000);
    
    return false;
  }
}

// JSON Lines logger handles its own periodic flushing and memory management

/**
 * Set up process signal handlers to ensure logs are written before exit
 */
function setupSignalHandlers() {
  // Handle normal exit
  process.on("exit", () => {
    // JSON Lines logger will handle flushing on exit
    if (jsonLinesLogger) {
      jsonLinesLogger.close();
    }
    debugLog(`Claude logger exiting gracefully`);
  });

  // Handle termination signals
  const handleSignal = (signal) => {
    return () => {
      debugLog(`Capture process received ${signal}, flushing logs and exiting`);
      
      // JSON Lines logger will handle flushing
      if (jsonLinesLogger) {
        jsonLinesLogger.close();
      }
      
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

// Set up global error handlers to prevent crashes from network errors
process.on('uncaughtException', (error) => {
  // Check if this is a network-related error we can safely ignore
  const isNetworkError = 
    error.code === 'ECONNRESET' || 
    error.code === 'EPIPE' || 
    error.code === 'ENOTFOUND' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ECONNREFUSED' ||
    (error.message && (
      error.message.includes('socket hang up') ||
      error.message.includes('read ECONNRESET') ||
      error.message.includes('write EPIPE')
    ));
    
  if (isNetworkError) {
    console.error('Network error in claude-logger (continuing):', error.message);
    debugLog(`Network error caught at process level: ${error.code || error.message}`);
    // Don't crash on network errors - these are expected in networked applications
  } else {
    // Log and re-emit non-network errors
    console.error('Uncaught exception in claude-logger:', error);
    // Remove our handler and re-emit to let the process handle it
    process.removeAllListeners('uncaughtException');
    process.emit('uncaughtException', error);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  // Similar handling for promise rejections
  const isNetworkError = reason && (
    reason.code === 'ECONNRESET' || 
    reason.code === 'EPIPE' || 
    reason.code === 'ENOTFOUND' ||
    reason.code === 'ETIMEDOUT' ||
    reason.code === 'ECONNREFUSED' ||
    (reason.message && (
      reason.message.includes('socket hang up') ||
      reason.message.includes('read ECONNRESET') ||
      reason.message.includes('write EPIPE')
    ))
  );
  
  if (isNetworkError) {
    console.error('Network error in promise (continuing):', reason.message || reason);
    debugLog('Network error caught in promise rejection');
  } else {
    // Log but don't re-throw promise rejections
    console.error('Unhandled rejection in claude-logger:', reason);
  }
});

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
      
      // Don't log yet - wait for response
      
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
        
        // Log the complete request/response pair
        if (jsonLinesLogger) {
          jsonLinesLogger.log(logEntry).catch(err => {
            console.error('Error logging fetch request:', err);
          });
        }
        debugLog(`Fetch response complete for request ${requestId}`);
        
        return response;
      } catch (error) {
        // Log error
        logEntry.response = {
          timestamp: new Date().toISOString(),
          error: error.message
        };
        
        // Log the error response
        if (jsonLinesLogger) {
          jsonLinesLogger.log(logEntry).catch(err => {
            console.error('Error logging fetch error:', err);
          });
        }
        
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
  // Expose the JSON Lines logger
  jsonLinesLogger,
  
  // Core functions
  redactSensitiveInfo,
  
  // Log file paths
  logFile,
  
  // Configuration
  debugMode
};
