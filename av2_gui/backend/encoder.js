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
let tempListPath = '';
let activeSegments = [];

// Minimum frames per segment — avmenc only emits progress every ~1 frame but
// needs enough frames to be observable and to justify process spawn overhead.
const MIN_FRAMES_PER_SEGMENT = 10;

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
  if (tempListPath && fs.existsSync(tempListPath)) {
    try { fs.unlinkSync(tempListPath); } catch(e) {}
  }
  // Clean up segments
  for (const seg of activeSegments) {
    if (seg.y4mPath && fs.existsSync(seg.y4mPath)) {
      try { fs.unlinkSync(seg.y4mPath); } catch(e) {}
    }
    if (seg.av2Path && fs.existsSync(seg.av2Path)) {
      try { fs.unlinkSync(seg.av2Path); } catch(e) {}
    }
  }
  activeSegments = [];
  tempListPath = '';
}

function finishWriteStreams(streams) {
  return Promise.all(streams.map(stream => new Promise(resolve => {
    if (stream.destroyed || stream.writableFinished) {
      resolve();
      return;
    }

    stream.once('finish', resolve);
    stream.once('error', resolve);
    if (!stream.writableEnded) {
      stream.end();
    }
  })));
}

export function startEncoding({ inputFile, outputFile, qp, speed, audioMode, audioBitrate, limitFrames, resolutionScale, workers }) {
  if (currentJob.status === 'preparing' || currentJob.status === 'encoding' || currentJob.status === 'muxing') {
    return { error: 'Encoding is already in progress.' };
  }

  if (!fs.existsSync(inputFile)) {
    return { error: `Input file does not exist: ${inputFile}` };
  }

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
  addLog(`- Target Parallel Workers: ${workers || 'Auto'}`);
  if (limitFrames > 0) {
    addLog(`- Frame Limit: ${limitFrames}`);
  }
  if (resolutionScale && resolutionScale !== 'original') {
    addLog(`- Resolution Scale: ${resolutionScale}`);
  }

  // Run the pipeline
  runPipeline({ inputFile, outputFile, qp, speed, audioMode, audioBitrate, limitFrames, resolutionScale, workers, runId });

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

    // Step 2: Slicing into segments
    updateJob({ status: 'preparing' });
    
    const parsedWorkers = Math.max(1, parseInt(workers) || os.cpus().length);
    // Cap segments so each gets at least MIN_FRAMES_PER_SEGMENT frames.
    // This prevents avmenc from completing before emitting any progress line,
    // which would leave the UI stuck at 0%.
    const maxSegmentsByFrames = Math.max(1, Math.floor(jobTotalFrames / MIN_FRAMES_PER_SEGMENT));
    const numSegments = Math.min(parsedWorkers, jobTotalFrames, maxSegmentsByFrames);
    const framesPerSegment = Math.floor(jobTotalFrames / numSegments);
    if (numSegments < parsedWorkers) {
      addLog(`Note: Reduced workers from ${parsedWorkers} → ${numSegments} to ensure each segment has at least ${MIN_FRAMES_PER_SEGMENT} frames.`);
    }
    const segments = [];
    let startFrame = 0;
    
    const fileDir = path.dirname(outputFile);
    const fileBaseName = path.basename(outputFile, path.extname(outputFile));
    
    for (let i = 0; i < numSegments; i++) {
      const isLast = (i === numSegments - 1);
      const endFrame = isLast ? jobTotalFrames : (startFrame + framesPerSegment);
      const segmentFrames = endFrame - startFrame;
      
      segments.push({
        index: i,
        startFrame,
        endFrame,
        frames: segmentFrames,
        y4mPath: path.join(fileDir, `${fileBaseName}_temp_seg${i}.y4m`),
        av2Path: path.join(fileDir, `${fileBaseName}_temp_seg${i}.av2`)
      });
      startFrame = endFrame;
    }
    
    activeSegments = segments;
    
    addLog(`Step 1/3: Splitting video into ${numSegments} segments in parallel...`);
    await splitVideoIntoSegments(inputFile, segments, resolutionScale, jobTotalFrames, runId);
    throwIfCancelled(runId);
    addLog('Video split complete.');

    // Step 3: Run the parallel AV2 encoders
    updateJob({ status: 'encoding' });
    addLog(`Step 2/3: Encoding ${numSegments} video segments in parallel using all cores...`);
    await runParallelAV2Encoders(segments, qp, speed, jobTotalFrames, runId);
    throwIfCancelled(runId);
    addLog('AV2 parallel encoding complete.');

    // Step 4: Patch, Concat, and Mux audio/video together
    updateJob({ status: 'muxing' });
    addLog('Step 3/3: Patching and concatenating segments with audio...');
    
    // Patch all segment AV2 WebM files to V_FFV1 to bypass FFmpeg parser blocks
    for (const seg of segments) {
      throwIfCancelled(runId);
      addLog(`Patching segment ${seg.index} temporary file to V_FFV1...`);
      patchWebMToFFV1(seg.av2Path);
    }
    
    // Write tempListPath
    tempListPath = path.join(fileDir, `${fileBaseName}_temp_list.txt`);
    const listContent = segments.map(seg => `file '${seg.av2Path.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(tempListPath, listContent);
    
    // Determine target formats
    const isWebM = outputFile.toLowerCase().endsWith('.webm');
    tempMuxPath = isWebM ? outputFile.replace(/\.webm$/i, '_temp_mux.mkv') : outputFile;
    
    await muxSegmentsWithAudio({
      listPath: tempListPath,
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
    
    addLog('Concatenation and muxing complete.');

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

    probe.stdout.on('data', (data) => { output += data; });
    probe.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error('ffprobe failed to probe input video'));
      }

      try {
        const data = JSON.parse(output);
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
            totalFrames = 300; // Fallback estimate (10 seconds @ 30 FPS)
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
  });
}

// Spawns ffmpeg to convert to Y4M stream and split it into segment files
function splitVideoIntoSegments(inputFile, segments, resolutionScale, limitFrames, runId) {
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
    args.push('-f', 'yuv4mpegpipe', '-');

    const ffmpeg = spawn('ffmpeg', args);
    activeProcesses.push(ffmpeg);

    try {
      if (os.setPriority) {
        os.setPriority(ffmpeg.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
      }
      disableProcessEcoQoS(ffmpeg.pid);
    } catch (e) {
      console.error('Failed to set priority for FFmpeg split:', e);
    }
    
    let parsedHeader = false;
    let frameSize = 0;
    let currentSegmentIndex = 0;
    let buffer = Buffer.alloc(0);
    
    const writeStreams = segments.map(seg => fs.createWriteStream(seg.y4mPath));
    
    ffmpeg.stdout.on('data', (chunk) => {
      if (!isActiveRun(runId)) {
        try { ffmpeg.kill('SIGINT'); } catch(e) {}
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);
      
      if (!parsedHeader) {
        const newlineIndex = buffer.indexOf(0x0a);
        if (newlineIndex !== -1) {
          const headerBytes = buffer.slice(0, newlineIndex + 1);
          const headerStr = headerBytes.toString('utf8');
          
          const widthMatch = headerStr.match(/W(\d+)/);
          const heightMatch = headerStr.match(/H(\d+)/);
          if (!widthMatch || !heightMatch) {
            ffmpeg.kill('SIGINT');
            settleReject(new Error('Invalid Y4M header format from FFmpeg'));
            return;
          }
          
          const width = parseInt(widthMatch[1]);
          const height = parseInt(heightMatch[1]);
          frameSize = 6 + Math.floor(width * height * 1.5);
          
          // Write Y4M header to each segment file
          for (let i = 0; i < segments.length; i++) {
            writeStreams[i].write(headerBytes);
          }
          
          buffer = buffer.slice(newlineIndex + 1);
          parsedHeader = true;
        }
      }
      
      if (parsedHeader) {
        while (buffer.length >= frameSize) {
          const frameBytes = buffer.slice(0, frameSize);
          buffer = buffer.slice(frameSize);
          
          const activeSeg = segments[currentSegmentIndex];
          writeStreams[currentSegmentIndex].write(frameBytes);
          
          activeSeg.writtenFrames = (activeSeg.writtenFrames || 0) + 1;
          if (activeSeg.writtenFrames >= activeSeg.frames && currentSegmentIndex < segments.length - 1) {
            writeStreams[currentSegmentIndex].end();
            currentSegmentIndex++;
          }
        }
      }
    });

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
      finishWriteStreams(writeStreams).then(() => {
        if (!isActiveRun(runId)) {
          settleReject(new CancellationError());
          return;
        }
        if (code === 0) {
          const shortSegment = segments.find(seg => (seg.writtenFrames || 0) !== seg.frames);
          if (shortSegment) {
            settleReject(new Error(`FFmpeg split wrote ${shortSegment.writtenFrames || 0}/${shortSegment.frames} frames for segment ${shortSegment.index}`));
            return;
          }
          settleResolve();
        } else {
          settleReject(new Error(`FFmpeg split failed with exit code ${code}`));
        }
      });
    });
    
    ffmpeg.on('error', (err) => {
      activeProcesses = activeProcesses.filter(p => p !== ffmpeg);
      finishWriteStreams(writeStreams).finally(() => settleReject(err));
    });
  });
}

// Spawns multiple avmenc.exe instances in parallel and aggregates progress.
function runParallelAV2Encoders(segments, qp, speed, totalFrames, runId) {
  return new Promise((resolve, reject) => {
    let completedCount = 0;
    let settled = false;
    const segmentFramesProcessed = new Array(segments.length).fill(0);
    const segmentFps = new Array(segments.length).fill(0);
    const segmentStartTimes = new Array(segments.length).fill(Date.now());
    const encoders = [];

    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      for (const enc of encoders) {
        if (!enc.killed) {
          try { enc.kill('SIGINT'); } catch(e) {}
        }
      }
      reject(err);
    };

    const settleResolve = () => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      resolve();
    };

    function handleEncoderOutput(i, data, source) {
      if (!isActiveRun(runId)) {
        settleReject(new CancellationError());
        return;
      }

      const text = data.toString();
      if (source === 'stdout') {
        const trimmed = text.trim();
        if (trimmed) {
          addLog(`[Segment ${i} stdout] ${trimmed}`);
        }
      }

      let updated = false;
      const frameMatch = text.match(/frame\s+(\d+)\/(\d+)\s+\d+\s+ms\s+([\d.]+)\s+fps/i);
      if (frameMatch) {
        const currentFrame = Math.min(parseInt(frameMatch[1]), segments[i].frames);
        segmentFramesProcessed[i] = Math.max(segmentFramesProcessed[i], currentFrame);
        segmentFps[i] = parseFloat(frameMatch[3]);
        updated = true;
      }

      const simpleMatch = text.match(/\b(\d+)\/(\d+)\b/);
      if (simpleMatch) {
        const currentFrame = Math.min(parseInt(simpleMatch[1]), segments[i].frames);
        segmentFramesProcessed[i] = Math.max(segmentFramesProcessed[i], currentFrame);
        updated = true;
      }

      const pocMatches = [...text.matchAll(/POC:\s*(\d+)/g)];
      if (pocMatches.length > 0) {
        const maxPoc = Math.max(...pocMatches.map(match => parseInt(match[1])));
        const currentFrame = Math.min(maxPoc + 1, segments[i].frames);
        segmentFramesProcessed[i] = Math.max(segmentFramesProcessed[i], currentFrame);
        updated = true;
      }

      if (updated) {
        const elapsedSeconds = Math.max((Date.now() - segmentStartTimes[i]) / 1000, 0.001);
        if (segmentFps[i] === 0 && segmentFramesProcessed[i] > 0) {
          segmentFps[i] = segmentFramesProcessed[i] / elapsedSeconds;
        }
        updateProgress();
      }
    }

    const progressTimer = setInterval(() => {
      if (!isActiveRun(runId)) {
        settleReject(new CancellationError());
        return;
      }
      updateProgress();
    }, 1000);

    for (const [i, seg] of segments.entries()) {
      const args = [
        '--disable-warning-prompt',
        `--qp=${qp}`,
        `--cpu-used=${speed}`,
      ];
      if (seg.frames > 0) {
        args.push(`--limit=${seg.frames}`);
      }
      args.push('-o', seg.av2Path, seg.y4mPath);

      addLog(`[Segment ${i}] Running: ${AVM_ENC_PATH} ${args.join(' ')}`);

      const encoder = spawn(AVM_ENC_PATH, args);
      encoders.push(encoder);
      activeProcesses.push(encoder);

      try {
        if (os.setPriority) {
          os.setPriority(encoder.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
        }
      } catch (e) {
        console.error(`Failed to set priority for segment ${i}:`, e);
      }

      encoder.stderr.on('data', (data) => handleEncoderOutput(i, data, 'stderr'));
      encoder.stdout.on('data', (data) => handleEncoderOutput(i, data, 'stdout'));

      encoder.on('close', (code) => {
        activeProcesses = activeProcesses.filter(p => p !== encoder);

        if (!isActiveRun(runId)) {
          settleReject(new CancellationError());
          return;
        }

        if (code !== 0) {
          settleReject(new Error(`Segment ${i} avmenc.exe failed with exit code ${code}`));
          return;
        }

        if (!fs.existsSync(seg.av2Path) || fs.statSync(seg.av2Path).size === 0) {
          settleReject(new Error(`Segment ${i} encoder output is missing or empty`));
          return;
        }

        segmentFramesProcessed[i] = seg.frames;
        const elapsedSeconds = Math.max((Date.now() - segmentStartTimes[i]) / 1000, 0.001);
        segmentFps[i] = seg.frames / elapsedSeconds;
        completedCount++;
        updateProgress();

        if (completedCount === segments.length) {
          settleResolve();
        }
      });

      encoder.on('error', (err) => {
        activeProcesses = activeProcesses.filter(p => p !== encoder);
        settleReject(new Error(`Segment ${i} avmenc.exe failed to start: ${err.message}`));
      });
    }

    // Batch-disable EcoQoS for ALL encoder PIDs in a single PowerShell call.
    disableEcoQoSForPids(encoders.map(e => e.pid));

    function updateProgress() {
      if (settled && completedCount !== segments.length) return;

      const totalProcessed = segmentFramesProcessed.reduce((a, b) => a + b, 0);
      const progress = Math.min(((totalProcessed / totalFrames) * 100), 99.9).toFixed(1);
      const overallFps = segmentFps.reduce((a, b) => a + b, 0);

      let eta = totalProcessed > 0 ? 'Calculating...' : 'Working...';
      if (overallFps > 0) {
        const remainingFrames = Math.max(totalFrames - totalProcessed, 0);
        const remainingSeconds = remainingFrames / overallFps;
        const hours = Math.floor(remainingSeconds / 3600);
        const minutes = Math.floor((remainingSeconds % 3600) / 60);
        const seconds = Math.floor(remainingSeconds % 60);
        eta = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
      }

      updateJob({
        progress,
        currentFrame: totalProcessed,
        totalFrames,
        fps: overallFps.toFixed(2),
        eta
      });
    }
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
    throw new Error(`Temporary AV2 segment is missing or empty: ${filePath}`);
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

// Spawns ffmpeg to concat segments and mux audio
function muxSegmentsWithAudio({ listPath, sourcePath, outputPath, audioMode, audioBitrate, limitFrames, finalOutputPath, runId }) {
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
    
    let args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-i', sourcePath];
    
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
        settleReject(new Error(`ffmpeg failed during segment concatenation with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      activeProcesses = activeProcesses.filter(p => p !== ffmpeg);
      settleReject(err);
    });
  });
}
