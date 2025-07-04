#!/usr/bin/env python3
"""
Claude Code Logger Analysis Script

Extracts and analyzes data from Claude Code JSON Lines log files.
"""

import json
import sys
from datetime import datetime
from typing import Dict, List, Any, Optional
import pandas as pd

def parse_timestamp(timestamp_str: str) -> datetime:
    """Parse ISO timestamp string to datetime object."""
    return datetime.fromisoformat(timestamp_str.replace('Z', '+00:00'))

def extract_api_data(log_entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Extract API-related data from a log entry."""
    request = log_entry.get('request', {})
    response = log_entry.get('response', {})
    
    # Check if this is an API request to anyrouter.top (Claude API)
    if 'anyrouter.top' not in request.get('url', ''):
        return None
    
    # Extract request data
    request_body = request.get('body', {})
    
    # Extract response data
    response_body = response.get('body', '')
    
    # Parse streaming response for token usage and assistant message
    input_tokens = None
    output_tokens = None
    cached_input_tokens = None
    cache_creation_input_tokens = None
    assistant_message = ""
    
    if isinstance(response_body, str) and 'message_start' in response_body:
        # Parse streaming response for usage info and message content
        lines = response_body.split('\n')
        for line in lines:
            if line.startswith('data: '):
                try:
                    data_str = line[6:].strip()  # Remove 'data: ' prefix
                    if not data_str or data_str.startswith('{"type": "ping"}'):
                        continue
                    data = json.loads(data_str)
                    
                    # Extract usage info from message_start event
                    if data.get('type') == 'message_start' and 'message' in data:
                        usage = data['message'].get('usage', {})
                        input_tokens = usage.get('input_tokens')
                        output_tokens = usage.get('output_tokens')
                        cached_input_tokens = usage.get('cache_read_input_tokens')
                        cache_creation_input_tokens = usage.get('cache_creation_input_tokens')
                    
                    # Extract message content from text deltas
                    elif data.get('type') == 'content_block_delta' and 'delta' in data:
                        if 'text' in data['delta']:
                            assistant_message += data['delta']['text']
                    
                    # Update output tokens from message_delta
                    elif data.get('type') == 'message_delta' and 'usage' in data:
                        output_tokens = data['usage'].get('output_tokens')
                        
                except json.JSONDecodeError:
                    continue
                except Exception:
                    continue
    
    # Extract messages for better analysis
    messages = request_body.get('messages', [])
    user_messages = [msg for msg in messages if msg.get('role') == 'user']
    
    # Handle different user message formats
    last_user_message = ""
    if user_messages:
        last_msg = user_messages[-1]
        content = last_msg.get('content', '')
        if isinstance(content, str):
            last_user_message = content
        elif isinstance(content, list):
            # Handle structured content (e.g., with text blocks)
            text_parts = []
            for part in content:
                if isinstance(part, dict) and part.get('type') == 'text':
                    text_parts.append(part.get('text', ''))
                elif isinstance(part, str):
                    text_parts.append(part)
            last_user_message = ' '.join(text_parts)
    
    # Extract system prompt
    system_prompt = request_body.get('system', '')
    if isinstance(system_prompt, list):
        # Handle structured system prompt
        system_parts = []
        for part in system_prompt:
            if isinstance(part, dict) and part.get('type') == 'text':
                system_parts.append(part.get('text', ''))
            elif isinstance(part, str):
                system_parts.append(part)
        system_prompt = ' '.join(system_parts)
    
    return {
        'timestamp': parse_timestamp(request.get('timestamp', '')),
        'request_id': log_entry.get('requestId'),
        'model': request_body.get('model'),
        'max_tokens': request_body.get('max_tokens'),
        'temperature': request_body.get('temperature'),
        'message_count': len(messages),
        'system_prompt': system_prompt,
        'system_prompt_length': len(str(system_prompt)),
        'user_message_length': sum(len(str(msg.get('content', ''))) for msg in messages if msg.get('role') == 'user'),
        'last_user_message': last_user_message,
        'assistant_message': assistant_message,
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
        'cached_input_tokens': cached_input_tokens,
        'cache_creation_input_tokens': cache_creation_input_tokens,
        'response_status': response.get('statusCode'),
        'response_time_ms': (parse_timestamp(response.get('timestamp', '')) - parse_timestamp(request.get('timestamp', ''))).total_seconds() * 1000 if response.get('timestamp') and request.get('timestamp') else None,
        'tools_available': len(request_body.get('tools', [])),
        'streaming': request_body.get('stream', False)
    }

def extract_statsig_data(log_entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Extract Statsig telemetry data from a log entry."""
    request = log_entry.get('request', {})
    
    # Check if this is a Statsig request
    if 'statsig.anthropic.com' not in request.get('url', ''):
        return None
    
    request_body = request.get('body', {})
    events = request_body.get('events', [])
    
    extracted_events = []
    for event in events:
        event_name = event.get('eventName')
        metadata = event.get('metadata', {})
        
        if event_name == 'tengu_api_success':
            extracted_events.append({
                'timestamp': parse_timestamp(request.get('timestamp', '')),
                'event_type': event_name,
                'model': metadata.get('model'),
                'message_count': metadata.get('messageCount'),
                'input_tokens': metadata.get('inputTokens'),
                'output_tokens': metadata.get('outputTokens'),
                'cached_input_tokens': metadata.get('cachedInputTokens'),
                'uncached_input_tokens': metadata.get('uncachedInputTokens'),
                'duration_ms': metadata.get('durationMs'),
                'ttft_ms': metadata.get('ttftMs'),
                'cost_usd': metadata.get('costUSD'),
                'stop_reason': metadata.get('stop_reason'),
                'provider': metadata.get('provider'),
                'request_id': metadata.get('requestId'),
                'session_id': metadata.get('sessionId')
            })
        elif event_name == 'tengu_api_query':
            extracted_events.append({
                'timestamp': parse_timestamp(request.get('timestamp', '')),
                'event_type': event_name,
                'model': metadata.get('model'),
                'messages_length': metadata.get('messagesLength'),
                'temperature': metadata.get('temperature'),
                'provider': metadata.get('provider'),
                'session_id': metadata.get('sessionId'),
                'request_id': metadata.get('requestId')  # Add request_id for matching
            })
    
    return extracted_events if extracted_events else None

def analyze_log_file(file_path: str) -> Dict[str, Any]:
    """Analyze a Claude Code JSON Lines log file."""
    api_requests = []
    statsig_events = []
    
    print(f"Analyzing log file: {file_path}")
    
    with open(file_path, 'r', encoding='utf-8') as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            
            try:
                log_entry = json.loads(line)
                
                # Extract API data
                api_data = extract_api_data(log_entry)
                if api_data:
                    api_requests.append(api_data)
                
                # Extract Statsig data
                statsig_data = extract_statsig_data(log_entry)
                if statsig_data:
                    statsig_events.extend(statsig_data)
                    
            except json.JSONDecodeError as e:
                print(f"Warning: Could not parse JSON on line {line_num}: {e}")
                continue
    
    # Match API requests with Statsig events by request_id and timestamp
    matched_requests = []
    unmatched_api_requests = []
    
    # Create debug info
    debug_info = {
        'statsig_event_types': list(set(event.get('event_type', 'unknown') for event in statsig_events)),
        'sample_api_request_ids': [req.get('request_id') for req in api_requests[:3]],
        'sample_statsig_request_ids': [event.get('request_id') for event in statsig_events[:3] if event.get('request_id')]
    }
    
    for api_req in api_requests:
        # Find corresponding Statsig event
        matching_event = None
        
        # First try to match by request_id with tengu_api_success
        for event in statsig_events:
            if (event.get('request_id') == api_req.get('request_id') and 
                event.get('event_type') == 'tengu_api_success'):
                matching_event = event
                break
        
        # If no success event found, try tengu_api_query
        if not matching_event:
            for event in statsig_events:
                if (event.get('request_id') == api_req.get('request_id') and 
                    event.get('event_type') == 'tengu_api_query'):
                    matching_event = event
                    break
        
        # If still no match, try timestamp-based matching (within 5 seconds)
        if not matching_event:
            api_timestamp = api_req.get('timestamp')
            if api_timestamp:
                for event in statsig_events:
                    event_timestamp = event.get('timestamp')
                    if (event_timestamp and 
                        abs((api_timestamp - event_timestamp).total_seconds()) < 5 and
                        event.get('event_type') in ['tengu_api_success', 'tengu_api_query']):
                        matching_event = event
                        break
        
        if matching_event:
            # Merge API request data with Statsig metrics
            matched_req = {**api_req, **matching_event}
            matched_requests.append(matched_req)
        else:
            unmatched_api_requests.append(api_req)
    
    return {
        'api_requests': api_requests,
        'statsig_events': statsig_events,
        'matched_requests': matched_requests,
        'unmatched_api_requests': unmatched_api_requests,
        'debug_info': debug_info
    }

def print_summary(data: Dict[str, Any]) -> None:
    """Print a summary of the extracted data."""
    api_requests = data['api_requests']
    statsig_events = data['statsig_events']
    matched_requests = data['matched_requests']
    unmatched_api_requests = data['unmatched_api_requests']
    debug_info = data.get('debug_info', {})
    
    print(f"\n{'='*60}")
    print(f"CLAUDE CODE LOG ANALYSIS")
    print(f"{'='*60}")
    print(f"Total API requests: {len(api_requests)}")
    print(f"Total Statsig events: {len(statsig_events)}")
    print(f"Matched requests: {len(matched_requests)}")
    print(f"Unmatched API requests: {len(unmatched_api_requests)}")
    
    # Print debug info
    if debug_info:
        print(f"\nDEBUG INFO:")
        print(f"Statsig event types found: {debug_info.get('statsig_event_types', [])}")
        print(f"Sample API request IDs: {debug_info.get('sample_api_request_ids', [])}")
        print(f"Sample Statsig request IDs: {debug_info.get('sample_statsig_request_ids', [])}")
    
    if matched_requests:
        print(f"\n{'='*60}")
        print(f"MATCHED REQUESTS (with messages and metrics)")
        print(f"{'='*60}")
        
        for i, req in enumerate(matched_requests, 1):
            print(f"\n{'-'*50}")
            print(f"Request {i} - {req['timestamp']}")
            print(f"{'-'*50}")
            
            # Basic info
            print(f"Request ID: {req['request_id']}")
            print(f"Model: {req['model']}")
            print(f"Temperature: {req['temperature']}")
            print(f"Max Tokens: {req['max_tokens']}")
            print(f"Tools Available: {req['tools_available']}")
            print(f"Streaming: {req['streaming']}")
            
            # Performance metrics
            print(f"\nPerformance:")
            print(f"  Duration: {req.get('duration_ms', 'N/A')}ms")
            print(f"  TTFT: {req.get('ttft_ms', 'N/A')}ms")
            print(f"  Response Time: {req['response_time_ms']:.1f}ms" if req.get('response_time_ms') else "  Response Time: N/A")
            print(f"  Status: {req['response_status']}")
            
            # Token usage
            print(f"\nToken Usage:")
            print(f"  Input Tokens: {req['input_tokens']}")
            print(f"  Output Tokens: {req['output_tokens']}")
            print(f"  Cached Input Tokens: {req['cached_input_tokens']}")
            print(f"  Uncached Input Tokens: {req.get('uncached_input_tokens', 'N/A')}")
            print(f"  Cost: ${req.get('cost_usd', 0):.6f}")
            
            # Messages
            print(f"\nMessages:")
            print(f"  Message Count: {req['message_count']}")
            print(f"  System Prompt Length: {req['system_prompt_length']}")
            print(f"  User Message Length: {req['user_message_length']}")
            
            # System prompt (truncated)
            if req.get('system_prompt'):
                system_preview = req['system_prompt'][:200] + "..." if len(req['system_prompt']) > 200 else req['system_prompt']
                print(f"\nSystem Prompt (preview):")
                print(f"  {system_preview}")
            
            # Last user message (truncated)
            if req.get('last_user_message'):
                user_preview = req['last_user_message'][:300] + "..." if len(req['last_user_message']) > 300 else req['last_user_message']
                print(f"\nUser Message (preview):")
                print(f"  {user_preview}")
            
            # Assistant response (truncated)
            if req.get('assistant_message'):
                assistant_preview = req['assistant_message'][:300] + "..." if len(req['assistant_message']) > 300 else req['assistant_message']
                print(f"\nAssistant Response (preview):")
                print(f"  {assistant_preview}")
            
            # Additional metrics
            print(f"\nAdditional Info:")
            print(f"  Stop Reason: {req.get('stop_reason', 'N/A')}")
            print(f"  Provider: {req.get('provider', 'N/A')}")
            print(f"  Session ID: {req.get('session_id', 'N/A')}")
    
    if unmatched_api_requests:
        print(f"\n{'='*60}")
        print(f"UNMATCHED API REQUESTS")
        print(f"{'='*60}")
        
        for i, req in enumerate(unmatched_api_requests, 1):
            print(f"\nUnmatched Request {i}:")
            print(f"  Time: {req['timestamp']}")
            print(f"  Request ID: {req['request_id']}")
            print(f"  Model: {req['model']}")
            print(f"  Input Tokens: {req['input_tokens']}")
            print(f"  Output Tokens: {req['output_tokens']}")
            print(f"  Response Status: {req['response_status']}")
            
            # User message preview
            if req.get('last_user_message'):
                user_preview = req['last_user_message'][:200] + "..." if len(req['last_user_message']) > 200 else req['last_user_message']
                print(f"  User Message: {user_preview}")
    
    # Summary statistics
    if matched_requests:
        print(f"\n{'='*60}")
        print(f"SUMMARY STATISTICS")
        print(f"{'='*60}")
        
        total_input_tokens = sum(req.get('input_tokens', 0) for req in matched_requests)
        total_output_tokens = sum(req.get('output_tokens', 0) for req in matched_requests)
        total_cost = sum(req.get('cost_usd', 0) for req in matched_requests)
        avg_duration = sum(req.get('duration_ms', 0) for req in matched_requests) / len(matched_requests)
        avg_ttft = sum(req.get('ttft_ms', 0) for req in matched_requests) / len(matched_requests)
        
        print(f"Total Input Tokens: {total_input_tokens:,}")
        print(f"Total Output Tokens: {total_output_tokens:,}")
        print(f"Total Cost: ${total_cost:.6f}")
        print(f"Average Duration: {avg_duration:.1f}ms")
        print(f"Average TTFT: {avg_ttft:.1f}ms")
        
        models = [req['model'] for req in matched_requests]
        model_counts = {model: models.count(model) for model in set(models)}
        print(f"\nModel Usage:")
        for model, count in model_counts.items():
            print(f"  {model}: {count} requests")

def main():
    """Main function."""
    if len(sys.argv) != 2:
        print("Usage: python analyze_logs.py <log_file>")
        sys.exit(1)
    
    log_file = sys.argv[1]
    
    try:
        data = analyze_log_file(log_file)
        print_summary(data)
        
        # Save to CSV files
        if data['api_requests']:
            df_api = pd.DataFrame(data['api_requests'])
            df_api.to_csv('api_requests.csv', index=False)
            print(f"\nAPI requests saved to api_requests.csv")
        
        if data['statsig_events']:
            df_statsig = pd.DataFrame(data['statsig_events'])
            df_statsig.to_csv('statsig_events.csv', index=False)
            print(f"Statsig events saved to statsig_events.csv")
        
        if data['matched_requests']:
            df_matched = pd.DataFrame(data['matched_requests'])
            df_matched.to_csv('matched_requests.csv', index=False)
            print(f"Matched requests saved to matched_requests.csv")
        
        # Save analysis summary to JSON
        analysis_summary = {
            'total_api_requests': len(data['api_requests']),
            'total_statsig_events': len(data['statsig_events']),
            'matched_requests': len(data['matched_requests']),
            'unmatched_api_requests': len(data['unmatched_api_requests'])
        }
        
        if data['matched_requests']:
            analysis_summary.update({
                'total_input_tokens': sum(req.get('input_tokens', 0) for req in data['matched_requests']),
                'total_output_tokens': sum(req.get('output_tokens', 0) for req in data['matched_requests']),
                'total_cost': sum(req.get('cost_usd', 0) for req in data['matched_requests']),
                'avg_duration_ms': sum(req.get('duration_ms', 0) for req in data['matched_requests']) / len(data['matched_requests']),
                'avg_ttft_ms': sum(req.get('ttft_ms', 0) for req in data['matched_requests']) / len(data['matched_requests'])
            })
        
        with open('claude_api_analysis.json', 'w') as f:
            json.dump(analysis_summary, f, indent=2)
        print(f"Analysis summary saved to claude_api_analysis.json")
            
    except FileNotFoundError:
        print(f"Error: Log file '{log_file}' not found")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()