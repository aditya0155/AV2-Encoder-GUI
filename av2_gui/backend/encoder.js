import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { broadcast } from './server.js';

// Paths to executables (resolve relatively from backend directory first)
const BACKEND_DIR = path.dirname(fileURLToPath(import.meta.url));
const RELATIVE_AVM_ENC_PATH = path.resolve(BACKEND_DIR, '../../build/avmenc.exe');
const AVM_ENC_PATH = fs.existsSync(RELATIVE_AVM_ENC_PATH)
  ? RELATIVE_AVM_ENC_PATH.replace(/\\/g, '/')
  : 'C:/Users/adity/Videos/project_GATE/build/avmenc.exe';

let activeProcesses = []; // Array of active child processes
let currentRunId = 0;
let cancelRequested = false;
let currentPipelinePromise = Promise.resolve();
let currentJob = {
  status: 'idle', // 'idle', 'preparing', 'encoding', 'muxing', 'completed', 'failed', 'cancelled'
  progress: 0,
  currentFrame: 0,
  totalFrames: 0,
  fps: 0,
  eta: 'N/A',
  startTime: null,
  logs: [],
  error: null,
  inputFile: null,
  outputFile: null
};

// Temp file paths
let tempY4MPath = '';
let tempAV2Path = '';
let tempMuxPath = '';

const MAX_ENCODER_ATTEMPTS = 4;
const SAFE_AVM_MAX_WIDTH = 854;
const ENCODER_STALL_TIMEOUT_MS = 300000; // 5 minutes
const AVM_CRASH_EXIT_CODES = new Set([
  3221225477, // 0xC0000005 access violation, reported by Windows as an unsigned exit code.
  -1073741819
]);
const ENCODER_PROGRESS_LOG_INTERVAL_MS = 10000;

class CancellationError extends Error {
  constructor(message = 'Encoding cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

function isActiveRun(runId) {
  return runId === currentRunId && !cancelRequested && currentJob.status !== 'cancelled';
}

function throwIfCancelled(runId) {
  if (!isActiveRun(runId)) {
    throw new CancellationError();
  }
}

// Batch-disable EcoQoS/Power Throttling for a list of PIDs in ONE PowerShell
// call to avoid the overhead of 16 separate JIT compilations.
function disableEcoQoSForPids(pids) {
  if (process.platform !== 'win32' || !pids || pids.length === 0) return;
  const validPids = pids.filter(Boolean);
  if (validPids.length === 0) return;

  const pidArray = validPids.join(',');
  const script = `
$code = @"
using System;
using System.Runtime.InteropServices;
public class ProcessThrottling {
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool b, int c);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] public static extern bool SetProcessInformation(IntPtr h, int c, ref PPTS s, uint l);
    [StructLayout(LayoutKind.Sequential)] public struct PPTS { public uint Version, ControlMask, StateMask; }
    public static void Disable(int pid) {
        var h = OpenProcess(0x200, false, pid);
        if (h == IntPtr.Zero) return;
        var s = new PPTS { Version = 1, ControlMask = 1, StateMask = 0 };
        SetProcessInformation(h, 4, ref s, (uint)System.Runtime.InteropServices.Marshal.SizeOf(s));
        CloseHandle(h);
    }
}
"@
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
@(${pidArray}) | ForEach-Object { [ProcessThrottling]::Disable([int]$_) }
`;

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const ps = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ]);
  ps.on('error', (err) => console.error('EcoQoS batch disable failed:', err.message));
}

function disableProcessEcoQoS(pid) {
  disableEcoQoSForPids([pid]);
}

export function getStatus() {
  return currentJob;
}

export function resetJobStatus() {
  currentJob = {
    status: 'idle',
    progress: 0,
    currentFrame: 0,
    totalFrames: 0,
    fps: 0,
    eta: 'N/A',
    startTime: null,
    logs: [],
    error: null,
    inputFile: null,
    outputFile: null
  };
  broadcast({ type: 'status', status: currentJob });
}

function addLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const formattedLog = `[${timestamp}] ${message}`;
  currentJob.logs.push(formattedLog);
  // Keep logs at a reasonable size
  if (currentJob.logs.length > 1000) {
    currentJob.logs.shift();
  }
  console.log(formattedLog);
  broadcast({ type: 'log', log: formattedLog });
}

function updateJob(fields) {
  currentJob = { ...currentJob, ...fields };
  broadcast({ type: 'status', status: currentJob });
}

function clampInt(value, min, max, fallback) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function chooseEffectiveResolutionScale(videoInfo, requestedScale) {
  const sourceWidth = parseInt(videoInfo.width, 10) || 0;
  if (requestedScale && requestedScale !== 'original') return requestedScale;
  if (sourceWidth > SAFE_AVM_MAX_WIDTH) return '480p';
  return 'original';
}


export function cancelEncoding() {
  cancelRequested = true;
  currentRunId++;

  const hadActiveProcesses = activeProcesses.length > 0;

  if (hadActiveProcesses) {
    addLog('Cancelling active processes...');
    for (const proc of activeProcesses) {
      try {
        proc.kill('SIGINT');
      } catch (e) {
        console.error('Error killing process:', e);
      }
    }
    activeProcesses = [];
  } else if (currentJob.status === 'preparing' || currentJob.status === 'encoding' || currentJob.status === 'muxing') {
    addLog('Cancelling active job...');
  }

  updateJob({ status: 'cancelled', progress: 0, fps: 0, eta: 'N/A' });

  if (!hadActiveProcesses) {
    cleanupTempFiles();
  }
}

function cleanupTempFiles({ log = true } = {}) {
  if (log) {
    addLog('Cleaning up temporary files...');
  }
  if (tempY4MPath && fs.existsSync(tempY4MPath)) {
    try { fs.unlinkSync(tempY4MPath); } catch(e) {}
  }
  if (tempAV2Path && fs.existsSync(tempAV2Path)) {
    try { fs.unlinkSync(tempAV2Path); } catch(e) {}
  }
  if (tempMuxPath && fs.existsSync(tempMuxPath)) {
    try { fs.unlinkSync(tempMuxPath); } catch(e) {}
  }
  tempY4MPath = '';
  tempAV2Path = '';
  tempMuxPath = '';
}

export function startEncoding({ inputFile, outputFile, qp, speed, audioMode, audioBitrate, limitFrames, resolutionScale, workers }) {
  if (!fs.existsSync(inputFile)) {
    return { error: `Input file does not exist: ${inputFile}` };
  }

  if (!fs.existsSync(AVM_ENC_PATH)) {
    return { error: `AVM encoder not found: ${AVM_ENC_PATH}` };
  }

  if (path.resolve(inputFile).toLowerCase() === path.resolve(outputFile).toLowerCase()) {
    return { error: 'Output file must be different from the input file.' };
  }

  const outputDir = path.dirname(outputFile);
  if (!fs.existsSync(outputDir)) {
    return { error: `Output directory does not exist: ${outputDir}` };
  }

  const isRunning = (currentJob.status === 'preparing' || currentJob.status === 'encoding' || currentJob.status === 'muxing');
  if (isRunning) {
    addLog('A job is already in progress. Requesting termination of the active job...');
    cancelEncoding();
  }

  currentPipelinePromise = currentPipelinePromise
    .catch(() => {})
    .then(() => {
      currentRunId++;
      cancelRequested = false;
      activeProcesses = [];
      cleanupTempFiles({ log: false });
      const runId = currentRunId;

      // Initialize job status
      currentJob = {
        status: 'preparing',
        progress: 0,
        currentFrame: 0,
        totalFrames: 0,
        fps: 0,
        eta: 'N/A',
        startTime: Date.now(),
        logs: [],
        error: null,
        inputFile,
        outputFile
      };
      broadcast({ type: 'status', status: currentJob });

      addLog(`Starting encoding job:`);
      addLog(`- Input: ${inputFile}`);
      addLog(`- Output: ${outputFile}`);
      addLog(`- Constant Quality (QP): ${qp}`);
      addLog(`- Speed (CPU Used): ${speed}`);
      addLog(`- Audio Mode: ${audioMode}`);
      addLog(`- Audio Bitrate: ${audioBitrate}k`);
      if (limitFrames > 0) {
        addLog(`- Frame Limit: ${limitFrames}`);
      }
      if (resolutionScale && resolutionScale !== 'original') {
        addLog(`- Resolution Scale: ${resolutionScale}`);
      }

      // Run the pipeline and return its promise
      return runPipeline({ inputFile, outputFile, qp, speed, audioMode, audioBitrate, limitFrames, resolutionScale, workers, runId });
    });

  return { success: true };
}

async function runPipeline({ inputFile, outputFile, qp, speed, audioMode, audioBitrate, limitFrames, resolutionScale, workers, runId }) {
  try {
    // Step 1: Probe video details
    const videoInfo = await probeVideo(inputFile);
    throwIfCancelled(runId);
    const parsedLimit = parseInt(limitFrames) || 0;
    const jobTotalFrames = (parsedLimit > 0) ? Math.min(parsedLimit, videoInfo.totalFrames) : videoInfo.totalFrames;
    updateJob({ totalFrames: jobTotalFrames });
    addLog(`Probed input details: ${videoInfo.width}x${videoInfo.height}, ${videoInfo.fps} FPS, Total Frames: ${videoInfo.totalFrames}`);
    if (parsedLimit > 0) {
      addLog(`- Encoding limited to first ${parsedLimit} frames.`);
    }

    // Step 2: Convert/scale to raw Y4M
    updateJob({ status: 'preparing' });
    
    const effectiveResolutionScale = chooseEffectiveResolutionScale(videoInfo, resolutionScale);
    if (effectiveResolutionScale !== resolutionScale) {
      addLog(`Reference-safe mode: downscaling ${videoInfo.width}x${videoInfo.height} input to ${effectiveResolutionScale} for AVM stability.`);
    }
    
    const fileDir = path.dirname(outputFile);
    const fileBaseName = path.basename(outputFile, path.extname(outputFile));
    
    tempY4MPath = path.join(fileDir, `${fileBaseName}_temp.y4m`);
    tempAV2Path = path.join(fileDir, `${fileBaseName}_temp.av2`);
    
    addLog(`Step 1/3: Converting input video to raw Y4M...`);
    await convertVideoToY4M(inputFile, tempY4MPath, effectiveResolutionScale, jobTotalFrames, runId);
    throwIfCancelled(runId);
    addLog('Video conversion to Y4M complete.');

    // Step 3: Run the AV2 encoder
    updateJob({ status: 'encoding' });
    addLog(`Step 2/3: Encoding video with AVM...`);
    await runAV2Encoder(tempY4MPath, tempAV2Path, qp, speed, jobTotalFrames, runId);
    throwIfCancelled(runId);
    addLog('AV2 encoding complete.');

    // Step 4: Patch, Mux, and restore codec metadata
    updateJob({ status: 'muxing' });
    addLog('Step 3/3: Patching and muxing audio...');
    
    // Patch AV2 WebM file to V_FFV1 to bypass FFmpeg parser blocks
    addLog(`Patching temporary AV2 file to V_FFV1...`);
    patchWebMToFFV1(tempAV2Path);
    
    // Determine target formats
    const isWebM = outputFile.toLowerCase().endsWith('.webm');
    tempMuxPath = isWebM ? outputFile.replace(/\.webm$/i, '_temp_mux.mkv') : outputFile;
    
    await muxWithAudio({
      videoPath: tempAV2Path,
      sourcePath: inputFile,
      outputPath: tempMuxPath,
      audioMode,
      audioBitrate,
      limitFrames: parsedLimit,
      finalOutputPath: outputFile,
      runId
    });
    throwIfCancelled(runId);
    
    // Patch output file back to V_AV2
    addLog('Patching output file back to V_AV2 to restore original codec metadata...');
    patchMKVToAV2(tempMuxPath);
    
    if (isWebM) {
      addLog('Moving matched MKV output to WebM destination...');
      if (fs.existsSync(outputFile)) {
        fs.unlinkSync(outputFile);
      }
      fs.renameSync(tempMuxPath, outputFile);
    }
    
    addLog('Muxing complete.');

    // Done!
    cleanupTempFiles();
    updateJob({ status: 'completed', progress: 100, fps: 0, eta: 'N/A' });
    addLog('Encoding task successfully finished! Output file saved.');
  } catch (error) {
    if (error instanceof CancellationError || cancelRequested || currentJob.status === 'cancelled') {
      cleanupTempFiles();
      updateJob({ status: 'cancelled', progress: 0, fps: 0, eta: 'N/A' });
      return;
    }

    console.error('Pipeline failed:', error);
    addLog(`Error: ${error.message}`);
    cleanupTempFiles();
    updateJob({ status: 'failed', error: error.message, fps: 0, eta: 'N/A' });
  }
}

// Spawns ffprobe to extract frame count and details
function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_frames,r_frame_rate,width,height,duration',
      '-of', 'json',
      filePath
    ];

    const probe = spawn('ffprobe', args);
    let output = '';
    let stderr = '';

    probe.stdout.on('data', (data) => { output += data; });
    probe.stderr.on('data', (data) => { stderr += data; });
    probe.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe failed to probe input video: ${stderr.trim() || `exit code ${code}`}`));
      }

      try {
        const data = JSON.parse(output);
        if (!data.streams || data.streams.length === 0) {
          throw new Error('no video stream found');
        }
        const stream = data.streams[0];
        let totalFrames = parseInt(stream.nb_frames);
        
        // Calculate FPS
        const [num, den] = stream.r_frame_rate.split('/');
        const fps = parseFloat(num) / parseFloat(den);

        // If nb_frames is missing or not a number, estimate it from duration
        if (isNaN(totalFrames) || totalFrames <= 0) {
          const duration = parseFloat(stream.duration);
          if (!isNaN(duration) && !isNaN(fps)) {
            totalFrames = Math.round(duration * fps);
          } else {
            totalFrames = 300; // Fallback estimate
          }
        }

        resolve({
          width: stream.width,
          height: stream.height,
          fps: fps.toFixed(2),
          totalFrames
        });
      } catch (e) {
        reject(new Error('Failed to parse ffprobe output: ' + e.message));
      }
    });

    probe.on('error', (err) => {
      reject(new Error(`ffprobe failed to start: ${err.message}`));
    });
  });
}

// Spawns ffmpeg to convert/scale video to a single Y4M file
function convertVideoToY4M(inputFile, outputPath, resolutionScale, limitFrames, runId) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', inputFile];
    
    if (resolutionScale && resolutionScale !== 'original') {
      let scaleWidth = '';
      if (resolutionScale === '1080p') scaleWidth = '1920';
      else if (resolutionScale === '720p') scaleWidth = '1280';
      else if (resolutionScale === '480p') scaleWidth = '854';
      else if (resolutionScale === '360p') scaleWidth = '640';
      else if (resolutionScale === '240p') scaleWidth = '426';
      
      if (scaleWidth) {
        args.push('-vf', `scale=${scaleWidth}:-2`);
      }
    }

    args.push('-pix_fmt', 'yuv420p');
    if (limitFrames > 0) {
      args.push('-vframes', limitFrames.toString());
    }
    args.push(outputPath);

    addLog(`Running: ffmpeg ${args.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', args);
    activeProcesses.push(ffmpeg);

    try {
      if (os.setPriority) {
        os.setPriority(ffmpeg.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
      }
      disableProcessEcoQoS(ffmpeg.pid);
    } catch (e) {
      console.error('Failed to set priority for FFmpeg Y4M conversion:', e);
    }

    ffmpeg.stderr.on('data', (data) => {
      const text = data.toString().trim();
      const frameMatch = text.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        const frame = frameMatch[1];
        if (parseInt(frame) % 50 === 0) {
          addLog(`FFmpeg decoded frames... Current: ${frame}`);
        }
      }
    });

    ffmpeg.on('close', (code) => {
      activeProcesses = activeProcesses.filter(p => p !== ffmpeg);
      if (!isActiveRun(runId)) {
        reject(new CancellationError());
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg split failed with exit code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      activeProcesses = activeProcesses.filter(p => p !== ffmpeg);
      reject(err);
    });
  });
}

// Spawns single avmenc.exe process to encode the Y4M file
function runAV2Encoder(y4mPath, av2Path, qp, speed, totalFrames, runId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let attempt = 1;
    let encoderProcess = null;
    let stallTimer = null;
    let lastOutputAt = Date.now();
    let attemptStartTime = Date.now();
    let currentFrame = 0;
    let fps = 0;
    let lastProgressLogTime = 0;
    const pocSet = new Set();

    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(stallTimer);
      if (encoderProcess && !encoderProcess.killed) {
        try { encoderProcess.kill('SIGINT'); } catch(e) {}
      }
      reject(err);
    };

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      clearInterval(stallTimer);
      resolve();
    };

    function buildEncoderArgs(attemptCount) {
      const speedValue = clampInt(speed, 0, 9, 8);
      const qpValue = clampInt(qp, 0, 255, 45);
      const args = [
        '--disable-warning-prompt',
        `--qp=${qpValue}`,
        `--cpu-used=${speedValue}`,
        '--threads=1'
      ];

      if (attemptCount === 2) {
        args.push(
          '--auto-alt-ref=0',
          '--enable-keyframe-filtering=0',
          '--enable-overlay=0',
          '--monotonic-output-order=1'
        );
      } else if (attemptCount === 3) {
        args.push('--kf-min-dist=1', '--kf-max-dist=1');
      }

      if (totalFrames > 0) {
        args.push(`--limit=${totalFrames}`);
      }
      args.push('-o', av2Path, y4mPath);
      return args;
    }

    function handleEncoderOutput(data) {
      const text = data.toString();
      let updated = false;

      const frameMatch = text.match(/frame\s+(\d+)\/(\d+)\s+\d+\s+ms\s+([\d.]+)\s+fps/i);
      if (frameMatch) {
        currentFrame = Math.min(parseInt(frameMatch[1]), totalFrames);
        fps = parseFloat(frameMatch[3]);
        updated = true;
      }

      const simpleMatch = text.match(/\b(\d+)\/(\d+)\b/);
      if (simpleMatch) {
        currentFrame = Math.min(parseInt(simpleMatch[1]), totalFrames);
        updated = true;
      }

      const pocMatches = [...text.matchAll(/POC:\s*(\d+)/g)];
      if (pocMatches.length > 0) {
        for (const match of pocMatches) {
          pocSet.add(parseInt(match[1]));
        }
        currentFrame = Math.min(pocSet.size, totalFrames);
        updated = true;
      }

      if (updated) {
        const elapsedSeconds = Math.max((Date.now() - attemptStartTime) / 1000, 0.001);
        fps = currentFrame / elapsedSeconds;
        
        // Log periodically
        const now = Date.now();
        if (now - lastProgressLogTime > ENCODER_PROGRESS_LOG_INTERVAL_MS) {
          lastProgressLogTime = now;
          addLog(`Encoding progress: ${currentFrame}/${totalFrames} frames (${fps.toFixed(2)} fps)`);
        }

        updateProgress();
      }
    }

    function updateProgress() {
      const progress = Math.min(((currentFrame / totalFrames) * 100), 99.9).toFixed(1);
      let eta = currentFrame > 0 ? 'Calculating...' : 'Working...';
      if (fps > 0) {
        const remainingFrames = Math.max(totalFrames - currentFrame, 0);
        const remainingSeconds = remainingFrames / fps;
        const hours = Math.floor(remainingSeconds / 3600);
        const minutes = Math.floor((remainingSeconds % 3600) / 60);
        const seconds = Math.floor(remainingSeconds % 60);
        eta = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
      }

      updateJob({
        progress,
        currentFrame,
        fps: fps.toFixed(2),
        eta
      });
    }

    function startAttempt() {
      if (settled) return;
      if (!isActiveRun(runId)) {
        settleReject(new CancellationError());
        return;
      }

      const args = buildEncoderArgs(attempt);
      let stdoutTail = '';
      let stderrTail = '';
      let killedForStall = false;
      let encoderClosed = false;

      if (attempt > 1) {
        addLog(`Retry attempt ${attempt}/${MAX_ENCODER_ATTEMPTS}: ${AVM_ENC_PATH} ${args.join(' ')}`);
      } else {
        addLog(`Running: ${AVM_ENC_PATH} ${args.join(' ')}`);
      }

      const encoder = spawn(AVM_ENC_PATH, args);
      encoderProcess = encoder;
      activeProcesses.push(encoder);
      lastOutputAt = Date.now();
      attemptStartTime = Date.now();

      stallTimer = setInterval(() => {
        if (encoderClosed || settled) {
          clearInterval(stallTimer);
          return;
        }

        const now = Date.now();
        const stalled = now - lastOutputAt > ENCODER_STALL_TIMEOUT_MS;
        if (stalled) {
          killedForStall = true;
          addLog(`avmenc.exe produced no progress for ${Math.round((now - lastOutputAt) / 1000)}s; restarting with safer settings...`);
          try { encoder.kill('SIGINT'); } catch(e) {}
          setTimeout(() => {
            if (!encoderClosed) {
              try { encoder.kill('SIGKILL'); } catch(e) {}
            }
          }, 3000);
          clearInterval(stallTimer);
        }
      }, 5000);

      try {
        if (os.setPriority) {
          os.setPriority(encoder.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
        }
        disableProcessEcoQoS(encoder.pid);
      } catch (e) {
        console.error(`Failed to set priority for encoder:`, e);
      }

      encoder.stderr.on('data', (data) => {
        lastOutputAt = Date.now();
        stderrTail = (stderrTail + data.toString()).slice(-2000);
        handleEncoderOutput(data);
      });
      encoder.stdout.on('data', (data) => {
        lastOutputAt = Date.now();
        stdoutTail = (stdoutTail + data.toString()).slice(-2000);
        handleEncoderOutput(data);
      });

      encoder.on('close', (code) => {
        encoderClosed = true;
        clearInterval(stallTimer);
        activeProcesses = activeProcesses.filter(p => p !== encoder);

        if (settled) return;
        if (!isActiveRun(runId)) {
          settleReject(new CancellationError());
          return;
        }

        if (killedForStall) {
          handleFailure('stalled', stderrTail, stdoutTail);
          return;
        }

        if (code !== 0) {
          handleFailure(`exit code ${code}`, stderrTail, stdoutTail);
          return;
        }

        if (!fs.existsSync(av2Path) || fs.statSync(av2Path).size === 0) {
          handleFailure('missing-output', stderrTail, stdoutTail);
          return;
        }

        settleResolve();
      });

      encoder.on('error', (err) => {
        encoderClosed = true;
        clearInterval(stallTimer);
        activeProcesses = activeProcesses.filter(p => p !== encoder);
        settleReject(new Error(`avmenc.exe failed to start: ${err.message}`));
      });
    }

    function handleFailure(reason, stderrTail, stdoutTail) {
      attempt++;
      if (attempt <= MAX_ENCODER_ATTEMPTS) {
        addLog(`avmenc.exe failed due to ${reason}; retrying attempt ${attempt}/${MAX_ENCODER_ATTEMPTS} with safer settings...`);
        if (stdoutTail) addLog(`stdout tail before retry: ${stdoutTail.trim()}`);
        if (stderrTail) addLog(`stderr tail before retry: ${stderrTail.trim()}`);
        try {
          if (fs.existsSync(av2Path)) {
            fs.unlinkSync(av2Path);
          }
        } catch(e) {}
        pocSet.clear();
        startAttempt();
      } else {
        const details = [
          `avmenc.exe failed after ${attempt - 1} attempts due to ${reason}`,
          stdoutTail ? `stdout tail: ${stdoutTail.trim()}` : '',
          stderrTail ? `stderr tail: ${stderrTail.trim()}` : ''
        ].filter(Boolean).join(' | ');
        settleReject(new Error(details));
      }
    }

    startAttempt();
  });
}

function countLeadingZeros(byte) {
  let count = 0;
  for (let bit = 7; bit >= 0; bit--) {
    if ((byte & (1 << bit)) !== 0) {
      break;
    }
    count++;
  }
  return count;
}

function modifyVint(buffer, offset, delta) {
  const firstByte = buffer[offset];
  const lz = countLeadingZeros(firstByte);
  const n_bytes = lz + 1;
  
  let val = firstByte & (0xff >> (lz + 1));
  for (let i = 1; i < n_bytes; i++) {
    val = (val * 256) + buffer[offset + i];
  }
  
  const newVal = val + delta;
  let temp = newVal;
  for (let i = n_bytes - 1; i > 0; i--) {
    buffer[offset + i] = temp & 0xff;
    temp = Math.floor(temp / 256);
  }
  buffer[offset] = temp | (0x80 >> lz);
}

function findTrackEntryStart(buf, codecIdIdx) {
  for (let i = codecIdIdx - 2; i >= 0; i--) {
    if (buf[i] === 0xae) {
      const firstByte = buf[i + 1];
      const lz = countLeadingZeros(firstByte);
      if (lz <= 7) {
        const vintLen = lz + 1;
        let val = firstByte & (0xff >> vintLen);
        for (let j = 1; j < vintLen; j++) {
          val = (val * 256) + buf[i + 1 + j];
        }
        if (i + 1 + vintLen + val > codecIdIdx) {
          return i;
        }
      }
    }
  }
  return -1;
}

function patchWebMToFFV1(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new Error(`Temporary AV2 file is missing or empty: ${filePath}`);
  }

  const buf = fs.readFileSync(filePath);
  const idx = buf.indexOf(Buffer.from('V_AV2'));
  if (idx === -1) {
    throw new Error(`V_AV2 not found in temporary file: ${filePath}. The encoder output may be incomplete or not a Matroska/WebM AV2 file.`);
  }
  
  if (buf[idx - 2] !== 0x86) {
    throw new Error('CodecID element ID mismatch');
  }
  
  const trackEntryIdx = findTrackEntryStart(buf, idx);
  if (trackEntryIdx === -1) {
    throw new Error('TrackEntry element not found');
  }
  
  const tracksHeader = Buffer.from([0x16, 0x54, 0xae, 0x6b]);
  let tracksIdx = -1;
  for (let i = idx; i >= 0; i--) {
    if (buf.slice(i, i + 4).equals(tracksHeader)) {
      tracksIdx = i;
      break;
    }
  }
  if (tracksIdx === -1) {
    throw new Error('Tracks element not found');
  }
  
  modifyVint(buf, trackEntryIdx + 1, 1);
  modifyVint(buf, tracksIdx + 4, 1);
  modifyVint(buf, idx - 1, 1);
  
  const patched = Buffer.concat([buf.slice(0, idx), Buffer.from('V_FFV1'), buf.slice(idx + 5)]);
  fs.writeFileSync(filePath, patched);
}

function patchMKVToAV2(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    throw new Error(`Muxed output is missing or empty: ${filePath}`);
  }

  const buf = fs.readFileSync(filePath);
  const idx = buf.indexOf(Buffer.from('V_FFV1'));
  if (idx === -1) {
    throw new Error(`V_FFV1 not found in output file: ${filePath}`);
  }
  
  if (buf[idx - 2] !== 0x86) {
    throw new Error('CodecID element ID mismatch');
  }
  if (buf[idx - 1] !== 0x86) {
    throw new Error('CodecID length mismatch');
  }
  
  const trackEntryIdx = findTrackEntryStart(buf, idx);
  if (trackEntryIdx === -1) {
    throw new Error('TrackEntry element not found');
  }
  
  const tracksHeader = Buffer.from([0x16, 0x54, 0xae, 0x6b]);
  let tracksIdx = -1;
  for (let i = idx; i >= 0; i--) {
    if (buf.slice(i, i + 4).equals(tracksHeader)) {
      tracksIdx = i;
      break;
    }
  }
  if (tracksIdx === -1) {
    throw new Error('Tracks element not found');
  }
  
  modifyVint(buf, trackEntryIdx + 1, -1);
  modifyVint(buf, tracksIdx + 4, -1);
  modifyVint(buf, idx - 1, -1);
  
  const patched = Buffer.concat([buf.slice(0, idx), Buffer.from('V_AV2'), buf.slice(idx + 6)]);
  fs.writeFileSync(filePath, patched);
}

// Spawns ffmpeg to mux audio with encoded video
function muxWithAudio({ videoPath, sourcePath, outputPath, audioMode, audioBitrate, limitFrames, finalOutputPath, runId }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const isWebM = (finalOutputPath || outputPath).toLowerCase().endsWith('.webm');
    const ab = audioBitrate || 128;
    
    let args = ['-y', '-i', videoPath, '-i', sourcePath];
    
    if (audioMode === 'none') {
      args.push('-map', '0:v', '-c:v', 'copy', '-an');
    } else {
      args.push('-map', '0:v', '-map', '1:a?', '-c:v', 'copy');
      
      if (audioMode === 'copy') {
        if (isWebM) {
          addLog(`Output is WebM, transcoding audio to Opus at ${ab}k for compatibility...`);
          args.push('-c:a', 'libopus', '-b:a', `${ab}k`);
        } else {
          args.push('-c:a', 'copy');
        }
      } else if (audioMode === 'opus') {
        args.push('-c:a', 'libopus', '-b:a', `${ab}k`);
      }
    }

    if (limitFrames > 0) {
      args.push('-shortest');
    }

    args.push(outputPath);

    addLog(`Running: ffmpeg ${args.join(' ')}`);
    const ffmpeg = spawn('ffmpeg', args);
    activeProcesses.push(ffmpeg);

    try {
      if (os.setPriority) {
        os.setPriority(ffmpeg.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
      }
      disableProcessEcoQoS(ffmpeg.pid);
    } catch (e) {
      console.error('Failed to set priority for FFmpeg mux:', e);
    }

    let ffmpegStderr = [];
    ffmpeg.stderr.on('data', (data) => {
      if (!isActiveRun(runId)) {
        try { ffmpeg.kill('SIGINT'); } catch(e) {}
        settleReject(new CancellationError());
        return;
      }

      const text = data.toString();
      ffmpegStderr.push(text);
      const trimmed = text.trim();
      if (trimmed.includes('frame=')) {
        addLog(`Muxing progress: ${trimmed.substring(0, 50)}...`);
      }
    });

    ffmpeg.on('close', (code) => {
      activeProcesses = activeProcesses.filter(p => p !== ffmpeg);
      if (!isActiveRun(runId)) {
        settleReject(new CancellationError());
      } else if (code === 0) {
        settleResolve();
      } else {
        const errorMsg = ffmpegStderr.join('').trim();
        addLog(`FFmpeg stderr output:\n${errorMsg}`);
        settleReject(new Error(`ffmpeg failed during muxing with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      activeProcesses = activeProcesses.filter(p => p !== ffmpeg);
      settleReject(err);
    });
  });
}
