/**
 * app.js — Entry point for the Antigravity Workspace Frontend.
 *
 * Imports all modules, wires up DOM event listeners, and runs init().
 * This file should contain NO business logic — only glue code.
 */

// ── Module Imports ──────────────────────────────────────────────────────────

import state, { save, load } from './modules/state.js';
import dom from './modules/dom.js';
import { fetchHealth, fetchModels, fetchProjectConfig, switchProject } from './modules/api.js';
import { createAgent, selectAgent, createConversation, switchSidebarView, renderAgentsList, renderAgentTabs } from './modules/agents.js';
import { sendMessage, renderMessages, autoResizeTextarea, updateSendButton, updateModelBadge } from './modules/chat.js';
import { loadWorkspaceFiles } from './modules/explorer.js';
import { acceptChangesForActiveFile, rejectChangesForActiveFile, acceptAllChanges, rejectAllChanges, updateReviewCardsUI } from './modules/editor.js';

// ── Global Error Boundary ───────────────────────────────────────────────────

window.onerror = function (message, source, lineno, colno, error) {
  console.error('Diagnostic Error Boundary:', message, source, lineno, colno, error);
  const banner = document.createElement('div');
  Object.assign(banner.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw',
    background: '#f48771', color: '#1e1e1e', padding: '16px 20px',
    zIndex: '999999', fontFamily: 'monospace', fontSize: '12px',
    lineHeight: '1.5', boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
    borderBottom: '3px solid #ef4444',
  });
  banner.innerHTML = `
    <div style="font-weight: bold; font-size: 14px; margin-bottom: 8px;">⚠️ Frontend Runtime Error</div>
    <div><strong>Message:</strong> ${message}</div>
    <div><strong>Source:</strong> ${source}:${lineno}:${colno}</div>
    <pre style="margin-top: 10px; background: rgba(0,0,0,0.08); padding: 10px; border-radius: 4px; overflow: auto; max-height: 150px;">${error ? error.stack : 'No stack trace'}</pre>
    <div style="margin-top: 12px; display: flex; gap: 10px;">
      <button onclick="localStorage.clear(); location.reload();" style="padding: 6px 12px; background: #ef4444; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Reset localStorage</button>
      <button onclick="this.parentElement.parentElement.remove()" style="padding: 6px 12px; background: #3c3c3c; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Dismiss</button>
    </div>
  `;
  document.body.appendChild(banner);
  return false;
};

// ── Event Listeners ─────────────────────────────────────────────────────────

// Chat input
dom.messageInput.addEventListener('input', () => {
  autoResizeTextarea();
  updateSendButton();
});

dom.messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!dom.sendBtn.disabled) sendMessage(dom.messageInput.value);
  }
});

dom.sendBtn.addEventListener('click', () => sendMessage(dom.messageInput.value));

// New chat / agent buttons
dom.newChatBtn.addEventListener('click', () => {
  createConversation();
  renderAgentsList();
});

if (dom.newAgentBtn) {
  dom.newAgentBtn.addEventListener('click', () => createAgent());
}

// Conversation selector (legacy dropdown, hidden but still in DOM)
dom.conversationSelect.addEventListener('change', (e) => {
  import('./modules/agents.js').then(({ selectConversation }) => selectConversation(e.target.value));
});

// Activity bar view switching
document.querySelectorAll('.activity-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => switchSidebarView(btn.dataset.view));
});

// Model selection
dom.modelSelect.addEventListener('change', (e) => {
  state.selectedModel = e.target.value;
  save();
  updateModelBadge();
});

// Project selection
dom.projectSelect.addEventListener('change', async (e) => {
  const newProject = e.target.value;
  state.activeProject = newProject;
  save();

  dom.connectionStatus.innerHTML = `<div class="status-dot"></div><span>Switching project...</span>`;

  try {
    await switchProject(newProject);
    await loadModelsUI();
    checkHealthUI();
  } catch (err) {
    console.error('Error switching project:', err);
    dom.connectionStatus.innerHTML = `<div class="status-dot error"></div><span>Switch error</span>`;
  }
});

// Suggestion cards
document.querySelectorAll('.suggestion-card').forEach((card) => {
  card.addEventListener('click', () => {
    const prompt = card.getAttribute('data-prompt');
    if (prompt) {
      dom.messageInput.value = prompt;
      autoResizeTextarea();
      updateSendButton();
      sendMessage(prompt);
    }
  });
});

// Accept / Reject changes
dom.acceptChangesBtn.addEventListener('click', acceptChangesForActiveFile);
dom.rejectChangesBtn.addEventListener('click', rejectChangesForActiveFile);
dom.acceptAllBtn.addEventListener('click', () => acceptAllChanges());
dom.rejectAllBtn.addEventListener('click', rejectAllChanges);

// ── Copy Code (global handler for inline onclick) ───────────────────────────

window.copyCode = function (codeId, btn) {
  const codeEl = document.getElementById(codeId);
  if (codeEl) {
    navigator.clipboard.writeText(codeEl.textContent).then(() => {
      btn.classList.add('copied');
      btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy';
      }, 2000);
    });
  }
};

// ── Panel Resize (Sash) System ──────────────────────────────────────────────

(function initSashResize() {
  const sashSidebar = document.getElementById('sash-sidebar');
  const sashChat = document.getElementById('sash-chat');
  const sidebar = document.getElementById('file-sidebar');
  const codePanel = document.getElementById('code-panel');
  const chatPanel = document.getElementById('chat-panel');

  if (!sashSidebar || !sashChat || !sidebar || !codePanel || !chatPanel) return;

  const savedSidebar = localStorage.getItem('panel-sidebar-width');
  const savedChat = localStorage.getItem('panel-chat-width');
  if (savedSidebar) sidebar.style.width = savedSidebar + 'px';
  if (savedChat) chatPanel.style.width = savedChat + 'px';

  function startDrag(sash, onMove) {
    let animFrame = null;

    function handleMove(e) {
      if (animFrame) cancelAnimationFrame(animFrame);
      animFrame = requestAnimationFrame(() => onMove(e.clientX));
    }

    function handleEnd() {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleEnd);
      document.body.classList.remove('sash-dragging');
      sash.classList.remove('active');
      if (animFrame) cancelAnimationFrame(animFrame);
      localStorage.setItem('panel-sidebar-width', sidebar.offsetWidth);
      localStorage.setItem('panel-chat-width', chatPanel.offsetWidth);
    }

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
    document.body.classList.add('sash-dragging');
    sash.classList.add('active');
  }

  sashSidebar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const activityBarWidth = document.querySelector('.activity-bar')?.offsetWidth || 48;
    startDrag(sashSidebar, (clientX) => {
      sidebar.style.width = Math.max(120, Math.min(600, clientX - activityBarWidth)) + 'px';
    });
  });

  sashChat.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const windowWidth = window.innerWidth;
    startDrag(sashChat, (clientX) => {
      chatPanel.style.width = Math.max(200, Math.min(800, windowWidth - clientX)) + 'px';
    });
  });

  sashSidebar.addEventListener('dblclick', () => {
    sidebar.style.width = '';
    localStorage.removeItem('panel-sidebar-width');
  });

  sashChat.addEventListener('dblclick', () => {
    chatPanel.style.width = '';
    localStorage.removeItem('panel-chat-width');
  });
})();

// ── Server Configuration Loaders ────────────────────────────────────────────

async function loadProjectConfigUI() {
  try {
    const config = await fetchProjectConfig();
    state.activeProject = config.activeProject;

    dom.projectSelect.innerHTML = config.projects
      .map((p) => `<option value="${p}" ${p === config.activeProject ? 'selected' : ''}>${p}</option>`)
      .join('');
  } catch (err) {
    console.error('Error loading project config:', err);
  }
}

async function loadModelsUI() {
  try {
    const models = await fetchModels();
    state.models = models;

    dom.modelSelect.innerHTML = models
      .map((m) => {
        const disabled = m.available === false;
        const label = disabled ? `${m.name} (unavailable)` : m.name;
        return `<option value="${m.id}" ${m.id === state.selectedModel ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${label}</option>`;
      })
      .join('');

    updateModelBadge();
  } catch (err) {
    console.error('Error loading models:', err);
  }
}

async function checkHealthUI() {
  try {
    const data = await fetchHealth();
    if (data.status === 'ok') {
      dom.connectionStatus.innerHTML = `<div class="status-dot connected"></div><span>${data.project} · ${data.region}</span>`;
    } else {
      dom.connectionStatus.innerHTML = `<div class="status-dot error"></div><span>Auth error</span>`;
    }
  } catch {
    dom.connectionStatus.innerHTML = `<div class="status-dot error"></div><span>Server offline</span>`;
  }
}

// ── Initialization ──────────────────────────────────────────────────────────

async function init() {
  await load();
  renderAgentsList();
  renderAgentTabs();
  renderMessages();
  await loadProjectConfigUI();
  await loadModelsUI();
  await loadWorkspaceFiles();
  checkHealthUI();
  updateReviewCardsUI();

  dom.messageInput.focus();
  setInterval(checkHealthUI, 60000);
}

init();