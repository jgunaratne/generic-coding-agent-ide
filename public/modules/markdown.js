/**
 * markdown.js — Pure-function Markdown-to-HTML renderer and HTML escaper.
 *
 * No side effects, no imports from other app modules.
 */

let codeBlockCounter = 0;

/** Escape HTML special characters to prevent XSS. */
export function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Convert a markdown string to sanitised HTML.
 * Supports: fenced code blocks, inline code, bold, italic,
 * headings, blockquotes, unordered lists, and paragraphs.
 */
export function renderMarkdown(text) {
  if (!text) return '';

  let html = text;

  // Fenced code blocks with optional language tag
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const codeId = `code-block-${codeBlockCounter++}`;
    const langLabel = lang || 'code';
    const langClass = lang ? `language-${lang}` : '';
    const highlighted =
      typeof Prism !== 'undefined' && lang && Prism.languages[lang]
        ? Prism.highlight(code.trimEnd(), Prism.languages[lang], lang)
        : escapeHtml(code.trimEnd());

    return `
      <div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-lang">${langLabel}</span>
          <button class="copy-btn" onclick="copyCode('${codeId}', this)">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg> Copy
          </button>
        </div>
        <pre class="code-block"><code id="${codeId}" class="${langClass}">${highlighted}</code></pre>
      </div>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^(\s*)[•\-\*] (.+)$/gm, (_match, indent, content) => {
    return `<ul><li>${content}</li></ul>`;
  });
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  // Paragraphs — wrap remaining text blocks
  html = html
    .split('\n\n')
    .map((block) => {
      block = block.trim();
      if (!block) return '';
      if (
        block.startsWith('<h') ||
        block.startsWith('<ul') ||
        block.startsWith('<blockquote') ||
        block.startsWith('<div') ||
        block.startsWith('<pre')
      ) {
        return block;
      }
      return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
    })
    .join('\n');

  return html;
}
