const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');

let currentPanel = undefined;
let lastActiveTextEditor = undefined;
let cachedVersion = 'Loading...';
let diagnosticCollection = undefined;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    // Create diagnostic collection for lint warnings
    diagnosticCollection = vscode.languages.createDiagnosticCollection('sourcemeta-studio');
    context.subscriptions.push(diagnosticCollection);

    const openPanelCommand = vscode.commands.registerCommand('sourcemeta-studio.openPanel', () => {
        const columnToShowIn = vscode.window.activeTextEditor
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;

        if (currentPanel) {
            currentPanel.reveal(columnToShowIn, true);
            updatePanelContent();
        } else {
            currentPanel = vscode.window.createWebviewPanel(
                'sourcemetaStudio',
                'Sourcemeta Studio',
                {
                    viewColumn: columnToShowIn,
                    preserveFocus: false
                },
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            // Set the icon for the panel tab
            const iconPath = vscode.Uri.file(path.join(context.extensionPath, '..', 'assets', 'logo.svg'));
            currentPanel.iconPath = iconPath;

            // Handle messages from the webview
            currentPanel.webview.onDidReceiveMessage(
                message => {
                    if (message.command === 'goToPosition' && lastActiveTextEditor) {
                        const [lineStart, columnStart, lineEnd, columnEnd] = message.position;
                        // Position array is 1-based and inclusive, VS Code is 0-based and end-exclusive
                        const range = new vscode.Range(
                            new vscode.Position(lineStart - 1, columnStart - 1),
                            new vscode.Position(lineEnd - 1, columnEnd) // Don't subtract 1 from columnEnd
                        );

                        // Reveal the range in the editor
                        lastActiveTextEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);

                        // Select the range
                        lastActiveTextEditor.selection = new vscode.Selection(range.start, range.end);

                        // Focus the editor
                        vscode.window.showTextDocument(lastActiveTextEditor.document, lastActiveTextEditor.viewColumn);
                    } else if (message.command === 'formatSchema' && lastActiveTextEditor) {
                        // Run format command (without --check) to actually format the file
                        runFormatCommand(lastActiveTextEditor.document.uri.fsPath).then(() => {
                            // Reload the document to show formatted content
                            vscode.window.showTextDocument(lastActiveTextEditor.document, lastActiveTextEditor.viewColumn);
                            // Refresh the panel to update format status
                            updatePanelContent();
                        }).catch((error) => {
                            vscode.window.showErrorMessage(`Format failed: ${error.message}`);
                        });
                    }
                },
                undefined,
                context.subscriptions
            );

            updatePanelContent();

            currentPanel.onDidDispose(() => {
                currentPanel = undefined;
            }, null, context.subscriptions);
        }
    });

    // Listen for active editor changes
    const activeEditorChangeListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        // If a text document is opened in the same column as the webview panel, move it
        if (currentPanel && editor && editor.document.uri.scheme === 'file') {
            const panelColumn = currentPanel.viewColumn;
            const editorColumn = vscode.window.activeTextEditor?.viewColumn;

            if (panelColumn === editorColumn) {
                // Find a different column to move the editor to
                const targetColumn = panelColumn === vscode.ViewColumn.One
                    ? vscode.ViewColumn.Two
                    : vscode.ViewColumn.One;

                // Close the editor in the current column and reopen in the target column
                vscode.commands.executeCommand('workbench.action.closeActiveEditor').then(() => {
                    vscode.window.showTextDocument(editor.document, {
                        viewColumn: targetColumn,
                        preview: false
                    }).then(() => {
                        lastActiveTextEditor = vscode.window.activeTextEditor;
                    });
                });
            } else {
                // Normal case: just update the last active text editor
                lastActiveTextEditor = editor;
            }
        } else if (editor && editor.document.uri.scheme === 'file') {
            lastActiveTextEditor = editor;
        }

        if (currentPanel) {
            updatePanelContent();
        }
    });

    // Initialize with current active editor if one exists
    if (vscode.window.activeTextEditor) {
        lastActiveTextEditor = vscode.window.activeTextEditor;
    }

    // Listen for file save events
    const documentSaveListener = vscode.workspace.onDidSaveTextDocument((document) => {
        // Check if the saved document is the currently tracked file
        if (currentPanel && lastActiveTextEditor && document.uri.fsPath === lastActiveTextEditor.document.uri.fsPath) {
            const fileInfo = getFileInfo(document.uri.fsPath);
            // Only refresh if it's a JSON/YAML file
            if (fileInfo) {
                updatePanelContent();
            }
        }
    });

    context.subscriptions.push(openPanelCommand, activeEditorChangeListener, documentSaveListener);
}

function deactivate() {
    if (currentPanel) {
        currentPanel.dispose();
    }
}

function updatePanelContent() {
    if (!currentPanel) {
        return;
    }

    const filePath = lastActiveTextEditor?.document.uri.fsPath;
    const fileInfo = getFileInfo(filePath);

    // Update the HTML immediately with cached version and loading results
    currentPanel.webview.html = getHtmlContent(fileInfo, cachedVersion, { raw: 'Loading...', health: null }, { output: 'Loading...', exitCode: null }, { output: 'Loading...', exitCode: null });

    // Clear any existing diagnostics for the current file
    if (lastActiveTextEditor) {
        diagnosticCollection.delete(lastActiveTextEditor.document.uri);
    }

    // Run version, lint, format check, and metaschema commands
    Promise.all([
        getJsonSchemaVersion(),
        fileInfo ? runLintCommand(fileInfo.absolutePath) : Promise.resolve('No file selected'),
        fileInfo ? runFormatCheckCommand(fileInfo.absolutePath) : Promise.resolve({ output: 'No file selected', exitCode: null }),
        fileInfo ? runMetaschemaCommand(fileInfo.absolutePath) : Promise.resolve({ output: 'No file selected', exitCode: null })
    ]).then(([version, lintResult, formatResult, metaschemaResult]) => {
        cachedVersion = version;
        if (currentPanel) {
            const parsedLintResult = parseLintResult(lintResult);
            currentPanel.webview.html = getHtmlContent(fileInfo, cachedVersion, parsedLintResult, formatResult, metaschemaResult);

            // Update diagnostics if we have lint errors
            if (parsedLintResult.errors && parsedLintResult.errors.length > 0 && lastActiveTextEditor) {
                updateDiagnostics(lastActiveTextEditor.document.uri, parsedLintResult.errors);
            }
        }
    }).catch((error) => {
        cachedVersion = `Error: ${error.message}`;
        if (currentPanel) {
            currentPanel.webview.html = getHtmlContent(fileInfo, cachedVersion, { raw: `Error: ${error.message}`, health: null, error: true }, { output: `Error: ${error.message}`, exitCode: null }, { output: `Error: ${error.message}`, exitCode: null });
        }
    });
}

function updateDiagnostics(documentUri, errors) {
    const diagnostics = errors.map(error => {
        // Position array format: [lineStart, columnStart, lineEnd, columnEnd]
        // Position array is 1-based and inclusive, VS Code is 0-based and end-exclusive
        const [lineStart, columnStart, lineEnd, columnEnd] = error.position;

        const range = new vscode.Range(
            new vscode.Position(lineStart - 1, columnStart - 1),
            new vscode.Position(lineEnd - 1, columnEnd) // Don't subtract 1 from columnEnd
        );

        const diagnostic = new vscode.Diagnostic(
            range,
            error.message,
            vscode.DiagnosticSeverity.Warning
        );

        // Set the source
        diagnostic.source = 'Sourcemeta Studio';

        // Add error ID as code
        if (error.id) {
            diagnostic.code = error.id;
        }

        return diagnostic;
    });

    diagnosticCollection.set(documentUri, diagnostics);
}

function parseLintResult(lintOutput) {
    try {
        const parsed = JSON.parse(lintOutput);
        return {
            raw: lintOutput,
            health: parsed.health,
            valid: parsed.valid,
            errors: parsed.errors || []
        };
    } catch (error) {
        return {
            raw: lintOutput,
            health: null,
            error: true
        };
    }
}

function getFileInfo(filePath) {
    if (!filePath) {
        return null;
    }

    // Check if file is JSON or YAML
    const extension = path.extname(filePath).toLowerCase();
    const isValidFile = ['.json', '.yaml', '.yml'].includes(extension);

    if (!isValidFile) {
        return null;
    }

    // Get relative path if workspace folder exists
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let displayPath = filePath;

    if (workspaceFolders && workspaceFolders.length > 0) {
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        if (filePath.startsWith(workspaceRoot)) {
            displayPath = path.relative(workspaceRoot, filePath);
        }
    }

    return {
        absolutePath: filePath,
        displayPath: displayPath,
        fileName: path.basename(filePath)
    };
}

function getJsonSchemaVersion() {
    return new Promise((resolve, reject) => {
        const npxPath = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const child = spawn(npxPath, ['jsonschema', 'version'], {
            cwd: path.join(__dirname),
            shell: true
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(stderr || `Process exited with code ${code}`));
            }
        });

        child.on('error', (error) => {
            reject(error);
        });
    });
}

function runLintCommand(filePath) {
    return new Promise((resolve, reject) => {
        const npxPath = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const child = spawn(npxPath, ['jsonschema', 'lint', '--json', filePath], {
            cwd: path.join(__dirname),
            shell: true
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            // Lint command may exit with non-zero if there are lint issues
            // So we accept the output regardless of exit code
            resolve(stdout || stderr || 'No output');
        });

        child.on('error', (error) => {
            reject(error);
        });
    });
}

function runFormatCheckCommand(filePath) {
    return new Promise((resolve, reject) => {
        const npxPath = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const child = spawn(npxPath, ['jsonschema', 'fmt', '--check', filePath], {
            cwd: path.join(__dirname),
            shell: true
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            resolve({
                output: stdout || stderr || 'No output',
                exitCode: code
            });
        });

        child.on('error', (error) => {
            reject(error);
        });
    });
}

function runFormatCommand(filePath) {
    return new Promise((resolve, reject) => {
        const npxPath = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const child = spawn(npxPath, ['jsonschema', 'fmt', filePath], {
            cwd: path.join(__dirname),
            shell: true
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(stderr || `Process exited with code ${code}`));
            }
        });

        child.on('error', (error) => {
            reject(error);
        });
    });
}

function runMetaschemaCommand(filePath) {
    return new Promise((resolve, reject) => {
        const npxPath = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const child = spawn(npxPath, ['jsonschema', 'metaschema', '--json', filePath], {
            cwd: path.join(__dirname),
            shell: true
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('close', (code) => {
            resolve({
                output: stdout || stderr || 'No output',
                exitCode: code
            });
        });

        child.on('error', (error) => {
            reject(error);
        });
    });
}

function getHtmlContent(fileInfo, version, lintResult, formatResult, metaschemaResult) {
    const content = fileInfo
        ? `<div class="schema-info">
            <p class="schema-label">Current Schema</p>
            <p class="file-path">${fileInfo.displayPath}</p>
           </div>`
        : `<p class="no-file">Open a JSON Schema</p>`;

    const escapedLintResult = lintResult?.raw ? lintResult.raw.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'No results';
    const escapedFormatResult = formatResult?.output ? formatResult.output.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'No results';
    const escapedMetaschemaResult = metaschemaResult?.output ? metaschemaResult.output.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'No results';

    // Generate nicely formatted errors or success message
    let lintContentHtml = '';
    if (lintResult?.errors && lintResult.errors.length > 0) {
        // Render errors nicely
        const errorsHtml = lintResult.errors.map((error, index) => {
            const escapedMessage = error.message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const escapedDescription = error.description
                ? error.description.replace(/</g, '&lt;').replace(/>/g, '&gt;')
                : null;
            const escapedPath = error.path.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const escapedId = error.id.replace(/</g, '&lt;').replace(/>/g, '&gt;');

            // Encode position data for click handling
            const positionData = JSON.stringify(error.position);

            return `
                <div class="lint-error" data-error-index="${index}" data-position="${positionData}">
                    <div class="lint-error-header">
                        <span class="lint-error-message">${escapedMessage}</span>
                    </div>
                    ${escapedDescription ? `<div class="lint-error-description">${escapedDescription}</div>` : ''}
                    <div class="lint-error-meta">
                        <div class="lint-error-meta-item">
                            <span class="lint-error-meta-label">ID:</span>
                            <span class="lint-error-meta-value">${escapedId}</span>
                        </div>
                        <div class="lint-error-meta-item">
                            <span class="lint-error-meta-label">Location:</span>
                            <span class="lint-error-meta-value">${error.schemaLocation}</span>
                        </div>
                        <div class="lint-error-meta-item">
                            <span class="lint-error-meta-label">Position:</span>
                            <span class="lint-error-meta-value">Line ${error.position[0]}, Col ${error.position[1]}</span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        lintContentHtml = `
            <div class="lint-errors-container">
                ${errorsHtml}
            </div>
        `;
    } else if (lintResult?.valid === true || (lintResult?.errors && lintResult.errors.length === 0)) {
        // No errors - show success message
        lintContentHtml = `
            <div class="lint-success">
                <div class="lint-success-icon">✓</div>
                <div class="lint-success-message">No lint errors!</div>
                <div class="lint-success-subtitle">Your schema is looking great.</div>
            </div>
        `;
    }

    // Generate format content HTML
    let formatContentHtml = '';
    if (formatResult?.exitCode === 0) {
        // Format check passed - schema is properly formatted
        formatContentHtml = `
            <div class="lint-success">
                <div class="lint-success-icon">✓</div>
                <div class="lint-success-message">Schema is properly formatted!</div>
                <div class="lint-success-subtitle">No formatting changes needed.</div>
            </div>
        `;
    } else if (formatResult?.exitCode !== null && formatResult?.exitCode !== undefined) {
        // Format check failed - needs formatting
        formatContentHtml = `
            <div class="format-needs-formatting">
                <p class="format-message">This schema needs formatting.</p>
                <button class="format-button" onclick="formatSchema()">Format Schema</button>
            </div>
        `;
    }

    // Generate metaschema content HTML
    let metaschemaContentHtml = '';
    if (metaschemaResult?.exitCode === 0) {
        // Metaschema validation passed
        metaschemaContentHtml = `
            <div class="lint-success">
                <div class="lint-success-icon">✓</div>
                <div class="lint-success-message">Schema is valid according to its meta-schema!</div>
                <div class="lint-success-subtitle">No validation errors found.</div>
            </div>
        `;
    } else if (metaschemaResult?.exitCode === 2) {
        // Metaschema validation failed with errors
        metaschemaContentHtml = `
            <div class="metaschema-errors">
                <div class="code-block">
                    <pre>${escapedMetaschemaResult}</pre>
                </div>
            </div>
        `;
    } else if (metaschemaResult?.exitCode === 1) {
        // Fatal error
        metaschemaContentHtml = `
            <div class="metaschema-fatal">
                <div class="metaschema-fatal-icon">⚠</div>
                <div class="metaschema-fatal-message">Fatal Error</div>
                <div class="metaschema-fatal-subtitle">The metaschema command failed to execute.</div>
            </div>
        `;
    }

    // Determine lint status indicator and color
    let lintIndicator = '';
    let lintTabClass = '';
    let formatIndicator = '';
    let formatTabClass = '';
    let metaschemaIndicator = '';
    let metaschemaTabClass = '';
    let healthBarHtml = '';
    let healthBarColor = '';

    // Format tab indicator
    if (formatResult?.exitCode === 0) {
        formatIndicator = '✓';
        formatTabClass = 'tab-success';
    } else if (formatResult?.exitCode !== null && formatResult?.exitCode !== undefined) {
        formatIndicator = '⚠';
        formatTabClass = 'tab-warning';
    }

    // Metaschema tab indicator
    if (metaschemaResult?.exitCode === 0) {
        metaschemaIndicator = '✓';
        metaschemaTabClass = 'tab-success';
    } else if (metaschemaResult?.exitCode === 2) {
        metaschemaIndicator = '✗';
        metaschemaTabClass = 'tab-error';
    } else if (metaschemaResult?.exitCode === 1) {
        metaschemaIndicator = '⚠';
        metaschemaTabClass = 'tab-fatal';
    }

    if (lintResult?.error) {
        lintIndicator = '✗';
        lintTabClass = 'tab-error';
        // Show empty health bar with N/A
        healthBarHtml = `
            <div class="health-bar-container">
                <div class="health-bar-label">Health: N/A</div>
                <div class="health-bar-background">
                    <div class="health-bar-fill" style="width: 0%; background-color: #666;"></div>
                </div>
            </div>
        `;
    } else if (lintResult?.health !== null && lintResult?.health !== undefined) {
        const health = lintResult.health;

        // Tab indicator: green tick if 100, yellow if < 100, red if command failed
        if (health === 100) {
            lintIndicator = '✓';
            lintTabClass = 'tab-success';
        } else {
            lintIndicator = '⚠';
            lintTabClass = 'tab-warning';
        }

        // Health bar color based on ranges
        if (health > 90) {
            healthBarColor = '#4caf50'; // Green
        } else if (health > 60) {
            healthBarColor = '#ff9800'; // Orange
        } else {
            healthBarColor = '#f44336'; // Red
        }

        healthBarHtml = `
            <div class="health-bar-container">
                <div class="health-bar-label">Health: ${health}%</div>
                <div class="health-bar-background">
                    <div class="health-bar-fill" style="width: ${health}%; background-color: ${healthBarColor};"></div>
                </div>
            </div>
        `;
    } else {
        // No file selected or not a valid schema
        healthBarHtml = `
            <div class="health-bar-container">
                <div class="health-bar-label">Health: N/A</div>
                <div class="health-bar-background">
                    <div class="health-bar-fill" style="width: 0%; background-color: #666;"></div>
                </div>
            </div>
        `;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sourcemeta Studio</title>
    <style>
        body {
            padding: 20px;
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            display: flex;
            flex-direction: column;
            height: calc(100vh - 40px);
        }
        h1 {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 16px;
        }
        .schema-info {
            margin-bottom: 20px;
            padding: 12px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            border-left: 3px solid var(--vscode-focusBorder);
        }
        .schema-label {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin: 0 0 6px 0;
            font-weight: 600;
        }
        .file-path {
            color: var(--vscode-foreground);
            font-size: 13px;
            word-break: break-all;
            margin: 0;
            font-family: var(--vscode-editor-font-family);
        }
        .no-file {
            color: var(--vscode-descriptionForeground);
            font-size: 14px;
            font-style: italic;
            margin: 0;
            margin-bottom: 20px;
        }
        .actions {
            margin-bottom: 20px;
        }
        .button {
            padding: 6px 14px;
            cursor: pointer;
            border: 1px solid var(--vscode-button-border);
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-family: var(--vscode-font-family);
            font-size: 13px;
            border-radius: 2px;
        }
        .button:hover:not(:disabled) {
            background: var(--vscode-button-hoverBackground);
        }
        .button:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        .tabs {
            display: flex;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 20px;
        }
        .tab {
            padding: 8px 16px;
            cursor: pointer;
            border: none;
            background: none;
            color: var(--vscode-descriptionForeground);
            font-family: var(--vscode-font-family);
            font-size: 13px;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .tab:hover {
            color: var(--vscode-foreground);
        }
        .tab.active {
            color: var(--vscode-foreground);
            border-bottom-color: var(--vscode-focusBorder);
        }
        .tab-indicator {
            font-size: 14px;
            font-weight: bold;
        }
        .tab-success .tab-indicator {
            color: #4caf50;
        }
        .tab-warning .tab-indicator {
            color: #ff9800;
        }
        .tab-error .tab-indicator {
            color: #f44336;
        }
        .tab-fatal .tab-indicator {
            color: #9c27b0;
        }
        .health-bar-container {
            margin-bottom: 20px;
        }
        .health-bar-label {
            color: var(--vscode-foreground);
            font-size: 12px;
            margin-bottom: 6px;
            font-weight: 600;
        }
        .health-bar-background {
            width: 100%;
            height: 8px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            overflow: hidden;
        }
        .health-bar-fill {
            height: 100%;
            transition: width 0.3s ease;
            border-radius: 4px;
        }
        .tab-content {
            flex: 1;
            overflow-y: auto;
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        .lint-success {
            text-align: center;
            padding: 40px 20px;
        }
        .lint-success-icon {
            font-size: 48px;
            color: #4caf50;
            margin-bottom: 16px;
        }
        .lint-success-message {
            font-size: 18px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin-bottom: 8px;
        }
        .lint-success-subtitle {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        .lint-errors-container {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 20px;
        }
        .lint-error {
            background: var(--vscode-editor-inactiveSelectionBackground);
            border-left: 3px solid #ff9800;
            border-radius: 4px;
            padding: 12px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .lint-error:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .lint-error-header {
            margin-bottom: 8px;
        }
        .lint-error-message {
            color: var(--vscode-foreground);
            font-size: 13px;
            font-weight: 600;
        }
        .lint-error-description {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            margin-bottom: 8px;
            white-space: pre-wrap;
            font-family: var(--vscode-editor-font-family);
        }
        .lint-error-meta {
            display: flex;
            flex-direction: column;
            gap: 4px;
            font-size: 11px;
        }
        .lint-error-meta-item {
            display: flex;
            gap: 6px;
        }
        .lint-error-meta-label {
            color: var(--vscode-descriptionForeground);
            font-weight: 600;
            min-width: 60px;
        }
        .lint-error-meta-value {
            color: var(--vscode-foreground);
            font-family: var(--vscode-editor-font-family);
        }
        .code-block {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 12px;
            overflow-x: auto;
        }
        .code-block pre {
            margin: 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            color: var(--vscode-editor-foreground);
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .raw-output-section {
            margin-top: 20px;
        }
        .raw-output-header {
            display: flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
            padding: 8px 0;
            user-select: none;
        }
        .raw-output-header:hover {
            opacity: 0.8;
        }
        .raw-output-toggle {
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            transition: transform 0.2s;
        }
        .raw-output-toggle.expanded {
            transform: rotate(90deg);
        }
        .raw-output-label {
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-weight: 600;
        }
        .raw-output-content {
            display: none;
            margin-top: 8px;
        }
        .raw-output-content.expanded {
            display: block;
        }
        .raw-output-content .code-block pre {
            font-size: 10px;
        }
        .format-needs-formatting {
            text-align: center;
            padding: 40px 20px;
        }
        .format-message {
            color: var(--vscode-foreground);
            font-size: 14px;
            margin-bottom: 20px;
        }
        .format-button {
            padding: 10px 24px;
            cursor: pointer;
            border: 1px solid var(--vscode-button-border);
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-family: var(--vscode-font-family);
            font-size: 14px;
            border-radius: 2px;
            font-weight: 600;
        }
        .format-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .metaschema-fatal {
            text-align: center;
            padding: 40px 20px;
        }
        .metaschema-fatal-icon {
            font-size: 48px;
            color: #9c27b0;
            margin-bottom: 16px;
        }
        .metaschema-fatal-message {
            font-size: 18px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin-bottom: 8px;
        }
        .metaschema-fatal-subtitle {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        .metaschema-errors {
            margin-bottom: 20px;
        }
        .footer {
            margin-top: auto;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .version {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            margin: 0;
        }
    </style>
</head>
<body>
    <div>
        ${content}
        ${healthBarHtml}
        <div class="tabs">
            <button class="tab active ${lintTabClass}" data-tab="lint">
                ${lintIndicator ? `<span class="tab-indicator">${lintIndicator}</span>` : ''}
                <span>Lint</span>
            </button>
            <button class="tab ${formatTabClass}" data-tab="format">
                ${formatIndicator ? `<span class="tab-indicator">${formatIndicator}</span>` : ''}
                <span>Format</span>
            </button>
            <button class="tab ${metaschemaTabClass}" data-tab="metaschema">
                ${metaschemaIndicator ? `<span class="tab-indicator">${metaschemaIndicator}</span>` : ''}
                <span>Metaschema</span>
            </button>
        </div>
        <div class="tab-content active" id="lint-content">
            ${lintContentHtml}
            <div class="raw-output-section">
                <div class="raw-output-header" onclick="toggleRawOutput('lint')">
                    <span class="raw-output-toggle" id="lint-raw-toggle">▶</span>
                    <span class="raw-output-label">Raw Output</span>
                </div>
                <div class="raw-output-content" id="lint-raw-output-content">
                    <div class="code-block">
                        <pre>${escapedLintResult}</pre>
                    </div>
                </div>
            </div>
        </div>
        <div class="tab-content" id="format-content">
            ${formatContentHtml}
            <div class="raw-output-section">
                <div class="raw-output-header" onclick="toggleRawOutput('format')">
                    <span class="raw-output-toggle" id="format-raw-toggle">▶</span>
                    <span class="raw-output-label">Raw Output</span>
                </div>
                <div class="raw-output-content" id="format-raw-output-content">
                    <div class="code-block">
                        <pre>${escapedFormatResult}</pre>
                    </div>
                </div>
            </div>
        </div>
        <div class="tab-content" id="metaschema-content">
            ${metaschemaContentHtml}
            <div class="raw-output-section">
                <div class="raw-output-header" onclick="toggleRawOutput('metaschema')">
                    <span class="raw-output-toggle" id="metaschema-raw-toggle">▶</span>
                    <span class="raw-output-label">Raw Output</span>
                </div>
                <div class="raw-output-content" id="metaschema-raw-output-content">
                    <div class="code-block">
                        <pre>${escapedMetaschemaResult}</pre>
                    </div>
                </div>
            </div>
        </div>
    </div>
    <div class="footer">
        <p class="version">${version}</p>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const state = vscode.getState() || { activeTab: 'lint' };

        const tabs = document.querySelectorAll('.tab');
        const tabContents = document.querySelectorAll('.tab-content');

        // Restore last active tab
        if (state.activeTab) {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));

            const activeTab = document.querySelector(\`[data-tab="\${state.activeTab}"]\`);
            const activeContent = document.getElementById(state.activeTab + '-content');
            if (activeTab && activeContent) {
                activeTab.classList.add('active');
                activeContent.classList.add('active');
            }
        }

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                // Remove active class from all tabs and contents
                tabs.forEach(t => t.classList.remove('active'));
                tabContents.forEach(tc => tc.classList.remove('active'));

                // Add active class to clicked tab
                tab.classList.add('active');

                // Show corresponding content
                const tabName = tab.getAttribute('data-tab');
                const content = document.getElementById(tabName + '-content');
                if (content) {
                    content.classList.add('active');
                }

                // Save active tab to state
                vscode.setState({ ...state, activeTab: tabName });
            });
        });

        // Handle lint error clicks - use event delegation to ensure handlers work
        document.addEventListener('click', (event) => {
            const errorElement = event.target.closest('.lint-error');
            if (errorElement) {
                const positionData = errorElement.getAttribute('data-position');
                if (positionData) {
                    const position = JSON.parse(positionData);
                    vscode.postMessage({
                        command: 'goToPosition',
                        position: position
                    });
                }
            }
        });

        // Toggle raw output
        function toggleRawOutput(tab) {
            const content = document.getElementById(tab + '-raw-output-content');
            const toggle = document.getElementById(tab + '-raw-toggle');
            content.classList.toggle('expanded');
            toggle.classList.toggle('expanded');
        }

        // Format schema
        function formatSchema() {
            vscode.postMessage({
                command: 'formatSchema'
            });
        }
    </script>
</body>
</html>`;
}

module.exports = {
    activate,
    deactivate
};
