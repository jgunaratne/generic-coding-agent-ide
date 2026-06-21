/**
 * api.js — Thin HTTP client for all server endpoints.
 *
 * Returns clean data; throws on HTTP errors.
 * Only imports `state` for reading the selected model / project.
 */

import state from './state.js';

/** GET /api/health */
export async function fetchHealth() {
  const response = await fetch('/api/health');
  return response.json();
}

/** GET /api/models */
export async function fetchModels() {
  const response = await fetch('/api/models');
  if (!response.ok) throw new Error('Failed to load models');
  return response.json();
}

/** GET /api/project */
export async function fetchProjectConfig() {
  const response = await fetch('/api/project');
  if (!response.ok) throw new Error('Failed to load project config');
  return response.json();
}

/** POST /api/project — switch active GCP project */
export async function switchProject(projectId) {
  const response = await fetch('/api/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  if (!response.ok) throw new Error('Switch request failed');
}

/** GET /api/files — load workspace file tree */
export async function fetchWorkspaceFiles() {
  const response = await fetch('/api/files');
  if (!response.ok) throw new Error('Failed to load files');
  return response.json();
}

/** GET /api/file?path=... — read a single file */
export async function fetchFile(path) {
  const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error('Could not read file from workspace');
  const data = await response.json();
  return data.content;
}

/** POST /api/file — save file content to disk */
export async function saveFileToDisk(path, content) {
  const response = await fetch('/api/file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to save file');
  }
  return response.json();
}

/**
 * POST /api/agent/run — start an agent streaming session.
 * Returns the raw Response object so the caller can read the SSE stream.
 */
export async function runAgentStream(messages) {
  const response = await fetch('/api/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      model: state.selectedModel,
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.details || errData.error || `HTTP ${response.status}`);
  }

  return response;
}

// ── Agent Persistence ───────────────────────────────────────────────────────

/** GET /api/agents — load all agents and conversations from disk */
export async function fetchAgents() {
  const response = await fetch('/api/agents');
  if (!response.ok) throw new Error('Failed to load agents');
  return response.json();
}

/** POST /api/agents — save agents index + all conversations to disk */
export async function saveAgents(agents, conversations) {
  const response = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents, conversations }),
  });
  if (!response.ok) throw new Error('Failed to save agents');
}

/** POST /api/agents/conversation — save a single conversation to disk */
export async function saveConversation(conv) {
  const response = await fetch('/api/agents/conversation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(conv),
  });
  if (!response.ok) throw new Error('Failed to save conversation');
}
