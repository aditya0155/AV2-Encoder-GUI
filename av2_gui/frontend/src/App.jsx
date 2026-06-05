import React, { useState, useEffect, useRef } from 'react';

const PRESET_NAMES = {
  0: 'Placebo',
  1: 'Very Slow',
  2: 'Slower',
  3: 'Slow',
  4: 'Medium',
  5: 'Fast',
  6: 'Faster',
  7: 'Very Fast',
  8: 'Super Fast',
  9: 'Ultra Fast'
};

export default function App() {
  const [inputFile, setInputFile] = useState('');
  const [outputFile, setOutputFile] = useState('');
  const [qp, setQp] = useState(45); // default QP (0-255 range, 40-50 is good)
  const [speed, setSpeed] = useState(8); // default speed (8 is fast for testing)
  const [audioMode, setAudioMode] = useState('copy'); // 'copy', 'opus', 'none'
  const [audioBitrate, setAudioBitrate] = useState(128); // default audio bitrate (64-320 kbps)
  const [activeTab, setActiveTab] = useState('video'); // 'video', 'audio', 'container', 'about'
  const [isConnecting, setIsConnecting] = useState(true);
  const [limitFrames, setLimitFrames] = useState(0); // 0 or empty means no limit
  const [resolutionScale, setResolutionScale] = useState('original'); // 'original', '1080p', '720p', '480p', '360p', '240p'
  const [workers, setWorkers] = useState(16); // default parallel workers count
  const [maxCpus, setMaxCpus] = useState(16); // dynamic maximum based on system info

  
  // Fallback Web File Explorer States
  const [isExplorerOpen, setIsExplorerOpen] = useState(false);
  const [explorerType, setExplorerType] = useState('input'); // 'input' or 'output'
  const [explorerCurrentDir, setExplorerCurrentDir] = useState('');
  const [explorerContents, setExplorerContents] = useState([]);
  const [explorerInputFileName, setExplorerInputFileName] = useState('');
  const [explorerError, setExplorerError] = useState(null);

  const [jobStatus, setJobStatus] = useState({
    status: 'idle',
    progress: 0,
    currentFrame: 0,
    totalFrames: 0,
    fps: 0,
    eta: 'N/A',
    logs: [],
    error: null
  });

  const consoleEndRef = useRef(null);
  const wsRef = useRef(null);

  // Connect to local backend WebSocket and fetch system CPU count
  useEffect(() => {
    connectWebSocket();
    
    // Fetch CPU core count to dynamically adjust slider and default workers
    fetch('http://localhost:5000/api/sys-info')
      .then(res => res.json())
      .then(data => {
        if (data && data.cpus) {
          const cores = parseInt(data.cpus) || 16;
          setMaxCpus(cores);
          setWorkers(cores);
        }
      })
      .catch(err => console.error('Failed to fetch system info:', err));

    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [jobStatus.logs]);

  const connectWebSocket = () => {
    setIsConnecting(true);
    const ws = new WebSocket('ws://localhost:5000');
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnecting(false);
      console.log('Connected to backend WebSocket');
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'status') {
        setJobStatus(data.status);
      } else if (data.type === 'log') {
        setJobStatus((prev) => ({
          ...prev,
          logs: [...prev.logs, data.log]
        }));
      }
    };

    ws.onclose = () => {
      setIsConnecting(true);
      console.log('WebSocket disconnected. Reconnecting in 3s...');
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      ws.close();
    };
  };

  const openExplorer = async (type) => {
    setExplorerType(type);
    setIsExplorerOpen(true);
    setExplorerError(null);
    if (type === 'output') {
      if (outputFile) {
        const lastSep = Math.max(outputFile.lastIndexOf('/'), outputFile.lastIndexOf('\\'));
        if (lastSep !== -1) {
          setExplorerInputFileName(outputFile.substring(lastSep + 1));
        } else {
          setExplorerInputFileName(outputFile);
        }
      } else {
        setExplorerInputFileName('output.mkv');
      }
    }

    try {
      let startingDir = '';
      const existingFile = type === 'input' ? inputFile : outputFile;
      if (existingFile) {
        const lastSep = Math.max(existingFile.lastIndexOf('/'), existingFile.lastIndexOf('\\'));
        if (lastSep !== -1) {
          startingDir = existingFile.substring(0, lastSep);
        }
      }

      if (!startingDir) {
        const response = await fetch('http://localhost:5000/api/home-dir');
        const data = await response.json();
        startingDir = data.homeDir;
      }

      await fetchDirContents(startingDir);
    } catch (err) {
      console.error(err);
      setExplorerError('Failed to load home directory.');
    }
  };

  const fetchDirContents = async (dirPath) => {
    setExplorerError(null);
    try {
      const response = await fetch(`http://localhost:5000/api/list-dir?path=${encodeURIComponent(dirPath)}`);
      const data = await response.json();
      if (data.error) {
        setExplorerError(data.error);
      } else {
        setExplorerCurrentDir(data.currentDir);
        setExplorerContents(data.contents || []);
      }
    } catch (err) {
      console.error(err);
      setExplorerError('Failed to read directory.');
    }
  };

  const handleExplorerRowClick = (item) => {
    if (item.isDirectory) {
      fetchDirContents(item.path);
    } else {
      if (explorerType === 'input') {
        setInputFile(item.path);
        if (['completed', 'failed', 'cancelled'].includes(jobStatus.status)) {
          resetStatus();
        }
        if (!outputFile) {
          const lastDot = item.path.lastIndexOf('.');
          const suggested = (lastDot !== -1 ? item.path.substring(0, lastDot) : item.path) + '_encoded.mkv';
          setOutputFile(suggested);
        }
        setIsExplorerOpen(false);
      } else {
        setExplorerInputFileName(item.name);
      }
    }
  };

  const handleConfirmExplorerSave = () => {
    if (!explorerInputFileName.trim()) {
      alert('Please enter a valid file name.');
      return;
    }
    const sep = explorerCurrentDir.includes('/') ? '/' : '\\';
    const fullPath = explorerCurrentDir.endsWith(sep)
      ? (explorerCurrentDir + explorerInputFileName.trim())
      : (explorerCurrentDir + sep + explorerInputFileName.trim());
    
    setOutputFile(fullPath);
    if (['completed', 'failed', 'cancelled'].includes(jobStatus.status)) {
      resetStatus();
    }
    setIsExplorerOpen(false);
  };

  const selectFile = async (type) => {
    try {
      const endpoint = type === 'input' ? '/api/select-input-file' : '/api/select-output-file';
      const response = await fetch(`http://localhost:5000${endpoint}`, { method: 'POST' });
      const data = await response.json();
      
      if (data.error) {
        console.warn('Native picker error:', data.error);
        openExplorer(type);
        return;
      }

      if (type === 'input' && data.filePath) {
        setInputFile(data.filePath);
        if (['completed', 'failed', 'cancelled'].includes(jobStatus.status)) {
          resetStatus();
        }
        // Automatically suggest output path
        if (!outputFile) {
          const lastDot = data.filePath.lastIndexOf('.');
          const suggested = (lastDot !== -1 ? data.filePath.substring(0, lastDot) : data.filePath) + '_encoded.mkv';
          setOutputFile(suggested);
        }
      } else if (type === 'output' && data.filePath) {
        setOutputFile(data.filePath);
        if (['completed', 'failed', 'cancelled'].includes(jobStatus.status)) {
          resetStatus();
        }
      }
    } catch (e) {
      console.error(e);
      alert('Failed to connect to backend server. Make sure the backend is running.');
    }
  };

  const startEncode = async () => {
    if (!inputFile) return alert('Please select an input video file.');
    if (!outputFile) return alert('Please specify an output location.');

    try {
      const response = await fetch('http://localhost:5000/api/start-encode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputFile, outputFile, qp, speed, audioMode, audioBitrate, limitFrames, resolutionScale, workers })
      });
      const data = await response.json();
      if (data.error) {
        alert(data.error);
      }
    } catch (e) {
      console.error(e);
      alert('Failed to start encoding.');
    }
  };

  const cancelEncode = async () => {
    try {
      await fetch('http://localhost:5000/api/cancel-encode', { method: 'POST' });
    } catch (e) {
      console.error(e);
    }
  };

  const resetStatus = async () => {
    try {
      await fetch('http://localhost:5000/api/reset-status', { method: 'POST' });
    } catch (e) {
      console.error(e);
    }
  };

  const clearLogs = () => {
    setJobStatus((prev) => ({ ...prev, logs: [] }));
  };

  // SVG Circular progress math
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const progressNum = parseFloat(jobStatus.progress) || 0;
  const strokeDashoffset = circumference - (progressNum / 100) * circumference;

  const isEncoding = ['preparing', 'encoding', 'muxing'].includes(jobStatus.status);

  // Status mapping UI helper
  const getStatusBadge = () => {
    switch (jobStatus.status) {
      case 'idle':
        return <span style={{ color: 'var(--text-low)' }}>● Idle</span>;
      case 'preparing':
        return <span style={{ color: 'var(--accent-cyan)', animation: 'pulse 1.5s infinite' }}>● Converting to Y4M</span>;
      case 'encoding':
        return <span style={{ color: 'var(--accent-purple)', animation: 'pulse 1.5s infinite' }}>● Encoding AV2</span>;
      case 'muxing':
        return <span style={{ color: 'var(--accent-blue)', animation: 'pulse 1.5s infinite' }}>● Muxing Audio</span>;
      case 'completed':
        return <span style={{ color: 'var(--accent-emerald)' }}>● Completed</span>;
      case 'cancelled':
        return <span style={{ color: 'var(--text-low)' }}>● Cancelled</span>;
      case 'failed':
        return <span style={{ color: 'var(--accent-rose)' }}>● Failed</span>;
      default:
        return null;
    }
  };

  return (
    <div className="app-container">
      {/* Header bar */}
      <header className="panel header-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img src="/av2_logo.png" alt="AV2" style={{ height: '36px', flexShrink: 0 }} />
          <div>
            <h1 style={{ margin: 0, fontSize: '18px', fontWeight: '800', letterSpacing: '0.5px' }}>AV2 TRANSCODER</h1>
            <span style={{ fontSize: '11px', color: 'var(--text-low)', fontWeight: 'bold' }}>AOMEDIA REFERENCE FRONTEND</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {isConnecting ? (
            <span style={{ fontSize: '12px', color: 'var(--accent-rose)', animation: 'pulse 1s infinite' }}>
              Connection Lost. Reconnecting...
            </span>
          ) : (
            <span style={{ fontSize: '12px', color: 'var(--accent-emerald)' }}>
              Server Connected
            </span>
          )}
          <div className="btn" style={{ cursor: 'default', background: 'rgba(255,255,255,0.02)' }}>
            {getStatusBadge()}
          </div>
        </div>
      </header>

      {/* Main Grid */}
      <main className="main-content">
        {/* Left Side Panel - Input & Progress */}
        <section className="sidebar">
          {/* File Picker Panel */}
          <div className="panel" style={{ padding: '20px' }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '15px' }}>Media Selection</h3>
            
            {/* Input Selection */}
            <div className="form-group">
              <span className="form-label">Source Video File</span>
              <div className="file-card">
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px', flex: 1 }} title={inputFile}>
                  {inputFile ? (
                    <span style={{ color: 'var(--text-high)', fontSize: '13px' }}>
                      {inputFile.split('\\').pop().split('/').pop()}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-low)', fontSize: '13px' }}>No video selected</span>
                  )}
                </div>
                <button className="btn" disabled={isEncoding} onClick={() => selectFile('input')} title="Browse for source video file">
                  Browse
                </button>
              </div>
            </div>

            {/* Output Selection */}
            <div className="form-group" style={{ marginBottom: 0 }}>
              <span className="form-label">Destination File Path</span>
              <div className="file-card">
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '8px', flex: 1 }} title={outputFile}>
                  {outputFile ? (
                    <span style={{ color: 'var(--text-high)', fontSize: '13px' }}>
                      {outputFile.split('\\').pop().split('/').pop()}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-low)', fontSize: '13px' }}>No output path set</span>
                  )}
                </div>
                <button className="btn" disabled={isEncoding} onClick={() => selectFile('output')} title="Specify output video location">
                  Save As
                </button>
              </div>
            </div>
          </div>

          {/* Progress Circle & Stats */}
          <div className="panel panel-glowing" style={{ padding: '24px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '15px', textAlign: 'center' }}>Encoding Progress</h3>
            
            {/* Radial gauge */}
            <div className="progress-circle-container">
              <svg width="130" height="130" viewBox="0 0 130 130">
                <circle cx="65" cy="65" r={radius} fill="transparent" stroke="rgba(255,255,255,0.03)" strokeWidth="6" />
                <circle cx="65" cy="65" r={radius} fill="transparent" stroke="url(#glowGradient)" strokeWidth="7"
                        strokeDasharray={circumference} strokeDashoffset={strokeDashoffset} strokeLinecap="round"
                        transform="rotate(-90 65 65)" style={{ transition: 'stroke-dashoffset 0.3s ease' }} />
                <defs>
                  <linearGradient id="glowGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="var(--accent-purple)" />
                    <stop offset="100%" stopColor="var(--accent-blue)" />
                  </linearGradient>
                </defs>
              </svg>
              
              <div className="progress-circle-text">
                <span className="progress-pct">{jobStatus.progress}%</span>
                <span className="progress-label">{jobStatus.status}</span>
              </div>
            </div>

            {/* Stats list */}
            <div className="stats-list" style={{ marginTop: '16px' }}>
              <div className="stat-item">
                <span className="stat-lbl">FPS (Speed)</span>
                <span className="stat-val" style={{ color: 'var(--accent-cyan)' }}>{jobStatus.fps}</span>
              </div>
              <div className="stat-item">
                <span className="stat-lbl">ETA</span>
                <span className="stat-val" style={{ color: 'var(--accent-purple)' }}>{jobStatus.eta}</span>
              </div>
              <div className="stat-item" style={{ gridColumn: 'span 2' }}>
                <span className="stat-lbl">Frames Processed</span>
                <span className="stat-val">
                  {jobStatus.currentFrame} / {jobStatus.totalFrames}
                </span>
              </div>
            </div>

            {/* Action buttons */}
            <div style={{ marginTop: '24px', display: 'grid', gridTemplateColumns: '1fr', gap: '12px' }}>
              {!isEncoding ? (
                <>
                  <button className="btn btn-primary" style={{ padding: '12px' }} onClick={startEncode} disabled={!inputFile || !outputFile}>
                    ▶ Start Encode
                  </button>
                  {['completed', 'failed', 'cancelled'].includes(jobStatus.status) && (
                    <button className="btn" style={{ padding: '12px' }} onClick={resetStatus}>
                      New Encoding Job
                    </button>
                  )}
                </>
              ) : (
                <button className="btn btn-danger" style={{ padding: '12px' }} onClick={cancelEncode}>
                  ■ Abort Encode
                </button>
              )}
            </div>
          </div>
        </section>

        {/* Right Side Workspace - Options & Log */}
        <section className="workspace">
          {/* Settings Tabs Panel */}
          <div className="panel tabs-container">
            <nav className="tab-headers">
              <button className={`tab-btn ${activeTab === 'video' ? 'active' : ''}`} onClick={() => setActiveTab('video')}>
                Video Codec (AV2)
              </button>
              <button className={`tab-btn ${activeTab === 'audio' ? 'active' : ''}`} onClick={() => setActiveTab('audio')}>
                Audio Stream
              </button>
              <button className={`tab-btn ${activeTab === 'container' ? 'active' : ''}`} onClick={() => setActiveTab('container')}>
                Container Format
              </button>
              <button className={`tab-btn ${activeTab === 'about' ? 'active' : ''}`} onClick={() => setActiveTab('about')}>
                About AV2
              </button>
            </nav>

            <div className="tab-content">
              {/* VIDEO SETTINGS TAB */}
              {activeTab === 'video' && (
                <div>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Video Compression Settings</h4>
                  <p style={{ margin: '0 0 24px 0', fontSize: '13px', color: 'var(--text-medium)' }}>
                    Configure the AVM (AV2 Reference Software) encoder parameters. Note that AV2 is extremely slow and requires high CPU speed settings for reasonable encoding times.
                  </p>

                  {/* QP Slider */}
                  <div className="form-group">
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <span className="form-label" style={{ margin: 0 }}>Constant Quality (Quantizer / QP)</span>
                      <span style={{ fontSize: '14px', fontWeight: 'bold', color: 'var(--accent-purple)' }}>{qp}</span>
                    </div>
                    <div className="slider-container">
                      <input type="range" className="slider" min="0" max="255" value={qp} onChange={(e) => setQp(parseInt(e.target.value))} disabled={isEncoding} />
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--text-low)', display: 'block', marginTop: '6px' }}>
                      Range: 0-255. Lower values yield higher quality and larger file sizes. Recommended values for testing: 40-55.
                    </span>
                  </div>

                  {/* CPU Used / Speed Slider */}
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <span className="form-label" style={{ margin: 0 }}>Encoder Speed Preset</span>
                      <span style={{ fontSize: '14px', fontWeight: 'bold', color: 'var(--accent-cyan)' }}>
                        {PRESET_NAMES[speed]} ({speed})
                      </span>
                    </div>
                    <div className="slider-container">
                      <input type="range" className="slider" min="0" max="9" value={speed} onChange={(e) => setSpeed(parseInt(e.target.value))} disabled={isEncoding} />
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--text-low)', display: 'block', marginTop: '6px' }}>
                      Presets: 0 (Placebo / Slowest) to 9 (Ultra Fast / Fastest). Higher values increase encoding speed. Preset 8 (Super Fast) or 9 (Ultra Fast) is highly recommended for Windows builds to avoid excessive encoding times.
                    </span>
                  </div>

                  {/* Limit Frames Input */}
                  <div className="form-group" style={{ marginTop: '20px' }}>
                    <span className="form-label">Limit Frames (For quick testing)</span>
                    <input 
                      type="number" 
                      className="input-text" 
                      min="0" 
                      value={limitFrames || ''} 
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        setLimitFrames(isNaN(val) ? 0 : val);
                      }}
                      placeholder="e.g. 50 (Leave blank or 0 to encode entire video)" 
                      disabled={isEncoding}
                    />
                    <span style={{ fontSize: '11px', color: 'var(--text-low)', display: 'block', marginTop: '6px' }}>
                      Specifies how many frames to encode before stopping. Extremely helpful for testing 1080p source videos (e.g. set to 20 or 50 frames).
                    </span>
                  </div>

                  {/* Resolution Scaling Dropdown */}
                  <div className="form-group" style={{ marginTop: '20px', marginBottom: 0 }}>
                    <span className="form-label">Downscale Video (For testing speedup)</span>
                    <div className="select-wrapper">
                      <select 
                        className="select-input" 
                        value={resolutionScale} 
                        onChange={(e) => setResolutionScale(e.target.value)}
                        disabled={isEncoding}
                      >
                        <option value="original">Original Source Resolution (No Scaling)</option>
                        <option value="1080p">1080p Full HD (1920x1080)</option>
                        <option value="720p">720p HD (1280x720)</option>
                        <option value="480p">480p SD (854x480)</option>
                        <option value="360p">360p Web (640x360)</option>
                        <option value="240p">240p Mobile (426x240) - Extremely Fast!</option>
                      </select>
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--text-low)', display: 'block', marginTop: '6px' }}>
                      Scaling down to 240p or 360p runs up to **27x faster** because reference AV2 encoding time scales quadratically with pixels. Excellent for fast verification!
                    </span>
                  </div>

                  {/* Parallel Workers Slider */}
                  <div className="form-group" style={{ marginTop: '20px', marginBottom: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <span className="form-label" style={{ margin: 0 }}>CPU Thread Target</span>
                      <span style={{ fontSize: '14px', fontWeight: 'bold', color: 'var(--accent-cyan)' }}>{workers} threads</span>
                    </div>
                    <div className="slider-container">
                      <input type="range" className="slider" min="1" max={Math.max(16, maxCpus)} value={workers} onChange={(e) => setWorkers(parseInt(e.target.value))} disabled={isEncoding} />
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--text-low)', display: 'block', marginTop: '6px' }}>
                      Targets this many logical CPU threads. The backend will use a small number of AVM processes with multiple threads each to reduce crashes and improve CPU use.
                    </span>
                  </div>
                </div>
              )}

              {/* AUDIO SETTINGS TAB */}
              {activeTab === 'audio' && (
                <div>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Audio Multiplexing & Bitrate</h4>
                  <p style={{ margin: '0 0 24px 0', fontSize: '13px', color: 'var(--text-medium)' }}>
                    AV2 encodes video only. Specify how the audio tracks from the original source file should be handled in the final output container.
                  </p>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', maxWidth: '600px' }}>
                    {/* Audio track mode select */}
                    <div className="form-group">
                      <span className="form-label">Audio Track Mode</span>
                      <div className="select-wrapper">
                        <select className="select-input" value={audioMode} onChange={(e) => setAudioMode(e.target.value)} disabled={isEncoding}>
                          <option value="copy">Auto Passthrough (Copy track directly)</option>
                          <option value="opus">Encode to Opus (High Quality / Compression)</option>
                          <option value="none">No Audio (Mute / strip audio track)</option>
                        </select>
                      </div>
                    </div>

                    {/* Opus bitrate selector (visible when copying to WebM or encoding to Opus) */}
                    {(audioMode === 'opus' || (audioMode === 'copy' && outputFile.toLowerCase().endsWith('.webm'))) && (
                      <div className="form-group">
                        <span className="form-label">Opus Audio Bitrate</span>
                        <div className="select-wrapper">
                          <select className="select-input" value={audioBitrate} onChange={(e) => setAudioBitrate(parseInt(e.target.value))} disabled={isEncoding}>
                            <option value="64">64 kbps (Low)</option>
                            <option value="96">96 kbps (Medium-Low)</option>
                            <option value="128">128 kbps (Medium - Default)</option>
                            <option value="160">160 kbps (Medium-High)</option>
                            <option value="192">192 kbps (High)</option>
                            <option value="256">256 kbps (Very High)</option>
                            <option value="320">320 kbps (Studio Quality)</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* CONTAINER TAB */}
              {activeTab === 'container' && (
                <div>
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '15px' }}>Output Container Format</h4>
                  <p style={{ margin: '0 0 24px 0', fontSize: '13px', color: 'var(--text-medium)' }}>
                    Choose the file wrapper for your final video. FFmpeg will package the encoded raw AV2 stream and the audio track into this format.
                  </p>

                  <div className="form-group" style={{ maxWidth: '400px' }}>
                    <span className="form-label">Format Container</span>
                    <div className="select-wrapper">
                      <select className="select-input" value="mkv" disabled={true}>
                        <option value="mkv">Matroska (.mkv) - Required for AV2</option>
                      </select>
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--text-low)', display: 'block', marginTop: '6px' }}>
                      Note: WebM (.webm) containers do not support the experimental AV2 video codec yet. Matroska (.mkv) is the standard container for packaging raw AV2 streams and supports copying/transcoding any audio track.
                    </span>
                  </div>
                </div>
              )}

              {/* ABOUT TAB */}
              {activeTab === 'about' && (
                <div style={{ fontSize: '14px', lineHeight: '1.6' }}>
                  <h4 style={{ margin: '0 0 12px 0', fontSize: '16px', color: 'var(--accent-purple)' }}>About AOMedia Video 2 (AV2)</h4>
                  <p style={{ margin: '0 0 16px 0' }}>
                    **AV2** is the next-generation royalty-free open-source video coding format developed by the **Alliance for Open Media (AOMedia)**. It is designed as the direct successor to AV1.
                  </p>
                  <p style={{ margin: '0 0 16px 0' }}>
                    The specification was officially finalized and released on **May 28, 2026**. Initial tests indicate AV2 offers approximately **30% better compression efficiency** than AV1 at equivalent visual quality.
                  </p>
                  <h5 style={{ margin: '0 0 8px 0', fontSize: '14px' }}>Reference Implementation:</h5>
                  <p style={{ margin: '0 0 0 0' }}>
                    The **AOM Video Model (AVM)** code base compiled in the background is the official research model. It does not contain GPU hardware acceleration yet. As standard encoders (like SVT-AV2) are developed, speeds will increase exponentially.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Console Output Panel */}
          <div className="panel logger-panel">
            <div className="logger-header">
              <span style={{ fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: isEncoding ? 'var(--accent-emerald)' : 'var(--text-low)', animation: isEncoding ? 'pulse 1s infinite' : 'none' }}></span>
                Live Transcoding Console Logs
              </span>
              <button className="btn" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={clearLogs}>
                Clear Console
              </button>
            </div>
            <pre className="logger-console">
              {jobStatus.logs.length === 0 ? (
                <span style={{ color: 'var(--text-low)' }}>Console idle. Select media files and click "Start Encode" to begin...</span>
              ) : (
                jobStatus.logs.map((log, index) => (
                  <div key={index}>{log}</div>
                ))
              )}
              <div ref={consoleEndRef} />
            </pre>
          </div>
        </section>
      </main>

      {/* Fallback Web File Explorer Modal */}
      {isExplorerOpen && (
        <div className="modal-overlay" onClick={() => setIsExplorerOpen(false)}>
          <div className="panel modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="explorer-header">
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>
                {explorerType === 'input' ? '📁 Select Input Video File' : '💾 Save Encoded Video As'}
              </h3>
              <button className="btn" style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => setIsExplorerOpen(false)}>
                ✕
              </button>
            </div>

            <div style={{ fontSize: '12px', color: 'var(--text-medium)', wordBreak: 'break-all', background: 'rgba(0,0,0,0.15)', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }}>
              <strong>Current Path:</strong> {explorerCurrentDir || 'Loading...'}
            </div>

            {explorerError && (
              <div style={{ color: 'var(--accent-rose)', fontSize: '12px', padding: '8px', background: 'rgba(244,63,94,0.1)', borderRadius: '6px', border: '1px solid rgba(244,63,94,0.2)' }}>
                {explorerError}
              </div>
            )}

            <div className="explorer-list">
              {explorerContents.map((item, idx) => {
                const icon = item.isDirectory ? '📁' : '📄';
                const isVideoFile = /\.(mp4|mkv|avi|mov|y4m|yuv)$/i.test(item.name);
                const isOutputFile = /\.(webm|mkv)$/i.test(item.name);
                
                let isDisabled = false;
                if (!item.isDirectory) {
                  if (explorerType === 'input' && !isVideoFile) {
                    isDisabled = true;
                  } else if (explorerType === 'output' && !isOutputFile) {
                    isDisabled = true;
                  }
                }

                return (
                  <div 
                    key={idx} 
                    className={`explorer-row ${isDisabled ? 'disabled' : ''}`}
                    onClick={() => !isDisabled && handleExplorerRowClick(item)}
                  >
                    <div className="explorer-item-info">
                      <span className="explorer-icon">{icon}</span>
                      <span style={{ fontWeight: item.isDirectory ? '600' : '400', color: isDisabled ? 'var(--text-low)' : 'var(--text-high)' }}>
                        {item.name}
                      </span>
                    </div>
                    <span style={{ fontSize: '11px', color: 'var(--text-low)' }}>
                      {item.isDirectory ? 'Folder' : 'File'}
                    </span>
                  </div>
                );
              })}
              {explorerContents.length === 0 && !explorerError && (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-low)', fontSize: '13px' }}>
                  This folder is empty
                </div>
              )}
            </div>

            {explorerType === 'output' && (
              <div className="form-group" style={{ margin: 0 }}>
                <span className="form-label">File Name</span>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <input 
                    type="text" 
                    className="input-text" 
                    value={explorerInputFileName} 
                    onChange={(e) => setExplorerInputFileName(e.target.value)}
                    placeholder="output.webm"
                  />
                  <div className="select-wrapper" style={{ width: '120px' }}>
                    <select 
                      className="select-input" 
                      value={explorerInputFileName.toLowerCase().endsWith('.mkv') ? 'mkv' : 'webm'}
                      onChange={(e) => {
                        const ext = e.target.value;
                        let base = explorerInputFileName;
                        const lastDot = explorerInputFileName.lastIndexOf('.');
                        if (lastDot !== -1) {
                          base = explorerInputFileName.substring(0, lastDot);
                        }
                        setExplorerInputFileName(base + '.' + ext);
                      }}
                    >
                      <option value="webm">.webm</option>
                      <option value="mkv">.mkv</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
              <button className="btn" onClick={() => setIsExplorerOpen(false)}>
                Cancel
              </button>
              {explorerType === 'output' && (
                <button className="btn btn-primary" onClick={handleConfirmExplorerSave}>
                  Save Selection
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
