const express = require('express');
const { GoogleAuth } = require('google-auth-library');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Load environment variables from .env file if it exists
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index > 0) {
      const key = trimmed.slice(0, index).trim();
      const val = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
      process.env[key] = val;
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const SUPPORTED_PROJECTS = (process.env.SUPPORTED_PROJECTS || '')
  .split(',')
  .map(p => p.trim())
  .filter(Boolean);
let ACTIVE_PROJECT_ID = process.env.GCP_PROJECT_ID || SUPPORTED_PROJECTS[0];
const REGION = process.env.GCP_REGION || 'us-east5';
const DEFAULT_MODEL = 'claude-sonnet-4-5';

const AGENT_SYSTEM_PROMPT = `You are an expert coding assistant integrated inside the Antigravity IDE workspace client.
When the user asks you to write, edit, create or update files, use one of the two formats below.

## Editing Existing Files — use SEARCH/REPLACE blocks

To modify an existing file, output one or more SEARCH/REPLACE blocks inside an \`edit\` code fence:

\`\`\`edit:relative/path/to/file
<<<< SEARCH
exact lines to find in the original file
====
replacement lines
>>>> REPLACE
\`\`\`

You may include multiple SEARCH/REPLACE pairs in a single edit block for changes in the same file:

\`\`\`edit:public/app.js
<<<< SEARCH
const PORT = 3000;
====
const PORT = process.env.PORT || 3000;
>>>> REPLACE

<<<< SEARCH
app.listen(PORT);
====
app.listen(PORT, () => {
  console.log(\\\`Listening on port \\\${PORT}\\\`);
});
>>>> REPLACE
\`\`\`

## Creating New Files — use a create code fence

\`\`\`create:relative/path/to/newfile.js
// entire new file content here
\`\`\`

## Strict Rules
1. SEARCH blocks must EXACTLY match text in the existing file — preserve all whitespace, indentation, semicolons and line breaks precisely.
2. Include enough surrounding context in each SEARCH block (3–5 lines) to uniquely identify the location.
3. Only output the lines actually changing and their immediate context — do NOT reproduce the entire file.
4. Keep REPLACE blocks minimal — only the changed region plus context.
5. Use \`edit:\` fences for modifying existing files. Use \`create:\` fences for brand-new files.
6. Explain the changes briefly before or after the code blocks.
7. You can edit multiple files by outputting multiple edit/create blocks.
`;

const AGENT_TOOLS = [
  {
    name: 'list_files',
    description: 'List files and directories in the workspace. Returns names, types, and sizes. Use this to understand the project structure before reading specific files.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative directory path to list. Use "." for the workspace root.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the full contents of a file from the workspace. Use this to examine code before making changes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path to read (e.g. "public/app.js").' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for a text pattern across all files in the workspace. Returns matching file paths, line numbers, and line content. Use this to find relevant code, function definitions, imports, or usage patterns.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or substring to search for.' },
        file_pattern: { type: 'string', description: 'Optional glob-style extension filter (e.g. "*.js", "*.css"). Leave empty to search all files.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the workspace. For existing files, provide the complete updated file content. For new files, provide the full content. Changes will be staged for user review before being saved to disk.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path to write (e.g. "public/app.js").' },
        content: { type: 'string', description: 'The complete file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the workspace directory. Use this for installing dependencies, running tests, linting, building, or other CLI operations. Commands have a 30-second timeout.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute (e.g. "npm test", "node hello.js").' },
      },
      required: ['command'],
    },
  },
];

const AGENT_SYSTEM_PROMPT_V2 = `You are an expert coding agent integrated into the Vertex IDE workspace.
You have tools to explore, search, read, and modify files in the user's project.

Strategy for handling requests:
1. First understand the project structure using list_files
2. Read relevant files to understand the existing code using read_file
3. Search for specific patterns, function definitions, or usage with search_files
4. Make your changes using write_file — provide the COMPLETE updated file content
5. Optionally verify your changes by running tests or commands with run_command

Important rules:
- Always read a file before modifying it so you have the full current content
- When using write_file, always include the COMPLETE file content (not just the changed parts)
- Explain your reasoning and what you're changing before making edits
- Make minimal, focused changes — don't rewrite entire files unnecessarily
- If you're unsure about something, search the codebase first rather than guessing
`;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Uses Application Default Credentials (ADC) via google-auth-library.
 * This avoids CBA restrictions that affect `gcloud auth print-access-token`.
 *
 * ADC is set up via: `gcloud auth application-default login`
 */
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function getAccessToken() {
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token;
}

/**
 * POST /api/chat
 * Proxies chat requests to the Vertex AI Anthropic Claude endpoint.
 *
 * Request body:
 * {
 *   "messages": [{ "role": "user"|"assistant", "content": "..." }],
 *   "model": "claude-sonnet-4-6" (optional),
 *   "system": "system prompt" (optional),
 *   "max_tokens": 4096 (optional),
 *   "stream": false (optional)
 * }
 */
app.post('/api/chat', async (req, res) => {
  try {
    const {
      messages,
      model = DEFAULT_MODEL,
      system,
      max_tokens = 8192,
      stream = false,
    } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const accessToken = await getAccessToken();

    // Vertex AI Anthropic endpoint format:
    // https://{REGION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{REGION}/publishers/anthropic/models/{MODEL}:streamRawPredict
    const endpoint = stream ? 'streamRawPredict' : 'rawPredict';
    const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${ACTIVE_PROJECT_ID}/locations/${REGION}/publishers/anthropic/models/${model}:${endpoint}`;

    // Build the Anthropic-format request body for Vertex AI
    const requestBody = {
      anthropic_version: 'vertex-2023-10-16',
      max_tokens,
      messages,
    };

    const finalSystem = system ? `${AGENT_SYSTEM_PROMPT}\n\nAdditional user instructions:\n${system}` : AGENT_SYSTEM_PROMPT;
    requestBody.system = finalSystem;

    console.log(`[API] Calling ${model} via Vertex AI (${REGION})...`);

    if (stream) {
      // Streaming response
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[API] Vertex AI Error (${response.status}):`, errorText);
        return res.status(response.status).json({
          error: `Vertex AI returned ${response.status}`,
          details: errorText,
        });
      }

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);
        }
      } finally {
        res.end();
      }
    } else {
      // Non-streaming response
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[API] Vertex AI Error (${response.status}):`, errorText);
        return res.status(response.status).json({
          error: `Vertex AI returned ${response.status}`,
          details: errorText,
        });
      }

      const data = await response.json();
      res.json(data);
    }
  } catch (err) {
    console.error('[API] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/chat/stream
 * Streaming variant - always uses SSE streaming.
 */
function getWorkspaceContext(dir) {
  let context = '';
  const list = fs.readdirSync(dir);
  for (const item of list) {
    if (item === 'node_modules' || item === '.git' || item === 'package-lock.json' || item === '.DS_Store' || item.endsWith('.png') || item.endsWith('.webp') || item.endsWith('.ico')) continue;
    const fullPath = path.join(dir, item);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      context += getWorkspaceContext(fullPath);
    } else if (stat.size < 1000000) { // skip very large files
      const relativePath = path.relative(__dirname, fullPath);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        context += `\n--- BEGIN FILE: ${relativePath} ---\n${content}\n--- END FILE: ${relativePath} ---\n`;
      } catch (e) {
        // ignore unreadable files
      }
    }
  }
  return context;
}

app.post('/api/chat/stream', async (req, res) => {
  try {
    const {
      messages,
      model = DEFAULT_MODEL,
      system,
      max_tokens = 8192,
    } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const accessToken = await getAccessToken();

    const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${ACTIVE_PROJECT_ID}/locations/${REGION}/publishers/anthropic/models/${model}:streamRawPredict`;

    const requestBody = {
      anthropic_version: 'vertex-2023-10-16',
      max_tokens,
      messages,
      stream: true,
    };

    const workspaceContent = getWorkspaceContext(__dirname);
    const finalSystem = system 
      ? `${AGENT_SYSTEM_PROMPT}\n\nThe user's full codebase is provided below:\n${workspaceContent}\n\nAdditional user instructions:\n${system}` 
      : `${AGENT_SYSTEM_PROMPT}\n\nThe user's full codebase is provided below:\n${workspaceContent}`;
    requestBody.system = finalSystem;

    console.log(`[API] Streaming ${model} via Vertex AI (${REGION})...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[API] Vertex AI Error (${response.status}):`, errorText);
      return res.status(response.status).json({
        error: `Vertex AI returned ${response.status}`,
        details: errorText,
      });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
    } finally {
      res.end();
    }
  } catch (err) {
    console.error('[API] Stream Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

/**
 * GET /api/models
 * Returns all Claude models. Available models (probed at startup) are listed
 * first; unavailable ones are included but marked so the UI can indicate them.
 */
const ALL_MODELS = [
  // Gemini models (Google)
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', tier: 'fast', provider: 'google' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', tier: 'high', provider: 'google' },
  // Claude models (Anthropic)
  { id: 'claude-fable-5', name: 'Claude Fable 5', tier: 'flagship', provider: 'anthropic' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'high', provider: 'anthropic' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', tier: 'high', provider: 'anthropic' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'balanced', provider: 'anthropic' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'high', provider: 'anthropic' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', tier: 'balanced', provider: 'anthropic' },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', tier: 'high', provider: 'anthropic' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', tier: 'fast', provider: 'anthropic' },
  { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', tier: 'high', provider: 'anthropic' },
  { id: 'claude-opus-4', name: 'Claude Opus 4', tier: 'high', provider: 'anthropic' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', tier: 'balanced', provider: 'anthropic' },
  { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku', tier: 'fast', provider: 'anthropic' },
];

/**
 * Get the provider for a model ID.
 */
function getModelProvider(modelId) {
  const model = ALL_MODELS.find(m => m.id === modelId);
  return model?.provider || 'anthropic';
}

/**
 * Convert Anthropic-style tool definitions to Gemini function declarations.
 */
function convertToolsToGemini(tools) {
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    })),
  }];
}

/**
 * Convert Anthropic-style messages to Gemini contents format.
 */
function convertMessagesToGemini(messages, systemPrompt) {
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // User messages can be a string or an array of tool_result blocks
      if (typeof msg.content === 'string') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        // Tool results from the agentic loop
        const parts = msg.content.map(block => {
          if (block.type === 'tool_result') {
            return {
              functionResponse: {
                name: block.tool_use_id.split('_').pop() || 'unknown',
                response: { content: block.content },
              },
            };
          }
          return { text: typeof block === 'string' ? block : JSON.stringify(block) };
        });
        contents.push({ role: 'user', parts });
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        contents.push({ role: 'model', parts: [{ text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        // Assistant content blocks (text + tool_use)
        const parts = msg.content.map(block => {
          if (block.type === 'text') {
            return { text: block.text };
          } else if (block.type === 'tool_use') {
            return {
              functionCall: {
                name: block.name,
                args: block.input,
              },
            };
          }
          return { text: JSON.stringify(block) };
        });
        contents.push({ role: 'model', parts });
      }
    }
  }

  return contents;
}

/**
 * Convert a Gemini generateContent response to Anthropic-compatible format.
 */
function convertGeminiResponse(geminiResult) {
  const candidate = geminiResult.candidates?.[0];
  if (!candidate) {
    return { content: [{ type: 'text', text: 'No response generated.' }], stop_reason: 'end_turn' };
  }

  const contentBlocks = [];
  let hasToolCalls = false;

  for (const part of candidate.content?.parts || []) {
    if (part.text) {
      contentBlocks.push({ type: 'text', text: part.text });
    } else if (part.functionCall) {
      hasToolCalls = true;
      contentBlocks.push({
        type: 'tool_use',
        id: `toolu_gemini_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${part.functionCall.name}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  }

  // Map Gemini finish reason to Anthropic stop_reason
  let stopReason = 'end_turn';
  if (candidate.finishReason === 'STOP') stopReason = 'end_turn';
  else if (hasToolCalls) stopReason = 'tool_use';

  return { content: contentBlocks, stop_reason: stopReason };
}

/**
 * Convert Gemini tool results back to Gemini format for the next turn.
 * This replaces the tool_use_id-based matching with name-based matching.
 */
function convertToolResultsToGemini(toolResults, toolCalls) {
  return toolResults.map((result, i) => {
    const matchingCall = toolCalls.find(tc => tc.id === result.tool_use_id);
    return {
      functionResponse: {
        name: matchingCall?.name || 'unknown',
        response: { content: result.content },
      },
    };
  });
}

// Each entry gains an `available` boolean after probing
let probedModels = ALL_MODELS.map((m) => ({ ...m, available: true }));

async function probeModels() {
  console.log('[Probe] Checking which models are available...');
  const token = await getAccessToken();

  const results = await Promise.all(
    ALL_MODELS.map(async (model) => {
      let url, body;
      if (model.provider === 'google') {
        url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${ACTIVE_PROJECT_ID}/locations/${REGION}/publishers/google/models/${model.id}:generateContent`;
        body = JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        });
      } else {
        url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${ACTIVE_PROJECT_ID}/locations/${REGION}/publishers/anthropic/models/${model.id}:rawPredict`;
        body = JSON.stringify({
          anthropic_version: 'vertex-2023-10-16',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        });
      }
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body,
        });
        const available = response.status !== 404;
        console.log(`  ${available ? '✅' : '❌'} ${model.name} (${model.provider})`);
        return { ...model, available };
      } catch {
        console.log(`  ⚠️  ${model.name} — error probing`);
        return { ...model, available: false };
      }
    })
  );

  // Sort: available first, then unavailable
  probedModels = [
    ...results.filter((m) => m.available),
    ...results.filter((m) => !m.available),
  ];

  const count = results.filter((m) => m.available).length;
  console.log(`[Probe] ${count} of ${ALL_MODELS.length} model(s) available.\n`);
}

/**
 * GET /api/project
 * Returns the currently active project and the list of supported projects.
 */
app.get('/api/project', (req, res) => {
  res.json({
    activeProject: ACTIVE_PROJECT_ID,
    projects: SUPPORTED_PROJECTS,
  });
});

/**
 * POST /api/project
 * Sets the active GCP project ID and triggers a model probe.
 */
app.post('/api/project', async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }
  if (!SUPPORTED_PROJECTS.includes(projectId)) {
    return res.status(400).json({ error: `Unsupported project. Allowed projects: ${SUPPORTED_PROJECTS.join(', ')}` });
  }

  ACTIVE_PROJECT_ID = projectId;
  console.log(`[API] Switched active GCP project to: ${ACTIVE_PROJECT_ID}`);

  try {
    // Re-probe models for the new project
    await probeModels();
    res.json({
      status: 'ok',
      activeProject: ACTIVE_PROJECT_ID,
      models: probedModels,
    });
  } catch (err) {
    console.error(`[API] Failed to probe models after project switch:`, err.message);
    res.status(500).json({ error: `Switched project, but probing models failed: ${err.message}` });
  }
});

app.get('/api/models', (req, res) => {
  res.json({
    models: probedModels,
    default: DEFAULT_MODEL,
    project: ACTIVE_PROJECT_ID,
    region: REGION,
  });
});

/**
 * GET /api/health
 * Health check endpoint.
 */
app.get('/api/health', async (req, res) => {
  try {
    await getAccessToken();
    res.json({ status: 'ok', project: ACTIVE_PROJECT_ID, region: REGION });
  } catch {
    res.status(503).json({ status: 'error', message: 'Cannot get access token' });
  }
});

/**
 * GET /api/files
 * Returns a JSON tree of files and directories in the workspace.
 * Excludes node_modules, .git, and package-lock.json.
 */
app.get('/api/files', (req, res) => {
  const rootPath = path.resolve(__dirname);
  
  function walkDir(dir) {
    const list = fs.readdirSync(dir);
    const files = [];
    const dirs = [];
    
    list.forEach((item) => {
      const fullPath = path.join(dir, item);
      const relativePath = path.relative(rootPath, fullPath);
      const stat = fs.statSync(fullPath);
      
      // Exclude common files/folders
      if (item === 'node_modules' || item === '.git' || item === 'package-lock.json' || item === '.DS_Store') {
        return;
      }
      
      if (stat.isDirectory()) {
        dirs.push({
          name: item,
          path: relativePath,
          type: 'directory',
          children: walkDir(fullPath),
        });
      } else {
        files.push({
          name: item,
          path: relativePath,
          type: 'file',
          size: stat.size,
        });
      }
    });
    
    // Sort directories first, then files alphabetically
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  try {
    const fileTree = walkDir(rootPath);
    res.json(fileTree);
  } catch (err) {
    console.error('[API] Error listing workspace files:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/file
 * Query param: path (relative path from workspace root)
 * Returns file contents.
 */
app.get('/api/file', (req, res) => {
  const relPath = req.query.path;
  if (!relPath) {
    return res.status(400).json({ error: 'path query parameter is required' });
  }
  
  const rootPath = path.resolve(__dirname);
  const targetPath = path.resolve(rootPath, relPath);
  
  // Security check: ensure target path is within workspace root
  if (!targetPath.startsWith(rootPath)) {
    return res.status(403).json({ error: 'Forbidden: Access outside workspace is not allowed' });
  }
  
  try {
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Requested path is a directory, not a file' });
    }
    
    const content = fs.readFileSync(targetPath, 'utf-8');
    res.json({
      path: relPath,
      name: path.basename(targetPath),
      content,
    });
  } catch (err) {
    console.error(`[API] Error reading file "${relPath}":`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/save-file
 * Body: { path: relativePath, content: fileContent }
 * Writes/Saves file content to disk with proper sync and error handling.
 */
app.post('/api/save-file', (req, res) => {
  const { path: relPath, content } = req.body;
  if (!relPath || content === undefined) {
    return res.status(400).json({ error: 'path and content parameters are required' });
  }

  const rootPath = path.resolve(__dirname);
  const targetPath = path.resolve(rootPath, relPath);

  // Security check: ensure target path is within workspace root
  if (!targetPath.startsWith(rootPath)) {
    return res.status(403).json({ error: 'Forbidden: Access outside workspace is not allowed' });
  }

  try {
    // Ensure parent directory exists
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Write the file synchronously to ensure it's flushed to disk
    fs.writeFileSync(targetPath, content, 'utf-8');
    
    // Verify the file was written correctly by reading it back
    const verification = fs.readFileSync(targetPath, 'utf-8');
    if (verification !== content) {
      throw new Error('File verification failed - content mismatch');
    }
    
    console.log(`[API] File saved and verified: ${relPath} (${content.length} bytes)`);
    res.json({ 
      status: 'ok', 
      path: relPath,
      size: content.length 
    });
  } catch (err) {
    console.error(`[API] Error saving file "${relPath}":`, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Search files recursively for a text pattern.
 */
function searchFilesRecursive(dir, query, filePattern, rootPath, results, maxResults) {
  if (results.length >= maxResults) return;

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return;

    // Skip common non-code directories and files
    if (entry === 'node_modules' || entry === '.git' || entry === 'package-lock.json' || entry === '.DS_Store') continue;

    const fullPath = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      searchFilesRecursive(fullPath, query, filePattern, rootPath, results, maxResults);
    } else {
      // Skip binary files
      if (/\.(png|webp|ico|jpg|jpeg|gif|bmp|svg|woff|woff2|ttf|eot|mp3|mp4|zip|tar|gz)$/i.test(entry)) continue;

      // Apply file pattern filter if provided
      if (filePattern) {
        const ext = filePattern.replace('*', '');
        if (!entry.endsWith(ext)) continue;
      }

      // Skip large files (> 1MB)
      if (stat.size > 1000000) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        const relativePath = path.relative(rootPath, fullPath);

        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) return;
          if (lines[i].includes(query)) {
            results.push({
              path: relativePath,
              line: i + 1,
              content: lines[i].trim().substring(0, 200),
            });
          }
        }
      } catch {
        // ignore unreadable files
      }
    }
  }
}

/**
 * Execute a tool call and return the result string.
 */
async function executeTool(name, input, rootPath) {
  switch (name) {
    case 'list_files': {
      const targetDir = path.resolve(rootPath, input.path);
      if (!targetDir.startsWith(rootPath)) {
        return 'Error: Access outside workspace is not allowed.';
      }
      try {
        const entries = fs.readdirSync(targetDir);
        const result = [];
        for (const entry of entries) {
          if (entry === 'node_modules' || entry === '.git' || entry === 'package-lock.json' || entry === '.DS_Store') continue;
          const fullPath = path.join(targetDir, entry);
          try {
            const stat = fs.statSync(fullPath);
            result.push({
              name: entry,
              type: stat.isDirectory() ? 'directory' : 'file',
              size: stat.isFile() ? stat.size : undefined,
            });
          } catch {
            // skip inaccessible entries
          }
        }
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return `Error listing directory: ${err.message}`;
      }
    }

    case 'read_file': {
      const filePath = path.resolve(rootPath, input.path);
      if (!filePath.startsWith(rootPath)) {
        return 'Error: Access outside workspace is not allowed.';
      }
      try {
        if (!fs.existsSync(filePath)) {
          return `Error: File not found: ${input.path}`;
        }
        return fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        return `Error reading file: ${err.message}`;
      }
    }

    case 'search_files': {
      const results = [];
      searchFilesRecursive(rootPath, input.query, input.file_pattern || '', rootPath, results, 50);
      if (results.length === 0) {
        return `No matches found for "${input.query}".`;
      }
      return results.map(r => `${r.path}:${r.line}: ${r.content}`).join('\n');
    }

    case 'write_file': {
      const filePath = path.resolve(rootPath, input.path);
      if (!filePath.startsWith(rootPath)) {
        return 'Error: Access outside workspace is not allowed.';
      }
      try {
        // Ensure parent directory exists
        const parentDir = path.dirname(filePath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        // Write the file to disk
        fs.writeFileSync(filePath, input.content, 'utf-8');
        console.log(`[Agent Tool] File written: ${input.path} (${input.content.length} bytes)`);

        return `Successfully wrote ${input.content.length} bytes to ${input.path}`;
      } catch (err) {
        console.error(`[Agent Tool] Error writing file "${input.path}":`, err);
        return `Error writing file: ${err.message}`;
      }
    }

    case 'run_command': {
      const cmd = input.command;
      // Security: block dangerous commands
      if (cmd.includes('rm -rf /') || cmd.includes('sudo') || cmd.includes('..')) {
        return 'Error: Command blocked for security reasons.';
      }
      try {
        const stdout = execSync(cmd, {
          cwd: rootPath,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          encoding: 'utf8',
        });
        return stdout || '(command completed with no output)';
      } catch (err) {
        return `Command failed (exit code ${err.status || 'unknown'}):\n${err.stderr || err.message}`;
      }
    }

    default:
      return `Error: Unknown tool "${name}".`;
  }
}

// =============================================================================
// Agent & Conversation Persistence (file-backed)
// =============================================================================

const AGENTS_DIR = path.join(__dirname, '.agents');

/** Ensure the .agents directory exists */
function ensureAgentsDir() {
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }
}

/** Read the agents index file */
function readAgentsIndex() {
  ensureAgentsDir();
  const indexPath = path.join(AGENTS_DIR, 'index.json');
  if (fs.existsSync(indexPath)) {
    return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  }
  return [];
}

/** Write the agents index file */
function writeAgentsIndex(agents) {
  ensureAgentsDir();
  const indexPath = path.join(AGENTS_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(agents, null, 2), 'utf-8');
}

/** Convert a conversation to markdown format */
function conversationToMarkdown(conv) {
  let md = `# ${conv.title || 'Untitled Chat'}\n\n`;
  md += `> Agent: ${conv.agentId} | Created: ${new Date(conv.createdAt).toISOString()}\n\n---\n\n`;
  
  for (const msg of conv.messages || []) {
    const role = msg.role === 'user' ? '👤 **User**' : '🤖 **Assistant**';
    md += `## ${role}\n\n${msg.content}\n\n---\n\n`;
  }
  return md;
}

/** Parse a conversation from its JSON sidecar */
function readConversation(agentId, convId) {
  const convDir = path.join(AGENTS_DIR, agentId);
  const jsonPath = path.join(convDir, `${convId}.json`);
  if (fs.existsSync(jsonPath)) {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  }
  return null;
}

/** Save a conversation as both JSON (for loading) and Markdown (for reading) */
function writeConversation(agentId, conv) {
  ensureAgentsDir();
  const convDir = path.join(AGENTS_DIR, agentId);
  if (!fs.existsSync(convDir)) {
    fs.mkdirSync(convDir, { recursive: true });
  }
  // JSON for programmatic loading
  fs.writeFileSync(path.join(convDir, `${conv.id}.json`), JSON.stringify(conv, null, 2), 'utf-8');
  // Markdown for human reading
  fs.writeFileSync(path.join(convDir, `${conv.id}.md`), conversationToMarkdown(conv), 'utf-8');
}

/** GET /api/agents — load all agents and their conversations */
app.get('/api/agents', (req, res) => {
  try {
    const agents = readAgentsIndex();
    const conversations = [];
    
    for (const agent of agents) {
      const agentDir = path.join(AGENTS_DIR, agent.id);
      if (fs.existsSync(agentDir)) {
        const files = fs.readdirSync(agentDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const conv = JSON.parse(fs.readFileSync(path.join(agentDir, file), 'utf-8'));
            conversations.push(conv);
          } catch (e) { /* skip corrupt files */ }
        }
      }
    }
    
    res.json({ agents, conversations });
  } catch (err) {
    console.error('Error loading agents:', err);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agents — save agents index and all conversations */
app.post('/api/agents', (req, res) => {
  try {
    const { agents, conversations } = req.body;
    
    if (!agents || !Array.isArray(agents)) {
      return res.status(400).json({ error: 'agents array is required' });
    }
    
    writeAgentsIndex(agents);
    
    if (conversations && Array.isArray(conversations)) {
      for (const conv of conversations) {
        if (conv.agentId && conv.id) {
          writeConversation(conv.agentId, conv);
        }
      }
    }
    
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving agents:', err);
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/agents/conversation — save a single conversation (used during streaming) */
app.post('/api/agents/conversation', (req, res) => {
  try {
    const conv = req.body;
    if (!conv.agentId || !conv.id) {
      return res.status(400).json({ error: 'agentId and id are required' });
    }
    writeConversation(conv.agentId, conv);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving conversation:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agent/run
 * Runs an agentic loop with tool use via SSE.
 */
app.post('/api/agent/run', async (req, res) => {
  try {
    const {
      messages,
      model = DEFAULT_MODEL,
      system,
      max_tokens = 8192,
    } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const rootPath = path.resolve(__dirname);
    const accessToken = await getAccessToken();
    const MAX_ITERATIONS = 25;

    // Build the system prompt
    const finalSystem = system
      ? `${AGENT_SYSTEM_PROMPT_V2}\n\n${system}`
      : AGENT_SYSTEM_PROMPT_V2;

    // Working copy of messages for the agentic loop
    const workingMessages = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    // Helper to send SSE events to the client
    function sendEvent(event) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    sendEvent({ type: 'status', content: 'Agent is starting...' });

    const provider = getModelProvider(model);
    console.log(`[Agent] Using provider: ${provider} for model: ${model}`);

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      console.log(`[Agent] Iteration ${iteration + 1}/${MAX_ITERATIONS}`);

      let url, requestBody;

      if (provider === 'google') {
        // Gemini via Vertex AI generateContent
        url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${ACTIVE_PROJECT_ID}/locations/${REGION}/publishers/google/models/${model}:generateContent`;
        requestBody = {
          contents: convertMessagesToGemini(workingMessages, finalSystem),
          systemInstruction: { parts: [{ text: finalSystem }] },
          tools: convertToolsToGemini(AGENT_TOOLS),
          generationConfig: { maxOutputTokens: max_tokens },
        };
      } else {
        // Claude via Vertex AI rawPredict (Anthropic format)
        url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${ACTIVE_PROJECT_ID}/locations/${REGION}/publishers/anthropic/models/${model}:rawPredict`;
        requestBody = {
          anthropic_version: 'vertex-2023-10-16',
          max_tokens,
          system: finalSystem,
          tools: AGENT_TOOLS,
          messages: workingMessages,
          thinking: {
            type: 'enabled',
            budget_tokens: 4096,
          },
        };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Agent] Vertex AI Error (${response.status}):`, errorText);
        sendEvent({ type: 'error', message: `Vertex AI returned ${response.status}: ${errorText}` });
        break;
      }

      // Normalize response to Anthropic format
      const rawResult = await response.json();
      const result = provider === 'google' ? convertGeminiResponse(rawResult) : rawResult;
      const contentBlocks = result.content || [];
      const stopReason = result.stop_reason;

      // Process each content block
      const toolUseBlocks = [];

      for (const block of contentBlocks) {
        if (block.type === 'thinking') {
          sendEvent({ type: 'thinking', content: block.thinking });
        } else if (block.type === 'text') {
          sendEvent({ type: 'text', content: block.text });
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block);
          sendEvent({
            type: 'tool_call',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }

      // If no tool calls, we're done
      if (toolUseBlocks.length === 0) {
        sendEvent({ type: 'done' });
        break;
      }

      // If stop_reason is 'end_turn' even with tool calls, still break
      if (stopReason !== 'tool_use') {
        sendEvent({ type: 'done' });
        break;
      }

      // Add assistant message to working messages
      if (provider === 'google') {
        // For Gemini, store in its native format for next turn
        const geminiParts = contentBlocks.map(block => {
          if (block.type === 'text') return { text: block.text };
          if (block.type === 'tool_use') return { functionCall: { name: block.name, args: block.input } };
          return { text: JSON.stringify(block) };
        });
        workingMessages.push({ role: 'assistant', content: contentBlocks }); // keep Anthropic format for our loop
      } else {
        workingMessages.push({ role: 'assistant', content: contentBlocks });
      }

      // Execute each tool and collect results
      const toolResults = [];
      for (const toolCall of toolUseBlocks) {
        console.log(`[Agent] Executing tool: ${toolCall.name}`, JSON.stringify(toolCall.input).substring(0, 200));

        // For write_file, read original content BEFORE execution (for diffing)
        let preWriteContent = null;
        if (toolCall.name === 'write_file') {
          try {
            const filePath = path.resolve(rootPath, toolCall.input.path);
            if (fs.existsSync(filePath)) {
              preWriteContent = fs.readFileSync(filePath, 'utf-8');
            }
          } catch (e) { /* ignore */ }
        }

        const toolOutput = await executeTool(toolCall.name, toolCall.input, rootPath);

        // For write_file, send a file_change event with the pre-write original
        if (toolCall.name === 'write_file') {
          sendEvent({
            type: 'file_change',
            path: toolCall.input.path,
            content: toolCall.input.content,
            originalContent: preWriteContent || '',
            action: preWriteContent !== null ? 'edit' : 'create',
          });
        }

        sendEvent({
          type: 'tool_result',
          id: toolCall.id,
          name: toolCall.name,
          output: typeof toolOutput === 'string' ? toolOutput.substring(0, 500) : JSON.stringify(toolOutput).substring(0, 500),
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput),
        });
      }

      // Add tool results as a user message
      if (provider === 'google') {
        // Gemini expects functionResponse parts
        const geminiToolResults = convertToolResultsToGemini(toolResults, toolUseBlocks);
        workingMessages.push({ role: 'user', content: toolResults }); // keep Anthropic format
      } else {
        workingMessages.push({ role: 'user', content: toolResults });
      }
    }

    res.end();
  } catch (err) {
    console.error('[Agent] Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      } catch (e) { /* ignore */ }
      res.end();
    }
  }
});

// Serve the SPA for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`\n🚀 Vertex Claude Chat Server running at http://localhost:${PORT}`);
  console.log(`   Project: ${ACTIVE_PROJECT_ID}`);
  console.log(`   Region:  ${REGION}`);
  console.log(`   Model:   ${DEFAULT_MODEL}\n`);

  // Probe which models are accessible in this project
  try {
    await probeModels();
  } catch (err) {
    console.error('[Probe] Failed to probe models:', err.message);
  }
});
