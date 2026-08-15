-- Migration 013: Add redaction path filtering columns to settings
-- Stores custom "only" and "skip" JSON path arrays for the redact plugin

ALTER TABLE settings ADD COLUMN redact_paths_only TEXT;
ALTER TABLE settings ADD COLUMN redact_paths_skip TEXT;

-- Update the default row with default values
UPDATE settings
SET
    redact_paths_only = '["messages[*].content"]',
    redact_paths_skip = '["tools","tool_calls","toolChoice","tool_choice","functions","function_call","messages[*].tool_calls[*].id","messages[*].tool_calls[*].function.name","messages[*].tool_calls[*].function.arguments","messages[*].tools[*].id","messages[*].tools[*].function.name","messages[*].tools[*].function.arguments","messages[*].function_call.id","messages[*].function_call.name","messages[*].function_call.arguments","tool_calls[*].id","tool_calls[*].function.name","tool_calls[*].function.arguments","tools[*].id","tools[*].function.name","tools[*].function.arguments","function_call.id","function_call.name","function_call.arguments","messages[*].content[*].id","messages[*].content[*].name","messages[*].content[*].input","messages[*].content[*].tool_use_id","messages[*].content[*].content","messages[*].content[*].thinking","messages[*].content[*].signature","messages[*].content[*].type","content[*].id","content[*].name","content[*].input","content[*].tool_use_id","content[*].content","content[*].thinking","content[*].signature","content[*].type"]'
WHERE id = 'default';