// Initialize CodeMirror editor
const editor = CodeMirror.fromTextArea(document.getElementById('codeEditor'), {
    lineNumbers: true,
    mode: 'javascript',
    theme: 'monokai',
    indentUnit: 4,
    indentWithTabs: false,
    lineWrapping: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    extraKeys: {
        "Ctrl-Space": "autocomplete"
    }
});

// Set initial sample code
editor.setValue(`// Welcome to the Code Editor IDE!
// This editor has syntax highlighting for multiple languages

function greet(name) {
    console.log("Hello, " + name + "!");
    return "Welcome to coding!";
}

greet("World");

// Try changing the language from the dropdown above!`);

// Language select handler
document.getElementById('languageSelect').addEventListener('change', function(e) {
    const mode = e.target.value;
    editor.setOption('mode', mode);
    
    // Set sample code based on language
    const samples = {
        javascript: `// JavaScript Example
function fibonacci(n) {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
}

console.log(fibonacci(10));`,
        python: `# Python Example
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

print(fibonacci(10))`,
        htmlmixed: `<!DOCTYPE html>
<html>
<head>
    <title>Hello World</title>
</head>
<body>
    <h1>Welcome to HTML!</h1>
    <p>This is a paragraph.</p>
</body>
</html>`,
        css: `/* CSS Example */
body {
    font-family: Arial, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
}`,
        xml: `<?xml version="1.0" encoding="UTF-8"?>
<bookstore>
    <book category="web">
        <title>Learning XML</title>
        <author>Erik T. Ray</author>
        <year>2003</year>
    </book>
</bookstore>`,
        markdown: `# Markdown Example

## Features
- **Bold text**
- *Italic text*
- [Links](https://example.com)

### Code Block
\`\`\`javascript
console.log("Hello!");
\`\`\`
`
    };
    
    if (samples[mode]) {
        editor.setValue(samples[mode]);
    }
});

// Theme select handler
document.getElementById('themeSelect').addEventListener('change', function(e) {
    const theme = e.target.value;
    editor.setOption('theme', theme);
    
    // Load theme CSS dynamically if not default or monokai
    if (theme !== 'default' && theme !== 'monokai') {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.2/theme/${theme}.min.css`;
        document.head.appendChild(link);
    }
});

// Run code button (only works for JavaScript)
document.getElementById('runBtn').addEventListener('click', function() {
    const code = editor.getValue();
    const output = document.getElementById('output');
    const currentMode = editor.getOption('mode');
    
    if (currentMode !== 'javascript') {
        output.innerHTML = '<span class="error">⚠️ Code execution is only supported for JavaScript in this demo.</span>';
        return;
    }
    
    // Clear previous output
    output.innerHTML = '';
    
    // Capture console.log output
    const logs = [];
    const originalLog = console.log;
    console.log = function(...args) {
        logs.push(args.join(' '));
        originalLog.apply(console, args);
    };
    
    try {
        // Execute the code
        eval(code);
        
        // Restore console.log
        console.log = originalLog;
        
        // Display output
        if (logs.length > 0) {
            output.innerHTML = '<span class="success">✓ Code executed successfully:</span>\n' + logs.join('\n');
        } else {
            output.innerHTML = '<span class="success">✓ Code executed successfully (no output)</span>';
        }
    } catch (error) {
        // Restore console.log
        console.log = originalLog;
        
        // Display error
        output.innerHTML = '<span class="error">✗ Error:</span>\n' + error.message;
    }
});

// Clear button
document.getElementById('clearBtn').addEventListener('click', function() {
    editor.setValue('');
    document.getElementById('output').innerHTML = '';
});

// Auto-resize editor
window.addEventListener('resize', function() {
    editor.refresh();
});
