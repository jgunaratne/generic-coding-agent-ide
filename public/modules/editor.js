/**
 * editor.js — Multi-tab code editor, diff engine, and accept/reject review.
 */

import state, { save } from './state.js';
import dom from './dom.js';
import { escapeHtml } from './markdown.js';
import { fetchFile, saveFileToDisk } from './api.js';
import { renderFileTree } from './explorer.js';

// ── Diff Utilities ──────────────────────────────────────────────────────────

/** Map file extension → Prism.js language identifier. */
function getLanguageFromPath(filePath) {
  const ext = (filePath || '').split('.').pop().toLowerCase();
  const langMap = {
    js: 'javascript', mjs: 'javascript',
    css: 'css',
    html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
    json: 'json',
    py: 'python',
    sh: 'bash', bash: 'bash',
    md: 'markdown',
  };
  return langMap[ext] || 'plaintext';
}

/**
 * Apply a SEARCH/REPLACE operation to file content.
 * Returns modified content, or null if SEARCH text not found.
 */
export function applySearchReplace(originalContent, searchText, replaceText) {
  const idx = originalContent.indexOf(searchText);
  if (idx !== -1) {
    return originalContent.substring(0, idx) + replaceText + originalContent.substring(idx + searchText.length);
  }
  // Fallback: try matching with trimmed trailing whitespace per line
  const searchLines = searchText.split('\n').map((l) => l.trimEnd());
  const contentLines = originalContent.split('\n').map((l) => l.trimEnd());
  const searchJoined = searchLines.join('\n');
  const contentJoined = contentLines.join('\n');
  const trimIdx = contentJoined.indexOf(searchJoined);
  if (trimIdx !== -1) {
    return contentJoined.substring(0, trimIdx) + replaceText + contentJoined.substring(trimIdx + searchJoined.length);
  }
  console.warn('SEARCH block not found in file content');
  return null;
}

/**
 * Compute an inline diff between original and proposed content.
 * Returns an array of { type: 'same'|'add'|'remove', text }.
 */
function computeInlineDiff(originalContent, proposedContent) {
  if (!originalContent && !proposedContent) return [];
  if (!originalContent) return proposedContent.split('\n').map((text) => ({ type: 'add', text }));
  if (!proposedContent) return originalContent.split('\n').map((text) => ({ type: 'remove', text }));

  const oldLines = originalContent.split('\n');
  const newLines = proposedContent.split('\n');
  const result = [];
  let oi = 0, ni = 0;
  const maxLookahead = 50;

  while (oi < oldLines.length && ni < newLines.length) {
    if (oldLines[oi] === newLines[ni]) {
      result.push({ type: 'same', text: newLines[ni] });
      oi++; ni++;
    } else {
      let bestNewSkip = -1, bestOldSkip = -1;
      for (let j = ni + 1; j < newLines.length && j - ni < maxLookahead; j++) {
        if (oldLines[oi] === newLines[j]) { bestNewSkip = j; break; }
      }
      for (let j = oi + 1; j < oldLines.length && j - oi < maxLookahead; j++) {
        if (oldLines[j] === newLines[ni]) { bestOldSkip = j; break; }
      }
      if (bestNewSkip !== -1 && (bestOldSkip === -1 || (bestNewSkip - ni) <= (bestOldSkip - oi))) {
        while (ni < bestNewSkip) result.push({ type: 'add', text: newLines[ni++] });
      } else if (bestOldSkip !== -1) {
        while (oi < bestOldSkip) result.push({ type: 'remove', text: oldLines[oi++] });
      } else {
        result.push({ type: 'remove', text: oldLines[oi++] });
        result.push({ type: 'add', text: newLines[ni++] });
      }
    }
  }
  while (oi < oldLines.length) result.push({ type: 'remove', text: oldLines[oi++] });
  while (ni < newLines.length) result.push({ type: 'add', text: newLines[ni++] });
  return result;
}

// ── Tab Bar ─────────────────────────────────────────────────────────────────

/** Render the editor tab bar from state.openTabs. */
export function renderTabBar() {
  if (state.openTabs.length === 0) {
    dom.tabBar.innerHTML = '';
    return;
  }

  dom.tabBar.innerHTML = state.openTabs
    .map((filePath) => {
      const fileName = filePath.split('/').pop();
      const isActive = filePath === state.activeFilePath;
      const isModified = state.pendingChanges[filePath] !== undefined;

      return `
        <div class="tab ${isActive ? 'active' : ''}" onclick="selectTab('${filePath}', event)">
          <span class="tab-title" style="${isModified ? 'color: var(--text-accent); font-weight:500;' : ''}">
            ${escapeHtml(fileName)} ${isModified ? '•' : ''}
          </span>
          <span class="tab-close" onclick="closeTab('${filePath}', event)">×</span>
        </div>
      `;
    })
    .join('');
}

window.selectTab = function (filePath, event) {
  if (event) event.stopPropagation();
  state.activeFilePath = filePath;
  save();
  renderTabBar();
  openFile(filePath);
};

window.closeTab = function (filePath, event) {
  if (event) event.stopPropagation();
  state.openTabs = state.openTabs.filter((t) => t !== filePath);

  if (state.activeFilePath === filePath) {
    state.activeFilePath = state.openTabs.length > 0 ? state.openTabs[state.openTabs.length - 1] : null;
  }
  save();
  renderTabBar();

  if (state.activeFilePath) {
    openFile(state.activeFilePath);
  } else {
    dom.codeEmptyState.style.display = 'flex';
    dom.codeEditor.style.display = 'none';
    dom.editorReviewBar.style.display = 'none';
  }
};

// ── File Opening & Code Display ─────────────────────────────────────────────

/** Open a file in the editor panel. Fetches content if not cached. */
export async function openFile(path) {
  // Highlight active row in explorer
  document.querySelectorAll('.tree-row').forEach((row) => {
    row.classList.toggle('active', row.getAttribute('data-path') === path);
  });

  dom.codeEmptyState.style.display = 'none';
  dom.codeEditor.style.display = 'none';
  dom.editorReviewBar.style.display = 'none';

  try {
    const hasPendingChange = state.pendingChanges[path] !== undefined;

    if (!state.fileContents[path]) {
      try {
        state.fileContents[path] = await fetchFile(path);
      } catch (fetchErr) {
        if (hasPendingChange) {
          state.fileContents[path] = '';
        } else {
          throw fetchErr;
        }
      }
    }

    const contentToDisplay = hasPendingChange ? state.pendingChanges[path] : state.fileContents[path];
    renderCodeDisplay(contentToDisplay, hasPendingChange, path);

    if (hasPendingChange) {
      dom.reviewFileInfo.textContent = path;
      dom.editorReviewBar.style.display = 'flex';
    }
  } catch (err) {
    console.error('Error loading file:', err);
    dom.codeContainer.innerHTML = `
      <div class="code-empty-state">
        <div class="error-message">⚠️ Failed to open file: ${escapeHtml(err.message)}</div>
      </div>
    `;
  }
}

/** Render file content (normal or diff mode) in the code panel. */
function renderCodeDisplay(content, isModifiedPreview = false, filePath = null) {
  dom.codeEmptyState.style.display = 'none';
  dom.codeEditor.style.display = 'flex';

  const lang = filePath ? getLanguageFromPath(filePath) : 'javascript';

  if (isModifiedPreview && filePath) {
    const originalContent = state.fileContents[filePath] || '';
    const diff = computeInlineDiff(originalContent, content);

    let lineNum = 0;
    let numbersHtml = '';
    const codeLines = [];

    for (const entry of diff) {
      if (entry.type === 'same') {
        lineNum++;
        numbersHtml += `<div class="line-number-item">${lineNum}</div>`;
        codeLines.push(`<div class="diff-line diff-same"><span class="diff-marker"> </span>${escapeHtml(entry.text)}</div>`);
      } else if (entry.type === 'add') {
        lineNum++;
        numbersHtml += `<div class="line-number-item diff-gutter-add">+</div>`;
        codeLines.push(`<div class="diff-line diff-add"><span class="diff-marker">+</span>${escapeHtml(entry.text)}</div>`);
      } else if (entry.type === 'remove') {
        numbersHtml += `<div class="line-number-item diff-gutter-remove">&minus;</div>`;
        codeLines.push(`<div class="diff-line diff-remove"><span class="diff-marker">&minus;</span>${escapeHtml(entry.text)}</div>`);
      }
    }

    dom.lineNumbers.innerHTML = numbersHtml;
    dom.codeContent.className = 'diff-view';
    dom.codeContent.innerHTML = codeLines.join('\n');
  } else {
    dom.codeContent.className = `language-${lang}`;
    dom.codeContent.textContent = content;

    if (typeof Prism !== 'undefined') {
      Prism.highlightElement(dom.codeContent);
    }

    const lines = content.split('\n');
    let numbersHtml = '';
    for (let i = 1; i <= lines.length; i++) {
      numbersHtml += `<div class="line-number-item">${i}</div>`;
    }
    dom.lineNumbers.innerHTML = numbersHtml;
  }
}

// ── Accept / Reject Review ──────────────────────────────────────────────────

/** Save a file to disk and clear it from pending changes. */
async function saveFile(filePath, content) {
  try {
    await saveFileToDisk(filePath, content);

    // Update cached content to the newly saved version
    state.fileContents[filePath] = content;
    delete state.pendingChanges[filePath];
    save();

    renderTabBar();
    renderFileTree();
    openFile(filePath);
    updateReviewCardsUI();
  } catch (err) {
    console.error(`Error saving file "${filePath}":`, err);
  }
}

export async function acceptChangesForActiveFile() {
  const path = state.activeFilePath;
  if (!path || !state.pendingChanges[path]) return;
  await saveFile(path, state.pendingChanges[path]);
}

export function rejectChangesForActiveFile() {
  const path = state.activeFilePath;
  if (!path || !state.pendingChanges[path]) return;

  delete state.pendingChanges[path];
  save();
  openFile(path);
  renderTabBar();
  renderFileTree();
  updateReviewCardsUI();
}

export async function acceptAllChanges() {
  const paths = Object.keys(state.pendingChanges);
  for (const path of paths) {
    await saveFile(path, state.pendingChanges[path]);
  }
}

export function rejectAllChanges() {
  state.pendingChanges = {};
  save();
  renderFileTree();
  renderTabBar();
  if (state.activeFilePath) openFile(state.activeFilePath);
  updateReviewCardsUI();
}

/** Update the review cards UI (chat footer + editor bar). */
export function updateReviewCardsUI() {
  const count = Object.keys(state.pendingChanges).length;

  if (count === 0) {
    dom.chatReviewCard.style.display = 'none';
    return;
  }

  dom.changesSummaryText.textContent = `${count} File${count > 1 ? 's' : ''} with Changes`;
  dom.chatReviewCard.style.display = 'flex';
}

// ── Proposed Changes Parser ─────────────────────────────────────────────────

/**
 * Parse an agent response for edit/create/legacy code blocks
 * and stage them as pending changes.
 */
export async function parseProposedChangesInResponse(text) {
  let changesFound = false;
  let match;

  // 1. Handle edit blocks: ```edit:filepath
  const editRegex = /```edit:([^\n]+)\n([\s\S]*?)```/g;

  while ((match = editRegex.exec(text)) !== null) {
    const filePath = match[1].trim();
    const blockContent = match[2];

    if (state.fileContents[filePath] === undefined) {
      try {
        state.fileContents[filePath] = await fetchFile(filePath);
      } catch (e) {
        console.warn(`Could not fetch ${filePath} for edit:`, e);
      }
    }

    let content = state.fileContents[filePath];
    if (content === undefined) {
      console.warn(`Original file content not found for ${filePath}, skipping edit block`);
      continue;
    }

    const pairRegex = /<<<< SEARCH\n([\s\S]*?)\n====\n([\s\S]*?)\n>>>> REPLACE/g;
    let pairMatch;
    let editApplied = false;

    while ((pairMatch = pairRegex.exec(blockContent)) !== null) {
      const result = applySearchReplace(content, pairMatch[1], pairMatch[2]);
      if (result !== null) {
        content = result;
        editApplied = true;
      } else {
        console.warn(`SEARCH/REPLACE failed for ${filePath}:`, pairMatch[1].substring(0, 80) + '...');
      }
    }

    if (editApplied) {
      state.pendingChanges[filePath] = content;
      changesFound = true;
    }
  }

  // 2. Handle create blocks: ```create:filepath
  const createRegex = /```create:([^\n]+)\n([\s\S]*?)```/g;
  while ((match = createRegex.exec(text)) !== null) {
    state.pendingChanges[match[1].trim()] = match[2];
    changesFound = true;
  }

  // 3. Legacy full-file blocks: ```language:filepath
  const legacyRegex = /```(\w+):([^\n]+)\n([\s\S]*?)```/g;
  while ((match = legacyRegex.exec(text)) !== null) {
    const lang = match[1].trim();
    if (lang === 'edit' || lang === 'create') continue;
    state.pendingChanges[match[2].trim()] = match[3];
    changesFound = true;
  }

  if (changesFound) {
    const modifiedPaths = Object.keys(state.pendingChanges);
    for (const filePath of modifiedPaths) {
      if (!state.openTabs.includes(filePath)) {
        state.openTabs.push(filePath);
      }
    }
    if (modifiedPaths.length > 0) {
      state.activeFilePath = modifiedPaths[0];
    }
    save();
    renderTabBar();
    renderFileTree();
    if (state.activeFilePath) openFile(state.activeFilePath);
    updateReviewCardsUI();
  }
}
