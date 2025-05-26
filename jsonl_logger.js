const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const appendFile = promisify(fs.appendFile);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const rename = promisify(fs.rename);
const stat = promisify(fs.stat);

class JsonLinesLogger {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.queue = [];
    this.isWriting = false;
    this.isClosed = false;
    
    // Configuration options
    this.maxQueueSize = options.maxQueueSize || 100;
    this.flushInterval = options.flushInterval || 2000;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
    
    // Start periodic flush
    this.flushIntervalId = setInterval(() => {
      this.flush().catch(err => {
        console.error('Error during periodic flush:', err);
      });
    }, this.flushInterval);
    
    // Ensure logs are written on process exit
    this.setupExitHandlers();
  }
  
  setupExitHandlers() {
    const exitHandler = () => {
      this.close();
    };
    
    process.on('exit', exitHandler);
    process.on('SIGINT', exitHandler);
    process.on('SIGTERM', exitHandler);
    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception:', err);
      exitHandler();
      process.exit(1);
    });
  }
  
  /**
   * Add a log entry to the queue
   * @param {Object} logEntry - The log entry to add
   * @returns {Promise<void>} - Resolves when the entry is queued
   */
  async log(logEntry) {
    if (this.isClosed) {
      throw new Error('Logger is closed');
    }
    
    // Add timestamp if not present
    if (!logEntry.timestamp) {
      logEntry.timestamp = new Date().toISOString();
    }
    
    this.queue.push(logEntry);
    
    // Flush if queue is getting large
    if (this.queue.length >= this.maxQueueSize) {
      await this.flush();
    }
  }
  
  /**
   * Flush the queue to disk
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.isWriting || this.queue.length === 0) {
      return;
    }
    
    this.isWriting = true;
    const logsToWrite = [...this.queue];
    this.queue = [];
    
    try {
      await this.writeLogsWithRetry(logsToWrite);
    } catch (error) {
      // Put logs back in queue if write failed
      this.queue.unshift(...logsToWrite);
      throw error;
    } finally {
      this.isWriting = false;
    }
  }
  
  /**
   * Write logs with retry logic
   * @param {Array} logs - Array of log entries
   * @returns {Promise<void>}
   */
  async writeLogsWithRetry(logs) {
    let lastError;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        await this.writeLogs(logs);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        }
      }
    }
    
    throw lastError;
  }
  
  /**
   * Write logs to file
   * @param {Array} logs - Array of log entries
   * @returns {Promise<void>}
   */
  async writeLogs(logs) {
    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    
    // Convert logs to JSON Lines format
    const jsonLines = logs.map(log => JSON.stringify(log)).join('\n') + '\n';
    
    // Check if file exists
    let fileExists = false;
    try {
      await stat(this.filePath);
      fileExists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    
    if (fileExists) {
      // Append to existing file
      await appendFile(this.filePath, jsonLines, 'utf8');
    } else {
      // Create new file
      await writeFile(this.filePath, jsonLines, 'utf8');
    }
  }
  
  /**
   * Close the logger and flush remaining logs
   */
  close() {
    if (this.isClosed) {
      return;
    }
    
    this.isClosed = true;
    
    if (this.flushIntervalId) {
      clearInterval(this.flushIntervalId);
      this.flushIntervalId = null;
    }
    
    // Synchronous flush on close
    if (this.queue.length > 0) {
      const logsToWrite = [...this.queue];
      const jsonLines = logsToWrite.map(log => JSON.stringify(log)).join('\n') + '\n';
      
      try {
        // Ensure directory exists synchronously
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        // Append synchronously
        fs.appendFileSync(this.filePath, jsonLines, 'utf8');
        this.queue = [];
      } catch (error) {
        console.error('Error during synchronous flush:', error);
      }
    }
  }
  
  /**
   * Migrate existing JSON log file to JSON Lines format
   * @param {string} jsonFilePath - Path to existing JSON log file
   * @param {string} jsonlFilePath - Path to new JSON Lines file
   * @returns {Promise<void>}
   */
  static async migrateFromJson(jsonFilePath, jsonlFilePath) {
    try {
      // Check if JSON file exists
      await stat(jsonFilePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // No file to migrate
        return;
      }
      throw error;
    }
    
    // Read existing JSON file
    const jsonContent = await readFile(jsonFilePath, 'utf8');
    let logs;
    
    try {
      logs = JSON.parse(jsonContent);
    } catch (error) {
      console.error('Error parsing existing log file:', error);
      // If parse fails, backup the corrupt file
      const backupPath = jsonFilePath + '.backup.' + Date.now();
      await rename(jsonFilePath, backupPath);
      console.log(`Corrupt log file backed up to: ${backupPath}`);
      return;
    }
    
    if (!Array.isArray(logs)) {
      console.error('Existing log file is not an array');
      return;
    }
    
    // Convert to JSON Lines
    const jsonLines = logs.map(log => JSON.stringify(log)).join('\n') + '\n';
    
    // Write to new file
    const dir = path.dirname(jsonlFilePath);
    await fs.promises.mkdir(dir, { recursive: true });
    await writeFile(jsonlFilePath, jsonLines, 'utf8');
    
    // Backup original file
    const backupPath = jsonFilePath + '.migrated.' + Date.now();
    await rename(jsonFilePath, backupPath);
    
    console.log(`Migrated ${logs.length} log entries from JSON to JSON Lines format`);
    console.log(`Original file backed up to: ${backupPath}`);
  }
  
  /**
   * Read logs from JSON Lines file
   * @param {string} filePath - Path to JSON Lines file
   * @returns {Promise<Array>} - Array of log entries
   */
  static async readJsonLines(filePath) {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');
      const logs = [];
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            logs.push(JSON.parse(line));
          } catch (error) {
            console.error('Error parsing JSON line:', error);
          }
        }
      }
      
      return logs;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}

module.exports = JsonLinesLogger;