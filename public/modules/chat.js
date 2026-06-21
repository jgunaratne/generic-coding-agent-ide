/**
 * chat.js — Message rendering, streaming agent API, event handling.
 */

import state, { save, getActiveConversation, persistConversation } from './state.js';
import dom from './dom.js';
import { escapeHtml, renderMarkdown } from './markdown.js';
import { runAgentStream } from './api.js';
import { renderAgentsList, renderAgentTabs, generateTitle, createConversation } from './agents.js';
import { renderTabBar, openFile, updateReviewCardsUI, parseProposedChangesInResponse } from './editor.js';
import { renderFileTree } from './explorer.js';

// ── Message Rendering ───────────────────────────────────────────────────────

/** Render the chat message list for the active conversation. */
export function renderMessages() {
  const conv = getActiveConversation();

  if (!conv || (conv.messages.length === 0 && !conv.isStreaming)) {
    dom.emptyState.style.display = 'flex';
    dom.chatMessages.style.display = 'none';
    return;
  }

  dom.emptyState.style.display = 'none';
  dom.chatMessages.style.display = 'block';

  dom.chatMessages.innerHTML = conv.messages
    .map(
      (msg) => `
      <div class="message">
        <div class="message-header">
          <div class="message-avatar ${msg.role}">
            ${msg.role === 'user' ? 'U' : 'AI'}
          </div>
          <span class="message-role">${msg.role === 'user' ? 'You' : 'Claude'}</span>
        </div>
        <div class="message-content">${renderMarkdown(msg.content)}</div>
      </div>
    `
    )
    .join('');

  if (conv.isStreaming) {
    ensureAgentStreamingMessage(conv);
  }

  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
  });
}

// ── Streaming Agent API ─────────────────────────────────────────────────────

/** Send a user message and start the streaming agent loop. */
export async function sendMessage(userText) {
  if (!userText.trim()) return;

  if (!state.activeConversationId) {
    createConversation();
  }

  const conv = getActiveConversation();
  if (!conv || conv.isStreaming) return;

  conv.messages.push({ role: 'user', content: userText });
  if (conv.messages.filter((m) => m.role === 'user').length === 1) {
    conv.title = generateTitle(userText);
  }

  conv.isStreaming = true;
  conv.streamingActivity = [];
  conv.streamingText = '';

  save();
  renderAgentTabs();
  renderAgentsList();
  renderMessages();

  dom.messageInput.value = '';
  autoResizeTextarea();
  updateSendButton();

  ensureAgentStreamingMessage(conv);

  try {
    const apiMessages = conv.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const response = await runAgentStream(apiMessages);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            handleAgentEvent(event, conv);
          } catch { /* ignore malformed JSON */ }
        }
      }
    }
  } catch (err) {
    console.error('Agent error:', err);
    if (conv.id === state.activeConversationId) {
      removeAgentStreamingMessage();
      const errorDiv = document.createElement('div');
      errorDiv.className = 'message';
      errorDiv.innerHTML = `
        <div class="message-header">
          <div class="message-avatar assistant">AI</div>
          <span class="message-role">Error</span>
        </div>
        <div class="message-content">
          <div class="error-message">⚠️ ${escapeHtml(err.message)}</div>
        </div>
      `;
      dom.chatMessages.appendChild(errorDiv);
      scrollToBottom();
    }
  } finally {
    conv.isStreaming = false;
    finalizeAgentMessage(conv);
    renderAgentsList();
    renderAgentTabs();
  }
}

// ── Streaming UI ────────────────────────────────────────────────────────────

/**
 * Create or reconstruct the streaming message DOM element.
 * Called when starting a stream or switching back to an active stream.
 */
function ensureAgentStreamingMessage(conv) {
  if (conv.id !== state.activeConversationId) return;

  let streamDiv = document.getElementById('agent-streaming-message');
  if (!streamDiv) {
    streamDiv = document.createElement('div');
    streamDiv.id = 'agent-streaming-message';
    streamDiv.className = 'message';

    // Reconstruct activity feed from buffered events
    const feedHtml = conv.streamingActivity
      .map((event) => {
        if (event.type === 'thinking') {
          return buildThinkingHtml(event.content);
        } else if (event.type === 'status') {
          return `<div class="activity-step status-step"><span class="activity-icon">⚡</span><span class="activity-label">${escapeHtml(event.content)}</span></div>`;
        } else if (event.type === 'tool_call') {
          const completed = conv.streamingActivity.find((e) => e.type === 'tool_result' && e.id === event.id);
          const icon = getToolIcon(event.name);
          const label = getToolLabel(event.name, event.input);
          const spinner = completed
            ? '<span class="activity-check">✓</span>'
            : '<span class="activity-spinner"><div class="spinner" style="width:10px;height:10px;border-width:1.5px;"></div></span>';
          return `
            <div class="activity-step tool-call-step ${completed ? 'completed' : ''}" id="tool-step-${event.id}">
              <span class="activity-icon">${icon}</span>
              <span class="activity-label">${escapeHtml(label)}</span>
              ${spinner}
            </div>`;
        } else if (event.type === 'tool_result') {
          return '';
        } else if (event.type === 'file_change') {
          const actionLabel = event.action === 'create' ? 'Created' : 'Edited';
          return `<div class="activity-step file-change-step"><span class="activity-icon">✏️</span><span class="activity-label">${actionLabel} <strong>${escapeHtml(event.path)}</strong></span><span class="activity-check">✓</span></div>`;
        } else if (event.type === 'done') {
          return `<div class="activity-step done-step"><span class="activity-icon">✅</span><span class="activity-label">Agent completed</span></div>`;
        } else if (event.type === 'error') {
          return `<div class="activity-step error-step"><span class="activity-icon">❌</span><span class="activity-label">${escapeHtml(event.message || '')}</span></div>`;
        }
        return '';
      })
      .join('');

    streamDiv.innerHTML = `
      <div class="message-header">
        <div class="message-avatar assistant">AI</div>
        <span class="message-role">Claude</span>
      </div>
      <div class="message-content" id="agent-streaming-content">
        <div class="agent-activity-feed" id="agent-activity-feed">${feedHtml}</div>
        <div class="agent-text-output" id="agent-text-output" data-raw="${escapeHtml(conv.streamingText)}">${renderMarkdown(conv.streamingText)}</div>
      </div>
    `;
    dom.chatMessages.appendChild(streamDiv);
    dom.emptyState.style.display = 'none';
    dom.chatMessages.style.display = 'block';
    scrollToBottom();
  }
  return streamDiv;
}

function removeAgentStreamingMessage() {
  const el = document.getElementById('agent-streaming-message');
  if (el) el.remove();
}

// ── Event Handling ──────────────────────────────────────────────────────────

/** Process a single SSE event from the agent stream. */
function handleAgentEvent(event, conv) {
  conv.streamingActivity.push(event);

  if (event.type === 'text') {
    conv.streamingText += event.content;
  }

  // Update background state for file changes (always, even if not active conv)
  if (event.type === 'file_change') {
    state.pendingChanges[event.path] = event.content;
    if (event.originalContent !== undefined && !state.fileContents[event.path]) {
      state.fileContents[event.path] = event.originalContent;
    }
    if (event.action === 'create' && !state.fileContents[event.path]) {
      state.fileContents[event.path] = '';
    }
    if (!state.openTabs.includes(event.path)) {
      state.openTabs.push(event.path);
    }
    state.activeFilePath = event.path;
    save();
    renderTabBar();
    renderFileTree();
    updateReviewCardsUI();
  }

  // If not the active conversation, don't touch chat DOM
  if (conv.id !== state.activeConversationId) return;

  const feedEl = document.getElementById('agent-activity-feed');
  const textEl = document.getElementById('agent-text-output');
  if (!feedEl || !textEl) return;

  switch (event.type) {
    case 'thinking': {
      const item = document.createElement('div');
      item.className = 'activity-step thinking-step';
      item.innerHTML = buildThinkingHtml(event.content);
      feedEl.appendChild(item);
      break;
    }
    case 'status': {
      const item = document.createElement('div');
      item.className = 'activity-step status-step';
      item.innerHTML = `<span class="activity-icon">⚡</span><span class="activity-label">${escapeHtml(event.content)}</span>`;
      feedEl.appendChild(item);
      break;
    }
    case 'tool_call': {
      const icon = getToolIcon(event.name);
      const label = getToolLabel(event.name, event.input);
      const item = document.createElement('div');
      item.className = 'activity-step tool-call-step';
      item.id = `tool-step-${event.id}`;
      item.innerHTML = `
        <span class="activity-icon">${icon}</span>
        <span class="activity-label">${escapeHtml(label)}</span>
        <span class="activity-spinner"><div class="spinner" style="width:10px;height:10px;border-width:1.5px;"></div></span>
      `;
      feedEl.appendChild(item);
      break;
    }
    case 'tool_result': {
      const stepEl = document.getElementById(`tool-step-${event.id}`);
      if (stepEl) {
        const spinner = stepEl.querySelector('.activity-spinner');
        if (spinner) spinner.innerHTML = '<span class="activity-check">✓</span>';
        stepEl.classList.add('completed');
      }
      break;
    }
    case 'text': {
      textEl.innerHTML = renderMarkdown(conv.streamingText);
      break;
    }
    case 'file_change': {
      openFile(event.path);
      const item = document.createElement('div');
      item.className = 'activity-step file-change-step';
      const actionLabel = event.action === 'create' ? 'Created' : 'Edited';
      item.innerHTML = `
        <span class="activity-icon">✏️</span>
        <span class="activity-label">${actionLabel} <strong>${escapeHtml(event.path)}</strong></span>
        <span class="activity-check">✓</span>
      `;
      feedEl.appendChild(item);
      break;
    }
    case 'done': {
      const item = document.createElement('div');
      item.className = 'activity-step done-step';
      item.innerHTML = `<span class="activity-icon">✅</span><span class="activity-label">Agent completed</span>`;
      feedEl.appendChild(item);
      break;
    }
    case 'error': {
      const item = document.createElement('div');
      item.className = 'activity-step error-step';
      item.innerHTML = `<span class="activity-icon">❌</span><span class="activity-label">${escapeHtml(event.message)}</span>`;
      feedEl.appendChild(item);
      break;
    }
  }

  scrollToBottom();
}

/** Finalize the streaming message when the agent completes. */
function finalizeAgentMessage(conv) {
  if (conv.id === state.activeConversationId) {
    const streamDiv = document.getElementById('agent-streaming-message');
    if (streamDiv) {
      streamDiv.removeAttribute('id');
      const feedEl = streamDiv.querySelector('#agent-activity-feed');
      const textEl = streamDiv.querySelector('#agent-text-output');
      if (feedEl) feedEl.removeAttribute('id');
      if (textEl) textEl.removeAttribute('id');
    }
  }

  if (conv.streamingText) {
    conv.messages.push({ role: 'assistant', content: conv.streamingText });
    parseProposedChangesInResponse(conv.streamingText);
  }

  conv.streamingText = '';
  conv.streamingActivity = [];
  conv.isStreaming = false;

  save();
  persistConversation(conv);
  if (conv.id === state.activeConversationId) {
    updateSendButton();
  }
}

// ── Tool Helpers ────────────────────────────────────────────────────────────

/** Build a collapsible HTML block for an agent thinking event. */
function buildThinkingHtml(content) {
  if (!content) return '';
  const preview = content.replace(/\n/g, ' ').substring(0, 80);
  const suffix = content.length > 80 ? '…' : '';
  return `
    <details class="thinking-block">
      <summary class="thinking-summary">
        <span class="activity-icon">💭</span>
        <span class="thinking-label">Thinking</span>
        <span class="thinking-preview">${escapeHtml(preview)}${suffix}</span>
      </summary>
      <div class="thinking-content">${escapeHtml(content)}</div>
    </details>`;
}

function getToolIcon(name) {
  const icons = {
    list_files: '📂', read_file: '📄', search_files: '🔍',
    write_file: '✏️', run_command: '🧪',
  };
  return icons[name] || '🔧';
}

function getToolLabel(name, input) {
  switch (name) {
    case 'list_files':   return `Listing files in ${input.path || '.'}`;
    case 'read_file':    return `Reading ${input.path}`;
    case 'search_files': return `Searching for "${input.query}"${input.file_pattern ? ` in ${input.file_pattern}` : ''}`;
    case 'write_file':   return `Writing to ${input.path}`;
    case 'run_command':  return `Running: ${input.command}`;
    default:             return `${name}(${JSON.stringify(input).substring(0, 50)})`;
  }
}

// ── UI Helpers ──────────────────────────────────────────────────────────────

export function autoResizeTextarea() {
  const el = dom.messageInput;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

export function updateSendButton() {
  const hasText = dom.messageInput.value.trim().length > 0;
  const conv = getActiveConversation();
  const isStreaming = conv ? conv.isStreaming : false;

  dom.sendBtn.disabled = !hasText || isStreaming;

  const progressBar = document.getElementById('agent-progress-bar');
  const statusBanner = document.getElementById('agent-status-banner');
  const sendIcon = dom.sendBtn.querySelector('.send-icon');
  const stopIcon = dom.sendBtn.querySelector('.stop-icon');

  if (isStreaming) {
    if (progressBar) progressBar.style.display = 'block';
    if (statusBanner) statusBanner.style.display = 'flex';
    if (sendIcon) sendIcon.style.display = 'none';
    if (stopIcon) stopIcon.style.display = 'block';
    dom.messageInput.disabled = true;
  } else {
    if (progressBar) progressBar.style.display = 'none';
    if (statusBanner) statusBanner.style.display = 'none';
    if (sendIcon) sendIcon.style.display = 'block';
    if (stopIcon) stopIcon.style.display = 'none';
    dom.messageInput.disabled = false;
  }
}

export function updateModelBadge() {
  const selected = state.models.find((m) => m.id === state.selectedModel);
  dom.modelBadge.textContent = selected ? selected.name : state.selectedModel;
}
