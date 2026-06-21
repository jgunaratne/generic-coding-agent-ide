/**
 * explorer.js — Workspace file-tree loading, rendering, and navigation.
 */

import state, { save } from './state.js';
import dom from './dom.js';
import { escapeHtml } from './markdown.js';
import { fetchWorkspaceFiles } from './api.js';
import { renderTabBar, openFile } from './editor.js';

/** Fetch workspace files from the server and render the tree. */
export async function loadWorkspaceFiles() {
  try {
    state.fileTree = await fetchWorkspaceFiles();
    renderFileTree();
    renderTabBar();

    if (state.activeFilePath) {
      openFile(state.activeFilePath);
    }
  } catch (err) {
    console.error('File explorer error:', err);
    dom.fileTree.innerHTML = `
      <div class="error-message" style="margin: 10px;">
        ⚠️ Failed to read workspace files
      </div>
    `;
  }
}

/** Render the file-tree sidebar from state.fileTree. */
export function renderFileTree() {
  dom.fileTree.innerHTML = buildTreeHtml(state.fileTree);
}

/** Recursively build nested HTML for a tree of file/directory nodes. */
function buildTreeHtml(nodes) {
  if (!nodes || nodes.length === 0) return '';

  return nodes
    .map((node) => {
      const isDir = node.type === 'directory';
      const isOpen = state.openDirectories[node.path] === true;
      const isActive = state.activeFilePath === node.path;
      const isModified = state.pendingChanges[node.path] !== undefined;

      const expanderIcon = isDir
        ? `<span class="tree-expander ${isOpen ? 'expanded' : ''}">▸</span>`
        : `<span style="width:14px; display:inline-block;"></span>`;

      let html = `
        <div class="tree-node">
          <div class="tree-row ${isActive ? 'active' : ''}"
               data-path="${node.path}"
               data-type="${node.type}"
               onclick="handleTreeNodeClick(this, event)">
            ${expanderIcon}
            <span class="tree-name" style="${isModified ? 'color: var(--text-accent); font-weight:500;' : ''}">
              ${escapeHtml(node.name)} ${isModified ? '•' : ''}
            </span>
          </div>
      `;

      if (isDir) {
        html += `
          <div class="tree-children ${isOpen ? '' : 'hidden'}" id="dir-${node.path.replace(/\//g, '-')}" style="padding-left: 10px;">
            ${buildTreeHtml(node.children)}
          </div>
        `;
      }

      html += `</div>`;
      return html;
    })
    .join('');
}

/**
 * Global click handler for tree rows.
 * Directories toggle open/closed; files open in the editor.
 */
window.handleTreeNodeClick = function (rowEl, event) {
  event.stopPropagation();
  const path = rowEl.getAttribute('data-path');
  const type = rowEl.getAttribute('data-type');

  if (type === 'directory') {
    state.openDirectories[path] = !state.openDirectories[path];
    save();

    const childrenContainer = document.getElementById(`dir-${path.replace(/\//g, '-')}`);
    const expander = rowEl.querySelector('.tree-expander');

    if (childrenContainer) {
      if (state.openDirectories[path]) {
        childrenContainer.classList.remove('hidden');
        if (expander) expander.classList.add('expanded');
      } else {
        childrenContainer.classList.add('hidden');
        if (expander) expander.classList.remove('expanded');
      }
    }
  } else {
    if (!state.openTabs.includes(path)) {
      state.openTabs.push(path);
    }
    state.activeFilePath = path;
    save();
    renderTabBar();
    openFile(path);
  }
};
