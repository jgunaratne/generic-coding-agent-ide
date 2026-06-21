/**
 * dom.js — Cached DOM element references.
 *
 * Queried once at import time. Every module that needs DOM access
 * imports this object instead of calling getElementById directly.
 */

const dom = {
  // Explorer sidebar
  fileTree: document.getElementById('file-tree'),
  projectSelect: document.getElementById('project-select'),
  modelSelect: document.getElementById('model-select'),
  connectionStatus: document.getElementById('connection-status'),

  // Editor panel & tabs
  tabBar: document.getElementById('tab-bar'),
  codeContainer: document.getElementById('code-container'),
  codeEmptyState: document.getElementById('code-empty-state'),
  codeEditor: document.getElementById('code-editor'),
  lineNumbers: document.getElementById('line-numbers'),
  codeContent: document.getElementById('code-display-content'),

  // Editor floating review bar
  editorReviewBar: document.getElementById('editor-review-bar'),
  reviewFileInfo: document.getElementById('review-file-info'),
  acceptChangesBtn: document.getElementById('accept-changes-btn'),
  rejectChangesBtn: document.getElementById('reject-changes-btn'),

  // Sidebar views
  sidebarExplorer: document.getElementById('sidebar-explorer'),
  sidebarAgents: document.getElementById('sidebar-agents'),
  agentsList: document.getElementById('agents-list'),
  newAgentBtn: document.getElementById('new-agent-btn'),

  // Chat panel
  conversationSelect: document.getElementById('conversation-select'),
  newChatBtn: document.getElementById('new-chat-btn'),
  emptyState: document.getElementById('empty-state'),
  chatMessages: document.getElementById('chat-messages'),
  messageInput: document.getElementById('message-input'),
  sendBtn: document.getElementById('send-btn'),
  modelBadge: document.getElementById('model-badge'),

  // Chat review card
  chatReviewCard: document.getElementById('chat-review-card'),
  changesSummaryText: document.getElementById('changes-summary-text'),
  acceptAllBtn: document.getElementById('accept-all-btn'),
  rejectAllBtn: document.getElementById('reject-all-btn'),
};

export default dom;
