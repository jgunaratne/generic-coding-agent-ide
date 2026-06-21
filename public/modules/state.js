/**
 * state.js — Singleton application state with dual persistence.
 *
 * Agent/conversation data is persisted to server-side .md/.json files.
 * UI state (tabs, model selection, etc.) is persisted to localStorage.
 *
 * Every module imports this same object. Mutations happen in-place;
 * call save() to persist and load() to hydrate.
 */

import { fetchAgents, saveAgents, saveConversation } from './api.js';

const STORAGE_KEY = 'vertex-ui-state';

const state = {
  // Agent & conversation model
  agents: [],
  activeAgentId: null,
  conversations: [],
  activeConversationId: null,

  // Model / project config
  models: [],
  selectedModel: 'claude-sonnet-4-5',
  activeProject: 'gdm-inception',

  // Workspace file explorer
  fileTree: [],
  openDirectories: {},

  // Multi-tab editor
  openTabs: [],
  activeFilePath: null,
  fileContents: {},

  // Coding agent pending modifications
  pendingChanges: {},
};

// Debounce timer for server saves
let _serverSaveTimer = null;

/**
 * Persist state. UI state goes to localStorage immediately.
 * Agent/conversation data is debounced and saved to the server.
 */
export function save() {
  // 1. Save UI state to localStorage (fast, synchronous)
  try {
    const uiState = {
      activeAgentId: state.activeAgentId,
      activeConversationId: state.activeConversationId,
      selectedModel: state.selectedModel,
      activeProject: state.activeProject,
      openDirectories: state.openDirectories,
      openTabs: state.openTabs,
      activeFilePath: state.activeFilePath,
      pendingChanges: state.pendingChanges,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(uiState));
  } catch {
    // Quota exceeded or private mode
  }

  // 2. Debounce server save for agents/conversations (500ms)
  if (_serverSaveTimer) clearTimeout(_serverSaveTimer);
  _serverSaveTimer = setTimeout(() => {
    persistToServer().catch((err) => console.warn('Server save failed:', err));
  }, 500);
}

/** Save agents + conversations to the server. */
async function persistToServer() {
  const cleanConvs = state.conversations.map((c) => ({
    id: c.id,
    agentId: c.agentId,
    title: c.title,
    messages: c.messages,
    createdAt: c.createdAt,
  }));
  await saveAgents(state.agents, cleanConvs);
}

/**
 * Explicitly save a single conversation to the server immediately.
 * Used after finalizing an agent message so the .md file is up to date.
 */
export async function persistConversation(conv) {
  try {
    await saveConversation({
      id: conv.id,
      agentId: conv.agentId,
      title: conv.title,
      messages: conv.messages,
      createdAt: conv.createdAt,
    });
  } catch (err) {
    console.warn('Failed to persist conversation:', err);
  }
}

/**
 * Load state from both localStorage (UI) and server (agents/conversations).
 */
export async function load() {
  // 1. Load UI state from localStorage
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      state.selectedModel = data.selectedModel || 'claude-sonnet-4-5';
      state.activeProject = data.activeProject || 'gdm-inception';
      state.openDirectories = data.openDirectories || {};
      state.openTabs = data.openTabs || [];
      state.activeFilePath = data.activeFilePath || null;
      state.pendingChanges = data.pendingChanges || {};
      state.activeAgentId = data.activeAgentId || null;
      state.activeConversationId = data.activeConversationId || null;
    }
  } catch {
    // Corrupt localStorage — use defaults
  }

  // 2. Load agents + conversations from server
  try {
    const serverData = await fetchAgents();
    state.agents = serverData.agents || [];
    state.conversations = (serverData.conversations || []).map((c) => ({
      ...c,
      isStreaming: false,
      streamingActivity: [],
      streamingText: '',
    }));

    // Validate active IDs still exist
    if (state.activeAgentId && !state.agents.find((a) => a.id === state.activeAgentId)) {
      state.activeAgentId = state.agents[0]?.id || null;
    }
    if (state.activeConversationId && !state.conversations.find((c) => c.id === state.activeConversationId)) {
      const agentConvs = state.conversations.filter((c) => c.agentId === state.activeAgentId);
      state.activeConversationId = agentConvs[0]?.id || null;
    }
  } catch (err) {
    console.warn('Could not load agents from server, using empty state:', err);
  }
}

/** Return the currently selected conversation object, or null. */
export function getActiveConversation() {
  return state.conversations.find((c) => c.id === state.activeConversationId) || null;
}

export default state;
