/**
 * agents.js — Agent & conversation CRUD, sidebar rendering, tab bar.
 */

import state, { save, getActiveConversation } from './state.js';
import dom from './dom.js';
import { escapeHtml } from './markdown.js';

// ── Agent CRUD ──────────────────────────────────────────────────────────────

export function createAgent() {
  const id = 'agent_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const agent = { id, name: 'New Agent', createdAt: Date.now() };
  state.agents.unshift(agent);
  createConversation(id);
  selectAgent(id);
}

export function selectAgent(id) {
  state.activeAgentId = id;

  const convs = state.conversations.filter((c) => c.agentId === id);
  if (convs.length === 0) {
    createConversation(id);
  } else if (!state.activeConversationId || !convs.find((c) => c.id === state.activeConversationId)) {
    state.activeConversationId = convs[0].id;
  }

  save();
  renderAgentsList();
  renderAgentTabs();

  // Lazy-import to avoid circular deps
  import('./chat.js').then(({ renderMessages, updateSendButton }) => {
    renderMessages();
    updateSendButton();
  });
}

export function deleteAgent(id) {
  state.agents = state.agents.filter((a) => a.id !== id);
  state.conversations = state.conversations.filter((c) => c.agentId !== id);

  if (state.activeAgentId === id) {
    const nextAgent = state.agents[0];
    if (nextAgent) {
      selectAgent(nextAgent.id);
    } else {
      state.activeAgentId = null;
      state.activeConversationId = null;
      renderAgentsList();
      renderAgentTabs();
      import('./chat.js').then(({ renderMessages }) => renderMessages());
    }
  } else {
    save();
    renderAgentsList();
  }
}

// ── Conversation CRUD ───────────────────────────────────────────────────────

export function createConversation(agentId) {
  agentId = agentId || state.activeAgentId;
  if (!agentId) return;

  const id = 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const conv = {
    id,
    agentId,
    title: 'New Chat',
    messages: [],
    isStreaming: false,
    streamingActivity: [],
    streamingText: '',
    createdAt: Date.now(),
  };
  state.conversations.unshift(conv);

  if (state.activeAgentId === agentId) {
    state.activeConversationId = id;
    save();
    renderAgentTabs();
    import('./chat.js').then(({ renderMessages }) => {
      renderMessages();
      dom.messageInput?.focus();
    });
  } else {
    save();
  }
}

export function selectConversation(id) {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return;

  state.activeConversationId = id;
  if (state.activeAgentId !== conv.agentId) {
    state.activeAgentId = conv.agentId;
    renderAgentsList();
  }
  save();
  renderAgentTabs();
  import('./chat.js').then(({ renderMessages, updateSendButton }) => {
    renderMessages();
    updateSendButton();
  });
}

/** Generate a short title from the first user message. */
export function generateTitle(firstMessage) {
  const text = firstMessage.replace(/\n/g, ' ').trim();
  return text.length > 25 ? text.slice(0, 25) + '…' : text;
}

// ── Sidebar View Switching ──────────────────────────────────────────────────

export function switchSidebarView(viewName) {
  document.querySelectorAll('.activity-item[data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  document.querySelectorAll('.sidebar-view').forEach((view) => {
    view.classList.remove('active');
  });

  if (viewName === 'explorer' && dom.sidebarExplorer) {
    dom.sidebarExplorer.classList.add('active');
  } else if (viewName === 'agents' && dom.sidebarAgents) {
    dom.sidebarAgents.classList.add('active');
    renderAgentsList();
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** Render agent cards in the sidebar. */
export function renderAgentsList() {
  if (!dom.agentsList) return;

  if (state.agents.length === 0) {
    dom.agentsList.innerHTML = `
      <div class="agents-empty">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <span>No coding agents yet</span>
        <span>Click + to start a new agent</span>
      </div>`;
    return;
  }

  dom.agentsList.innerHTML = state.agents
    .map((agent) => {
      const isActive = agent.id === state.activeAgentId;
      const agentConvs = state.conversations.filter((c) => c.agentId === agent.id);
      const isStreaming = agentConvs.some((c) => c.isStreaming);
      const msgCount = agentConvs.reduce((acc, c) => acc + c.messages.length, 0);

      const statusClass = isStreaming ? 'streaming' : msgCount > 0 ? 'active' : '';
      const statusText = isStreaming ? 'Running...' : `${agentConvs.length} chat${agentConvs.length !== 1 ? 's' : ''}`;
      const initial = agent.name.charAt(0).toUpperCase();

      return `
        <div class="agent-card ${isActive ? 'active' : ''}" data-agent-id="${agent.id}">
          <div class="agent-avatar">${escapeHtml(initial)}</div>
          <div class="agent-info">
            <div class="agent-title">${escapeHtml(agent.name)}</div>
            <div class="agent-meta">
              <div class="agent-status-dot ${statusClass}"></div>
              <span>${statusText}</span>
            </div>
          </div>
          <div class="agent-actions">
            <button class="agent-delete-btn" data-delete-id="${agent.id}" title="Delete agent">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>`;
    })
    .join('');

  // Attach click handlers
  dom.agentsList.querySelectorAll('.agent-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.agent-delete-btn')) return;
      selectAgent(card.dataset.agentId);
    });
  });

  dom.agentsList.querySelectorAll('.agent-delete-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteAgent(btn.dataset.deleteId);
    });
  });
}

/** Render conversation tabs in the chat header for the active agent. */
export function renderAgentTabs() {
  const tabsBar = document.getElementById('agent-tabs-bar');
  if (!tabsBar) return;

  if (!state.activeAgentId) {
    tabsBar.innerHTML = '';
    return;
  }

  const agentConvs = state.conversations.filter((c) => c.agentId === state.activeAgentId);

  if (dom.conversationSelect) {
    dom.conversationSelect.style.display = 'none';
  }

  tabsBar.innerHTML = agentConvs
    .map((conv) => {
      const isActive = conv.id === state.activeConversationId;
      const isStreaming = conv.isStreaming;
      const statusDot = isStreaming ? `<div class="agent-status-dot streaming"></div>` : '';

      return `
        <div class="agent-tab ${isActive ? 'active' : ''}" onclick="selectConversation('${conv.id}')" style="display: flex; align-items: center; gap: 6px; padding: 6px 12px; cursor: pointer; border-bottom: 2px solid ${isActive ? 'var(--accent-primary)' : 'transparent'};">
          ${statusDot}
          <span>${escapeHtml(conv.title)}</span>
        </div>
      `;
    })
    .join('');
}

// Expose selectConversation globally for inline onclick in tabs
window.selectConversation = function (id) {
  selectConversation(id);
};
