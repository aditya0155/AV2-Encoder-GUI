import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { startEncoding, cancelEncoding, getStatus, resetJobStatus } from './encoder.js';

const app = express();
const port = 5000;

app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// WebSocket connection for real-time progress and logging
export let wsClient = null;
wss.on('connection', (ws) => {
  wsClient = ws;
  console.log('Frontend client connected via WebSocket');
  
  // Send current status immediately upon connection
  ws.send(JSON.stringify({ type: 'status', status: getStatus() }));

  ws.on('close', () => {
    wsClient = null;
    console.log('Frontend client disconnected');
  });
});

// Broadcast helper
export function broadcast(data) {
  if (wsClient && wsClient.readyState === 1) {
    wsClient.send(JSON.stringify(data));
  }
}

// Helper: Run PowerShell script in STA mode with ExecutionPolicy Bypass using EncodedCommand
function runPowerShellDialog(script, callback) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', encoded]);
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });

  child.on('close', (code) => {
    if (code !== 0) {
      callback(new Error(stderr || 'PowerShell exited with code ' + code), null);
    } else {
      callback(null, stdout.trim());
    }
  });
}

// API: Trigger native Windows Open File Dialog in STA mode
app.post('/api/select-input-file', (req, res) => {
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $f = New-Object System.Windows.Forms.OpenFileDialog
    $f.Filter = "Video Files (*.mp4;*.mkv;*.avi;*.mov;*.y4m;*.yuv)|*.mp4;*.mkv;*.avi;*.mov;*.y4m;*.yuv|All Files (*.*)|*.*"
    $f.Title = "Select Input Video"
    $result = $f.ShowDialog()
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
      $f.FileName
    }
  `;

  runPowerShellDialog(psScript, (err, filePath) => {
    if (err) {
      console.error('File dialog error:', err);
      return res.status(500).json({ error: 'Failed to open file picker: ' + err.message });
    }
    res.json({ filePath: filePath || '' });
  });
});

// API: Trigger native Windows Save File Dialog in STA mode
app.post('/api/select-output-file', (req, res) => {
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $f = New-Object System.Windows.Forms.SaveFileDialog
    $f.Filter = "WebM Video (*.webm)|*.webm|Matroska Video (*.mkv)|*.mkv"
    $f.Title = "Save Encoded Video As"
    $f.FileName = "output.webm"
    $result = $f.ShowDialog()
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
      $f.FileName
    }
  `;

  runPowerShellDialog(psScript, (err, filePath) => {
    if (err) {
      console.error('Save dialog error:', err);
      return res.status(500).json({ error: 'Failed to open save picker: ' + err.message });
    }
    res.json({ filePath: filePath || '' });
  });
});

// API: Get home directory
app.get('/api/home-dir', (req, res) => {
  res.json({ homeDir: os.homedir() });
});

// API: Get system info
app.get('/api/sys-info', (req, res) => {
  res.json({ cpus: os.cpus().length });
});

// API: List directory contents for the custom web-based file picker
app.get('/api/list-dir', (req, res) => {
  let dirPath = req.query.path || os.homedir();
  
  // Resolve standard windows shortcuts like ~
  if (dirPath.startsWith('~')) {
    dirPath = path.join(os.homedir(), dirPath.substring(1));
  }

  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = [];
    
    // Add parent directory option if we are not at drive root
    const parentDir = path.dirname(dirPath);
    if (parentDir && parentDir !== dirPath) {
      result.push({ name: '..', isDirectory: true, path: parentDir });
    }

    for (const file of files) {
      // Skip hidden files/directories
      if (file.name.startsWith('.')) continue;
      
      try {
        result.push({
          name: file.name,
          isDirectory: file.isDirectory(),
          path: path.join(dirPath, file.name)
        });
      } catch (e) {
        // Skip files that throw errors (e.g. system files with permission issues)
      }
    }
    
    // Sort: directories first, then files alphabetically
    result.sort((a, b) => {
      if (a.name === '..') return -1;
      if (b.name === '..') return 1;
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ currentDir: dirPath, contents: result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read directory: ' + err.message });
  }
});

// API: Start encoding job
app.post('/api/start-encode', (req, res) => {
  const { inputFile, outputFile, qp, speed, audioMode, audioBitrate, limitFrames, resolutionScale, workers } = req.body;
  if (!inputFile || !outputFile) {
    return res.status(400).json({ error: 'Input and output files are required.' });
  }

  const result = startEncoding({ inputFile, outputFile, qp, speed, audioMode, audioBitrate, limitFrames, resolutionScale, workers });
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ status: 'started' });
});

// API: Cancel active encode
app.post('/api/cancel-encode', (req, res) => {
  cancelEncoding();
  res.json({ status: 'cancelled' });
});

// API: Reset job status
app.post('/api/reset-status', (req, res) => {
  resetJobStatus();
  res.json({ status: 'idle' });
});

// API: Get current status
app.get('/api/status', (req, res) => {
  res.json(getStatus());
});

server.listen(port, () => {
  console.log(`AV2 GUI Backend running at http://localhost:${port}`);
});
