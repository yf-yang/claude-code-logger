import React, { useState, useCallback, useRef } from 'react'

const anthropic_base_url = import.meta.env.ANTHROPIC_BASE_URL || "anthropic.com";

const LogFileViewer = () => {
  const [logData, setLogData] = useState([])
  const [expandedItems, setExpandedItems] = useState(new Set())
  const [isDragOver, setIsDragOver] = useState(false)
  const [currentFileName, setCurrentFileName] = useState('')
  const [selectedModels, setSelectedModels] = useState(new Set())
  const fileInputRef = useRef(null)

  // Parse timestamp string to Date object
  const parseTimestamp = (timestampStr) => {
    return new Date(timestampStr.replace('Z', '+00:00'))
  }

  // Extract API data from log entry
  const extractApiData = (logEntry) => {
    const request = logEntry.request || {}
    const response = logEntry.response || {}
    
    // Check if this is an API request to anthropic_base_url (Claude API)
    if (!request.url?.includes(anthropic_base_url)) {
      return null
    }

    const requestBody = request.body || {}
    const responseBody = response.body || ''
    
    // Parse streaming response for token usage and assistant message
    let inputTokens = null
    let outputTokens = null
    let cachedInputTokens = null
    let cacheCreationInputTokens = null
    let assistantMessage = ''
    let toolCalls = []
    let currentToolCall = null
    
    if (typeof responseBody === 'string' && responseBody.includes('message_start')) {
      const lines = responseBody.split('\n')
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const dataStr = line.slice(6).trim()
            if (!dataStr || dataStr.startsWith('{"type": "ping"}')) {
              continue
            }
            const data = JSON.parse(dataStr)
            
            // Extract usage info from message_start event
            if (data.type === 'message_start' && data.message) {
              const usage = data.message.usage || {}
              inputTokens = usage.input_tokens
              outputTokens = usage.output_tokens
              cachedInputTokens = usage.cache_read_input_tokens
              cacheCreationInputTokens = usage.cache_creation_input_tokens
            }
            
            // Extract message content from text deltas
            else if (data.type === 'content_block_delta' && data.delta?.text) {
              assistantMessage += data.delta.text
            }
            
            // Handle tool use content blocks
            else if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
              currentToolCall = {
                id: data.content_block.id,
                name: data.content_block.name,
                input: ''
              }
            }
            
            // Handle tool use partial JSON
            else if (data.type === 'content_block_delta' && data.delta?.partial_json && currentToolCall) {
              currentToolCall.input += data.delta.partial_json
            }
            
            // Complete tool call
            else if (data.type === 'content_block_stop' && currentToolCall) {
              try {
                currentToolCall.input = JSON.parse(currentToolCall.input)
              } catch (e) {
                // Keep as string if parsing fails
              }
              toolCalls.push(currentToolCall)
              currentToolCall = null
            }
            
            // Update output tokens from message_delta
            else if (data.type === 'message_delta' && data.usage) {
              outputTokens = data.usage.output_tokens
            }
            
          } catch (e) {
            continue
          }
        }
      }
    }

    const messages = requestBody.messages || []
    const userMessages = messages.filter(msg => msg.role === 'user')
    
    let lastUserMessage = ''
    if (userMessages.length > 0) {
      const lastMsg = userMessages[userMessages.length - 1]
      const content = lastMsg.content || ''
      if (typeof content === 'string') {
        lastUserMessage = content
      } else if (Array.isArray(content)) {
        const textParts = content
          .filter(part => typeof part === 'object' && part.type === 'text')
          .map(part => part.text || '')
        lastUserMessage = textParts.join(' ')
      }
    }

    const systemPrompt = requestBody.system || []
    const tools = requestBody.tools || []
    
    // Parse system prompt array
    let parsedSystemPrompts = []
    if (Array.isArray(systemPrompt)) {
      parsedSystemPrompts = systemPrompt.map(prompt => ({
        text: prompt.text || '',
        isCached: !!(prompt.cache_control && prompt.cache_control.type === 'ephemeral')
      }))
    } else if (typeof systemPrompt === 'string') {
      parsedSystemPrompts = [{ text: systemPrompt, isCached: false }]
    }
    
    // Parse messages with content parts and caching
    const parsedMessages = messages.map(msg => {
      let contentParts = []
      if (typeof msg.content === 'string') {
        contentParts = [{ type: 'text', text: msg.content, isCached: false }]
      } else if (Array.isArray(msg.content)) {
        contentParts = msg.content.map(part => ({
          type: part.type || 'text',
          text: part.text || '',
          tool_use_id: part.tool_use_id || '',
          name: part.name || '',
          input: part.input || '',
          content: part.content || '',
          is_error: part.is_error || false,
          isCached: !!(part.cache_control && part.cache_control.type === 'ephemeral')
        }))
      }
      return {
        role: msg.role,
        contentParts
      }
    })
    
    const requestTime = request.timestamp ? parseTimestamp(request.timestamp) : null
    const responseTime = response.timestamp ? parseTimestamp(response.timestamp) : null
    const responseTimeMs = (requestTime && responseTime) 
      ? responseTime.getTime() - requestTime.getTime() 
      : null

    return {
      id: logEntry.requestId,
      timestamp: requestTime,
      model: requestBody.model,
      maxTokens: requestBody.max_tokens,
      temperature: requestBody.temperature,
      messageCount: messages.length,
      systemPrompts: parsedSystemPrompts,
      messages: parsedMessages,
      tools: tools,
      lastUserMessage,
      assistantMessage,
      toolCalls,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheCreationInputTokens,
      responseStatus: response.statusCode,
      responseTimeMs,
      toolsAvailable: tools.length,
      streaming: requestBody.stream || false,
      rawRequest: request,
      rawResponse: response
    }
  }

  // Parse log file
  const parseLogFile = async (file) => {
    const text = await file.text()
    const lines = text.trim().split('\n')
    const apiRequests = []

    for (const line of lines) {
      if (!line.trim()) continue
      
      try {
        const logEntry = JSON.parse(line)
        const apiData = extractApiData(logEntry)
        if (apiData) {
          apiRequests.push(apiData)
        }
      } catch (e) {
        console.warn('Could not parse line:', e)
      }
    }

    return apiRequests.sort((a, b) => 
      (a.timestamp?.getTime() || 0) - (b.timestamp?.getTime() || 0)
    )
  }

  const handleDrop = useCallback(async (e) => {
    e.preventDefault()
    setIsDragOver(false)
    
    const files = Array.from(e.dataTransfer.files)
    const logFile = files.find(f => f.name.endsWith('.jsonl') || f.name.includes('claude-code-logger'))
    
    if (logFile) {
      try {
        const data = await parseLogFile(logFile)
        setLogData(data)
        setCurrentFileName(logFile.name)
      } catch (error) {
        console.error('Error parsing log file:', error)
        alert('Error parsing log file. Please ensure it\'s a valid JSONL file.')
      }
    } else {
      alert('Please drop a valid Claude Code Logger .jsonl file')
    }
  }, [])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleFileSelect = useCallback(async (e) => {
    const files = Array.from(e.target.files)
    const logFile = files.find(f => f.name.endsWith('.jsonl') || f.name.includes('claude-code-logger'))
    
    if (logFile) {
      try {
        const data = await parseLogFile(logFile)
        setLogData(data)
        setCurrentFileName(logFile.name)
      } catch (error) {
        console.error('Error parsing log file:', error)
        alert('Error parsing log file. Please ensure it\'s a valid JSONL file.')
      }
    } else {
      alert('Please select a valid Claude Code Logger .jsonl file')
    }
  }, [])

  const handleClickToSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const toggleExpanded = (id) => {
    const newExpanded = new Set(expandedItems)
    if (newExpanded.has(id)) {
      newExpanded.delete(id)
    } else {
      newExpanded.add(id)
    }
    setExpandedItems(newExpanded)
  }

  // Get preview text for collapsed view
  const getSystemPromptPreview = (systemPrompts) => {
    if (!systemPrompts || systemPrompts.length === 0) return ''
    return systemPrompts[0].text ? truncateText(systemPrompts[0].text, 100) : ''
  }

  const getFirstUserMessagePreview = (messages) => {
    if (!messages || messages.length === 0) return ''
    const userMessage = messages.find(msg => msg.role === 'user')
    if (!userMessage || !userMessage.contentParts || userMessage.contentParts.length === 0) return ''
    const textPart = userMessage.contentParts.find(part => part.type === 'text')
    return textPart ? truncateText(textPart.text, 100) : ''
  }

  const getResponsePreview = (assistantMessage) => {
    return assistantMessage ? truncateText(assistantMessage, 100) : ''
  }

  const formatTokens = (tokens) => {
    return tokens ? tokens.toLocaleString() : 'N/A'
  }

  const formatTime = (timestamp) => {
    if (!timestamp) return 'N/A'
    return timestamp.toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hour12: false
    })
  }

  const formatDuration = (ms) => {
    return ms ? `${ms.toFixed(0)}ms` : 'N/A'
  }

  const truncateText = (text, maxLength = 100) => {
    if (!text) return 'N/A'
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text
  }

  // Get unique models from log data
  const getUniqueModels = () => {
    const models = new Set()
    logData.forEach(item => {
      if (item.model) {
        models.add(item.model)
      }
    })
    return Array.from(models).sort()
  }

  // Filter log data based on selected models
  const getFilteredData = () => {
    if (selectedModels.size === 0) {
      return logData
    }
    return logData.filter(item => selectedModels.has(item.model))
  }

  // Toggle model selection
  const toggleModelSelection = (model) => {
    const newSelection = new Set(selectedModels)
    if (newSelection.has(model)) {
      newSelection.delete(model)
    } else {
      newSelection.add(model)
    }
    setSelectedModels(newSelection)
  }

  // Component for displaying system prompts with caching indicators
  const SystemPromptsDisplay = ({ systemPrompts }) => {
    if (!systemPrompts || systemPrompts.length === 0) {
      return <div className="text-gray-500 italic">No system prompt</div>
    }

    return (
      <div className="space-y-3">
        {systemPrompts.map((prompt, index) => (
          <div key={index} className="border border-gray-200 rounded-md">
            <div className="bg-gray-100 px-3 py-2 border-b border-gray-200 flex items-center gap-2">
              <span className="text-sm font-medium text-gray-700">System Prompt {index + 1}</span>
              {prompt.isCached && (
                <div className="flex items-center gap-1">
                  <span className="text-green-600 text-lg">⚡</span>
                  <span className="text-green-600 text-xs font-medium bg-green-100 px-2 py-1 rounded">CACHED</span>
                </div>
              )}
            </div>
            <pre className="bg-white p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {prompt.text || 'N/A'}
            </pre>
          </div>
        ))}
      </div>
    )
  }

  // Component for displaying tools with proper JSON schema formatting
  const ToolsDisplay = ({ tools }) => {
    if (!tools || tools.length === 0) {
      return <div className="text-gray-500 italic">No tools available</div>
    }

    return (
      <div className="space-y-4">
        {tools.map((tool, index) => (
          <ToolCard key={index} tool={tool} index={index} />
        ))}
      </div>
    )
  }

  // Individual tool card component
  const ToolCard = ({ tool, index }) => {
    const [isSchemaExpanded, setIsSchemaExpanded] = useState(false)
    const [isToolExpanded, setIsToolExpanded] = useState(false)

    return (
      <div className="border border-gray-200 rounded-md overflow-hidden">
        {/* Tool Header - Always Visible */}
        <div 
          className="bg-blue-50 px-4 py-3 border-b border-gray-200 cursor-pointer hover:bg-blue-100 transition-colors duration-200"
          onClick={() => setIsToolExpanded(!isToolExpanded)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h5 className="font-semibold text-blue-800">{tool.name}</h5>
              <span className="text-blue-600 text-sm bg-blue-100 px-2 py-1 rounded">Tool</span>
            </div>
            <div className="flex items-center gap-2">
              {tool.input_schema && (
                <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                  {Object.keys(tool.input_schema.properties || {}).length} properties
                </span>
              )}
              <span className="text-2xl text-blue-600 transition-transform duration-200">
                {isToolExpanded ? '▼' : '▶'}
              </span>
            </div>
          </div>
          
          {/* Collapsed Description Preview */}
          {!isToolExpanded && tool.description && (
            <p className="text-blue-700 text-sm mt-2 leading-relaxed line-clamp-2">
              {tool.description.length > 150 ? tool.description.substring(0, 150) + '...' : tool.description}
            </p>
          )}
        </div>

        {/* Expanded Content */}
        {isToolExpanded && (
          <div className="bg-white">
            {/* Full Description Section - Always Full When Expanded */}
            {tool.description && (
              <div className="p-4 border-b border-gray-100">
                <div className="mb-2">
                  <h6 className="text-sm font-medium text-gray-700">
                    📝 Description
                  </h6>
                </div>
                <p className="text-gray-700 text-sm leading-relaxed">
                  {tool.description}
                </p>
              </div>
            )}
            
            {/* Schema Section */}
            {tool.input_schema && (
              <div className="p-4 bg-gray-50">
                <div 
                  className="cursor-pointer group mb-3"
                  onClick={() => setIsSchemaExpanded(!isSchemaExpanded)}
                >
                  <div className="flex items-center justify-between">
                    <h6 className="text-sm font-medium text-gray-700 group-hover:text-blue-600 transition-colors">
                      🔧 Input Schema
                    </h6>
                    <span className="text-xs text-blue-600 group-hover:text-blue-800">
                      {isSchemaExpanded ? 'Click to hide' : 'Click to show details'}
                    </span>
                  </div>
                </div>
                {isSchemaExpanded && (
                  <div className="mt-3">
                    <JsonSchemaViewer schema={tool.input_schema} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // Custom JSON Schema Viewer component
  const JsonSchemaViewer = ({ schema }) => {
    if (!schema) return null

    const renderProperty = (key, prop, required = false, level = 0) => {
      const indent = level * 16
      const isRequired = required
      
      return (
        <div key={key} className="border-l border-gray-200 pl-4 mb-3" style={{ marginLeft: `${indent}px` }}>
          <div className="flex items-start gap-2 mb-1">
            <span className={`font-mono text-sm font-medium ${
              isRequired ? 'text-red-600' : 'text-blue-600'
            }`}>
              {key}
              {isRequired && <span className="text-red-500">*</span>}
            </span>
            {prop.type && (
              <span className="bg-gray-200 text-gray-700 text-xs px-2 py-1 rounded font-mono">
                {Array.isArray(prop.type) ? prop.type.join(' | ') : prop.type}
              </span>
            )}
            {prop.enum && (
              <span className="bg-purple-100 text-purple-700 text-xs px-2 py-1 rounded">
                enum
              </span>
            )}
            {prop.default !== undefined && (
              <span className="bg-green-100 text-green-700 text-xs px-2 py-1 rounded">
                default: {String(prop.default)}
              </span>
            )}
          </div>
          
          {prop.description && (
            <p className="text-gray-600 text-sm mb-2 leading-relaxed">
              {prop.description}
            </p>
          )}
          
          {prop.enum && (
            <div className="mb-2">
              <span className="text-xs text-gray-500 uppercase tracking-wide">Allowed values:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {prop.enum.map((value, idx) => (
                  <code key={idx} className="bg-purple-50 text-purple-700 text-xs px-2 py-1 rounded border">
                    {String(value)}
                  </code>
                ))}
              </div>
            </div>
          )}
          
          {prop.properties && (
            <div className="mt-2">
              <span className="text-xs text-gray-500 uppercase tracking-wide mb-2 block">Properties:</span>
              {Object.entries(prop.properties).map(([subKey, subProp]) =>
                renderProperty(
                  subKey, 
                  subProp, 
                  prop.required?.includes(subKey), 
                  level + 1
                )
              )}
            </div>
          )}
          
          {prop.items && (
            <div className="mt-2">
              <span className="text-xs text-gray-500 uppercase tracking-wide mb-2 block">Array items:</span>
              {renderProperty('items', prop.items, false, level + 1)}
            </div>
          )}
        </div>
      )
    }

    return (
      <div className="bg-white border border-gray-200 rounded p-4">
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <h6 className="font-medium text-gray-800">Schema Details</h6>
            {schema.type && (
              <span className="bg-blue-100 text-blue-700 text-xs px-2 py-1 rounded font-mono">
                {schema.type}
              </span>
            )}
          </div>
          {schema.description && (
            <p className="text-gray-600 text-sm mb-3">{schema.description}</p>
          )}
        </div>
        
        {schema.properties && (
          <div>
            <h6 className="text-sm font-medium text-gray-700 mb-3 border-b border-gray-200 pb-1">
              Properties
            </h6>
            <div className="space-y-1">
              {Object.entries(schema.properties).map(([key, prop]) =>
                renderProperty(key, prop, schema.required?.includes(key))
              )}
            </div>
          </div>
        )}
        
        {schema.required && schema.required.length > 0 && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded">
            <h6 className="text-sm font-medium text-red-800 mb-2">Required Properties</h6>
            <div className="flex flex-wrap gap-1">
              {schema.required.map((req, idx) => (
                <code key={idx} className="bg-red-100 text-red-700 text-xs px-2 py-1 rounded border">
                  {req}
                </code>
              ))}
            </div>
          </div>
        )}
        
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700">Show raw schema</summary>
          <pre className="mt-2 bg-gray-50 border border-gray-200 rounded p-3 font-mono text-xs leading-normal whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
            {JSON.stringify(schema, null, 2)}
          </pre>
        </details>
      </div>
    )
  }

  // Component for displaying messages with role-based formatting and caching
  const MessagesDisplay = ({ messages }) => {
    if (!messages || messages.length === 0) {
      return <div className="text-gray-500 italic">No messages</div>
    }

    const getRoleColor = (role) => {
      switch (role) {
        case 'user': return 'border-blue-500 bg-blue-50'
        case 'assistant': return 'border-green-500 bg-green-50'
        case 'system': return 'border-purple-500 bg-purple-50'
        default: return 'border-gray-500 bg-gray-50'
      }
    }

    const getRoleIcon = (role) => {
      switch (role) {
        case 'user': return '👤'
        case 'assistant': return '🤖'
        case 'system': return '⚙️'
        default: return '📝'
      }
    }

    return (
      <div className="space-y-4">
        {messages.map((message, messageIndex) => (
          <div key={messageIndex} className={`border-l-4 ${getRoleColor(message.role)} rounded-r-md overflow-hidden`}>
            <div className="px-4 py-2 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <span className="text-lg">{getRoleIcon(message.role)}</span>
                <span className="font-semibold text-gray-800 capitalize">{message.role}</span>
                {message.contentParts.some(part => part.isCached) && (
                  <div className="flex items-center gap-1">
                    <span className="text-green-600 text-sm">⚡</span>
                    <span className="text-green-600 text-xs font-medium bg-green-100 px-2 py-1 rounded">HAS CACHED CONTENT</span>
                  </div>
                )}
              </div>
            </div>
            <div className="p-4 space-y-3">
              {message.contentParts.map((part, partIndex) => (
                <div key={partIndex} className="border border-gray-200 rounded">
                  <div className="bg-gray-100 px-3 py-2 border-b border-gray-200 flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-700">
                      {part.type === 'text' ? '📝 Text Content' : 
                       part.type === 'tool_use' ? '🔧 Tool Use' : 
                       part.type === 'tool_result' ? '📊 Tool Result' : 
                       `📎 ${part.type}`}
                    </span>
                    <div className="flex items-center gap-2">
                      {part.type === 'tool_use' && part.name && (
                        <span className="text-blue-600 text-xs bg-blue-100 px-2 py-1 rounded">
                          {part.name}
                        </span>
                      )}
                      {part.type === 'tool_result' && part.tool_use_id && (
                        <span className="text-gray-600 text-xs bg-gray-100 px-2 py-1 rounded">
                          ID: {part.tool_use_id}
                        </span>
                      )}
                      {part.type === 'tool_result' && part.is_error && (
                        <span className="text-red-600 text-xs bg-red-100 px-2 py-1 rounded">
                          ERROR
                        </span>
                      )}
                      {part.isCached && (
                        <div className="flex items-center gap-1">
                          <span className="text-green-600 text-sm">⚡</span>
                          <span className="text-green-600 text-xs font-medium bg-green-100 px-2 py-1 rounded">CACHED</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="bg-white p-3">
                    {part.type === 'text' && (
                      <pre className="font-mono text-sm leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                        {part.text || 'N/A'}
                      </pre>
                    )}
                    {part.type === 'tool_use' && (
                      <div className="space-y-3">
                        <div>
                          <h6 className="text-sm font-medium text-gray-700 mb-1">Tool Name:</h6>
                          <span className="text-blue-600 font-medium">{part.name || 'N/A'}</span>
                        </div>
                        <div>
                          <h6 className="text-sm font-medium text-gray-700 mb-1">Input:</h6>
                          <pre className="bg-gray-50 border border-gray-200 rounded p-2 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                            {typeof part.input === 'object' ? JSON.stringify(part.input, null, 2) : part.input || 'N/A'}
                          </pre>
                        </div>
                      </div>
                    )}
                    {part.type === 'tool_result' && (
                      <div className="space-y-3">
                        <div>
                          <h6 className="text-sm font-medium text-gray-700 mb-1">Tool Use ID:</h6>
                          <span className="text-gray-600 font-mono text-sm">{part.tool_use_id || 'N/A'}</span>
                        </div>
                        <div>
                          <h6 className="text-sm font-medium text-gray-700 mb-1">Result:</h6>
                          <pre className={`border border-gray-200 rounded p-2 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto ${
                            part.is_error ? 'bg-red-50 border-red-200' : 'bg-gray-50'
                          }`}>
                            {part.content || 'N/A'}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Component for displaying tool calls made by the assistant
  const ToolCallsDisplay = ({ toolCalls }) => {
    if (!toolCalls || toolCalls.length === 0) {
      return <div className="text-gray-500 italic">No tool calls</div>
    }

    return (
      <div className="space-y-3">
        {toolCalls.map((toolCall, index) => (
          <div key={index} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">🔧</span>
              <h5 className="font-semibold text-gray-800">{toolCall.name}</h5>
              <span className="text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded">
                {toolCall.id}
              </span>
            </div>
            
            <div className="mt-2">
              <h6 className="text-sm font-medium text-gray-700 mb-2">Input:</h6>
              <pre className="bg-white border border-gray-200 rounded p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {typeof toolCall.input === 'object' 
                  ? JSON.stringify(toolCall.input, null, 2) 
                  : toolCall.input || 'N/A'}
              </pre>
            </div>
          </div>
        ))}
      </div>
    )
  }

  const resetToFileSelection = () => {
    setLogData([])
    setCurrentFileName('')
    setExpandedItems(new Set())
    setSelectedModels(new Set())
  }

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="max-w-6xl mx-auto p-5 font-sans">
      <h1 className="text-center text-gray-800 mb-8 text-3xl font-bold">Claude Code Logger Viewer</h1>
      
      {currentFileName && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-blue-600 text-lg">📄</span>
              <div>
                <p className="font-semibold text-blue-800">Currently viewing:</p>
                <p className="text-blue-700 font-mono text-sm">{currentFileName}</p>
              </div>
            </div>
            <button
              onClick={resetToFileSelection}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-200"
            >
              ← Back to File Selection
            </button>
          </div>
        </div>
      )}
      
      {logData.length === 0 ? (
        <div 
          className={`border-3 border-dashed rounded-lg p-16 text-center bg-gray-50 transition-all duration-300 cursor-pointer ${
            isDragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-500 hover:bg-blue-50'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={handleClickToSelect}
        >
          <div>
            <p className="text-xl text-gray-600 mb-2">Drop a Claude Code Logger .jsonl file here</p>
            <p className="text-lg text-gray-600 mb-4">or click to select a file</p>
            <small className="text-gray-500">Files should be named like: claude-code-logger_*.jsonl</small>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jsonl"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
      ) : (
        <div>
          <div className="bg-white p-5 rounded-lg shadow-sm mb-5">
            <h2 className="text-xl font-semibold text-gray-800 mb-3">Summary</h2>
            <p className="mb-2">Total requests: {logData.length}</p>
            <p className="mb-2">Total input tokens: {formatTokens(logData.reduce((sum, item) => sum + (item.inputTokens || 0), 0))}</p>
            <p>Total output tokens: {formatTokens(logData.reduce((sum, item) => sum + (item.outputTokens || 0), 0))}</p>
          </div>

          {/* Model Filter Section */}
          {getUniqueModels().length > 1 && (
            <div className="bg-white p-5 rounded-lg shadow-sm mb-5">
              <h2 className="text-xl font-semibold text-gray-800 mb-3">Filter by Models</h2>
              <div className="flex flex-wrap gap-2">
                {getUniqueModels().map(model => (
                  <button
                    key={model}
                    onClick={() => toggleModelSelection(model)}
                    className={`px-4 py-2 rounded-lg font-medium transition-all duration-200 ${
                      selectedModels.has(model)
                        ? 'bg-blue-600 text-white shadow-md hover:bg-blue-700'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    {model}
                    {selectedModels.has(model) && <span className="ml-2">✓</span>}
                  </button>
                ))}
              </div>
              {selectedModels.size > 0 && (
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-sm text-gray-600">
                    Showing {getFilteredData().length} of {logData.length} requests
                  </span>
                  <button
                    onClick={() => setSelectedModels(new Set())}
                    className="text-sm text-blue-600 hover:text-blue-800 underline"
                  >
                    Clear all filters
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="space-y-4">
            {getFilteredData().map((item, index) => (
              <div key={item.id} className="bg-white rounded-lg shadow-sm overflow-hidden hover:shadow-md transition-shadow duration-200">
                <div 
                  className="p-4 cursor-pointer bg-gray-50 border-b border-gray-200 hover:bg-gray-100 transition-colors duration-200"
                  onClick={() => toggleExpanded(item.id)}
                >
                  {/* Header row with request number, model, tokens, time */}
                  <div className="flex justify-between items-center mb-3">
                    <div className="flex flex-wrap gap-5 items-center">
                      <span className="font-bold text-gray-800 bg-gray-200 px-3 py-1 rounded-full text-sm">
                        #{index + 1} of {getFilteredData().length}
                      </span>
                      <span className="font-semibold text-blue-600">{item.model}</span>
                      <span className="text-gray-600 text-sm">
                        {formatTokens(item.inputTokens)} / {formatTokens(item.outputTokens)} tokens
                        {item.cachedInputTokens > 0 && (
                          <span className="text-green-600 font-medium"> ({formatTokens(item.cachedInputTokens)} cached)</span>
                        )}
                        {item.systemPrompts?.some(p => p.isCached) && (
                          <span className="text-green-600 font-medium"> (⚡ cached)</span>
                        )}
                      </span>
                      <span className="text-gray-600 text-sm">{formatTime(item.timestamp)}</span>
                      <span className="text-gray-600 text-sm bg-gray-200 px-2 py-1 rounded">{formatDuration(item.responseTimeMs)}</span>
                    </div>
                    <span className="text-xl text-gray-600 transition-transform duration-200">
                      {expandedItems.has(item.id) ? '▼' : '▶'}
                    </span>
                  </div>

                  {/* Preview rows when collapsed */}
                  {!expandedItems.has(item.id) && (
                    <div className="space-y-2 text-sm">
                      {getSystemPromptPreview(item.systemPrompts) && (
                        <div className="flex">
                          <span className="text-purple-600 font-medium w-20 flex-shrink-0">System:</span>
                          <span className="text-gray-700 truncate">{getSystemPromptPreview(item.systemPrompts)}</span>
                        </div>
                      )}
                      {getFirstUserMessagePreview(item.messages) && (
                        <div className="flex">
                          <span className="text-blue-600 font-medium w-20 flex-shrink-0">User:</span>
                          <span className="text-gray-700 truncate">{getFirstUserMessagePreview(item.messages)}</span>
                        </div>
                      )}
                      {getResponsePreview(item.assistantMessage) && (
                        <div className="flex">
                          <span className="text-green-600 font-medium w-20 flex-shrink-0">Response:</span>
                          <span className="text-gray-700 truncate">{getResponsePreview(item.assistantMessage)}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {expandedItems.has(item.id) && (
                  <div className="p-5 bg-white">
                    {/* Token Usage Section - First */}
                    <div className="bg-gray-50 p-4 rounded-md mb-6">
                      <h4 className="text-lg font-semibold text-gray-800 mb-4 border-b-2 border-blue-500 pb-1">Token Usage</h4>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                          <p className="text-sm font-medium text-gray-600">Input Tokens</p>
                          <p className="text-lg font-semibold text-gray-800">{formatTokens(item.inputTokens)}</p>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-600">Output Tokens</p>
                          <p className="text-lg font-semibold text-gray-800">{formatTokens(item.outputTokens)}</p>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-600">Cached Input</p>
                          <p className="text-lg font-semibold text-green-600">{formatTokens(item.cachedInputTokens)}</p>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-600">Cache Creation</p>
                          <p className="text-lg font-semibold text-gray-800">{formatTokens(item.cacheCreationInputTokens)}</p>
                        </div>
                      </div>
                    </div>

                    {/* Content Sections */}
                    <div className="space-y-6">
                      {/* System Prompts - Second */}
                      <div>
                        <h4 className="text-base font-semibold text-gray-800 mb-3 border-l-4 border-blue-500 pl-3">
                          System Prompts
                        </h4>
                        <SystemPromptsDisplay systemPrompts={item.systemPrompts} />
                      </div>

                      {/* Messages and Assistant Response - Third */}
                      <div>
                        <h4 className="text-base font-semibold text-gray-800 mb-3 border-l-4 border-orange-500 pl-3">
                          Messages ({item.messageCount})
                        </h4>
                        <MessagesDisplay messages={item.messages} />
                      </div>

                      <div>
                        <h4 className="text-base font-semibold text-gray-800 mb-3 border-l-4 border-green-500 pl-3">Assistant Response</h4>
                        
                        {/* Tool Calls */}
                        {item.toolCalls && item.toolCalls.length > 0 && (
                          <div className="mb-4">
                            <h5 className="text-sm font-medium text-gray-700 mb-2">Tool Calls ({item.toolCalls.length}):</h5>
                            <ToolCallsDisplay toolCalls={item.toolCalls} />
                          </div>
                        )}
                        
                        {/* Text Response */}
                        {item.assistantMessage && (
                          <div>
                            <h5 className="text-sm font-medium text-gray-700 mb-2">Text Response:</h5>
                            <pre className="bg-gray-50 border border-gray-200 rounded-md p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                              {item.assistantMessage}
                            </pre>
                          </div>
                        )}
                        
                        {!item.assistantMessage && (!item.toolCalls || item.toolCalls.length === 0) && (
                          <div className="text-gray-500 italic">No response content</div>
                        )}
                      </div>

                      {/* Tools - Fourth */}
                      <div>
                        <h4 className="text-base font-semibold text-gray-800 mb-3 border-l-4 border-purple-500 pl-3">
                          Tools ({item.toolsAvailable})
                        </h4>
                        <ToolsDisplay tools={item.tools} />
                      </div>

                      {/* Request Details - Fifth */}
                      <div className="bg-gray-50 p-4 rounded-md">
                        <h4 className="text-lg font-semibold text-gray-800 mb-4 border-b-2 border-blue-500 pb-1">Request Details</h4>
                        <div className="grid md:grid-cols-2 gap-4">
                          <div>
                            <p className="mb-2 text-sm"><strong>Request ID:</strong> {item.id}</p>
                            <p className="mb-2 text-sm"><strong>Model:</strong> {item.model}</p>
                            <p className="mb-2 text-sm"><strong>Temperature:</strong> {item.temperature}</p>
                          </div>
                          <div>
                            <p className="mb-2 text-sm"><strong>Max Tokens:</strong> {item.maxTokens}</p>
                            <p className="mb-2 text-sm"><strong>Streaming:</strong> {item.streaming ? 'Yes' : 'No'}</p>
                            <p className="text-sm"><strong>Response Status:</strong> {item.responseStatus}</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <details className="mt-6 border border-gray-200 rounded-md">
                      <summary className="p-4 bg-gray-50 cursor-pointer font-semibold text-gray-800 hover:bg-gray-100 transition-colors duration-200">
                        Raw Request/Response Data
                      </summary>
                      <div className="border-t border-gray-200">
                        <div className="p-4">
                          <h5 className="mb-2 text-gray-600 text-sm font-medium uppercase tracking-wide">Request</h5>
                          <pre className="bg-gray-50 border border-gray-200 rounded p-4 font-mono text-xs leading-normal whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
                            {JSON.stringify(item.rawRequest, null, 2)}
                          </pre>
                        </div>
                        <div className="p-4 border-t border-gray-200">
                          <h5 className="mb-2 text-gray-600 text-sm font-medium uppercase tracking-wide">Response</h5>
                          <pre className="bg-gray-50 border border-gray-200 rounded p-4 font-mono text-xs leading-normal whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
                            {JSON.stringify(item.rawResponse, null, 2)}
                          </pre>
                        </div>
                      </div>
                    </details>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scroll to Top Button */}
      {logData.length > 0 && (
        <button
          onClick={scrollToTop}
          className="fixed bottom-6 right-6 bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-full shadow-lg hover:shadow-xl transition-all duration-200 z-50"
          title="Scroll to top"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
        </button>
      )}
    </div>
  )
}

export default LogFileViewer