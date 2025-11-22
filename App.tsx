import React, { useState, useRef, useEffect } from 'react';
import { 
  Key, 
  Image as ImageIcon, 
  Music, 
  Film, 
  Download, 
  Play, 
  Pause, 
  AlertCircle, 
  CheckCircle,
  Loader2,
  FileText,
  Upload,
  RefreshCw,
  FileJson
} from 'lucide-react';
import { 
  AppStage, 
  ScriptLine, 
  DEFAULT_STYLE, 
  ApiKeySession, 
  TimelineEntry, 
  MIN_IMAGE_DURATION, 
  FADE_IN_DURATION,
  ManifestEntry
} from './types';
import { validateApiKey, generateImageForLine, alignAudioWithScript, QuotaError } from './services/geminiService';
import { VideoRenderer } from './services/renderService';

const App: React.FC = () => {
  // -- State --
  const [stage, setStage] = useState<AppStage>(AppStage.SCRIPT_INPUT);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  
  // Setup & Keys
  const [apiKeySession, setApiKeySession] = useState<ApiKeySession | null>(null);
  const [tempKey, setTempKey] = useState('');
  const [tempLimit, setTempLimit] = useState<string>('5');
  const [isKeyValidating, setIsKeyValidating] = useState(false);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyModalMessage, setKeyModalMessage] = useState<string>("Enter a valid Google GenAI API key to continue.");

  // Script & Generation
  const [scriptLines, setScriptLines] = useState<ScriptLine[]>([]);
  const [isProcessingBatch, setIsProcessingBatch] = useState(false);
  const [batchIdCounter, setBatchIdCounter] = useState(0);

  // Audio & Sync
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);

  // Rendering
  const [renderProgress, setRenderProgress] = useState(0);
  const [finalVideoBlob, setFinalVideoBlob] = useState<Blob | null>(null);
  const [manifestUrl, setManifestUrl] = useState<string | null>(null);

  // -- Helpers --
  const addLog = (msg: string) => setLogs(prev => [...prev.slice(-9), msg]);
  
  const sanitizeFilename = (text: string) => {
    return text.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
  };

  const generateManifest = () => {
    const manifest: ManifestEntry[] = scriptLines.map(line => ({
      script_line: line.spokenText,
      pic_prompt: line.imagePrompt,
      filename: line.imageFileName || "",
      status: line.status,
      api_key_batch: line.batchId,
      timestamp: line.timestamp
    }));
    
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
    setManifestUrl(URL.createObjectURL(blob));
  };

  // -- Handlers --

  const handleTxtUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;

      const lines = text.split('\n').filter(l => l.trim().length > 0);
      const parsed: ScriptLine[] = lines.map((line, idx) => {
        // "Split into script_line and pic_prompt (text before |, text after |)"
        // If no |, prompt is empty.
        const pipeIndex = line.indexOf('|');
        let scriptPart = line;
        let promptPart = '';

        if (pipeIndex !== -1) {
          scriptPart = line.substring(0, pipeIndex).trim();
          promptPart = line.substring(pipeIndex + 1).trim();
        } else {
          scriptPart = line.trim();
          promptPart = '';
        }

        return {
          id: `line-${idx}`,
          originalText: line,
          spokenText: scriptPart,
          imagePrompt: promptPart,
          status: 'pending'
        };
      });

      if (parsed.length > 0) {
        setScriptLines(parsed);
        setStage(AppStage.IMAGE_GENERATION); 
        setKeyModalMessage("Initial Setup: Please enter your first API key.");
        setShowKeyModal(true); 
        addLog(`Loaded ${parsed.length} lines from TXT.`);
      } else {
        setError("File appears empty or invalid format.");
      }
    };
    reader.readAsText(file);
  };

  const handleKeySubmit = async () => {
    setError(null);
    setIsKeyValidating(true);
    addLog("Testing API Key...");
    
    // Validate
    const isValid = await validateApiKey(tempKey);
    setIsKeyValidating(false);

    if (isValid) {
      const limit = parseInt(tempLimit);
      if (isNaN(limit) || limit < 1) {
        setError("Please enter a valid number of images (> 0).");
        return;
      }

      // New Batch Session
      const newBatchId = batchIdCounter + 1;
      setBatchIdCounter(newBatchId);
      
      const newSession: ApiKeySession = {
        key: tempKey,
        limit: limit,
        used: 0,
        isValid: true,
        batchId: newBatchId
      };
      
      setApiKeySession(newSession);
      addLog(`Key accepted. Batch #${newBatchId} started. Limit: ${limit}`);
      setShowKeyModal(false);
      
      // Clear message for next time
      setKeyModalMessage("Enter a valid Google GenAI API key to continue.");
      
      // Start/Resume Processing
      processBatch(newSession);
      
    } else {
      setError("Key validation failed. Quota might be exhausted or key invalid.");
    }
  };

  // Main Processing Loop
  const processBatch = async (session: ApiKeySession) => {
    if (isProcessingBatch) return; // Prevent double run
    setIsProcessingBatch(true);
    setError(null);

    let currentSession = { ...session };
    let processedInThisRun = 0;
    
    // Create local copy of lines to manipulate status
    const lines = [...scriptLines];
    
    // Find where to resume
    let resumeIndex = lines.findIndex(l => l.status === 'pending' || l.status === 'failed');
    
    if (resumeIndex === -1) {
      addLog("All images completed!");
      setIsProcessingBatch(false);
      return;
    }

    addLog(`Processing lines starting from #${resumeIndex + 1}...`);

    while (resumeIndex < lines.length && currentSession.used < currentSession.limit) {
      const line = lines[resumeIndex];

      // Skip already completed lines (sanity check)
      if (line.status === 'completed') {
        resumeIndex++;
        continue;
      }

      // Prepare UI for generation
      line.status = 'generating';
      line.error = undefined;
      setScriptLines([...lines]); // Force update
      
      try {
        addLog(`Generating img for line #${resumeIndex + 1}...`);
        
        let attempts = 0;
        let success = false;
        
        // Retry logic: 2 retries (total 3 attempts)
        while (attempts < 3 && !success) {
           attempts++;
           try {
              const result = await generateImageForLine(currentSession.key, line, DEFAULT_STYLE);
              
              // Success
              line.imageData = result.base64;
              line.imageFileName = sanitizeFilename(line.spokenText) + '.png';
              line.status = 'completed';
              line.batchId = currentSession.batchId;
              line.timestamp = new Date().toISOString();
              
              currentSession.used++;
              setApiKeySession({ ...currentSession }); // Update UI counter
              success = true;

           } catch (err: any) {
              // Critical Quota Check
              if (err instanceof QuotaError) {
                 addLog(`Quota Error: ${err.message}`);
                 throw err; // Break out of retry loop immediately
              }
              
              console.warn(`Attempt ${attempts} failed for line ${resumeIndex}`, err);
              if (attempts >= 3) {
                 line.status = 'failed';
                 line.error = err.message;
                 addLog(`Line #${resumeIndex + 1} failed after 3 attempts.`);
              } else {
                 await new Promise(r => setTimeout(r, 1500)); // Backoff
              }
           }
        }
        
        // Move to next line regardless of success/fail (unless QuotaError was thrown)
        resumeIndex++;
        setScriptLines([...lines]);

      } catch (err: any) {
        if (err instanceof QuotaError) {
          // QUOTA HIT: Stop everything, save state, prompt user
          line.status = 'pending'; // Reset current to pending so we retry it next time
          setScriptLines([...lines]);
          setIsProcessingBatch(false);
          
          setError(`Quota exhausted at line #${resumeIndex + 1}.`);
          setKeyModalMessage("Quota exhausted or API blocked. Please enter a NEW API key (or re-enter if you believe this is a cache error).");
          setTempKey(''); // Clear key to force re-entry
          setShowKeyModal(true);
          return; // EXIT FUNCTION
        }
      }
    }

    setIsProcessingBatch(false);
    
    // Check why we exited
    const nextPending = lines.findIndex(l => l.status === 'pending');
    
    if (nextPending === -1) {
      // All Done
      addLog("All lines processed successfully.");
      setScriptLines([...lines]);
    } else if (currentSession.used >= currentSession.limit) {
      // Batch Limit Reached
      addLog(`Batch limit (${currentSession.limit}) reached. Pausing.`);
      setKeyModalMessage(`Batch of ${currentSession.limit} images complete. Enter next key to continue.`);
      setTempKey(''); // Clear for security
      setShowKeyModal(true);
    }
  };

  const handleAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setAudioFile(file);
      setAudioUrl(URL.createObjectURL(file));
      addLog("Audio loaded.");
    }
  };

  const handleSync = async () => {
    if (!audioFile) {
      setError("Please upload an audio file first.");
      return;
    }
    // We need an API key for sync. If session expired or missing, ask.
    if (!apiKeySession) {
      setKeyModalMessage("Need API Key for Audio Sync.");
      setShowKeyModal(true);
      return;
    }

    setIsSyncing(true);
    addLog("Syncing audio to script...");

    try {
      const reader = new FileReader();
      reader.readAsDataURL(audioFile);
      reader.onloadend = async () => {
        const base64Audio = (reader.result as string).split(',')[1];
        
        // Filter only completed lines for timeline
        const completedLines = scriptLines.filter(l => l.status === 'completed' && l.imageData);
        
        const alignments = await alignAudioWithScript(apiKeySession.key, base64Audio, completedLines);
        
        let newTimeline: TimelineEntry[] = [];
        
        // Strict order from TXT file
        completedLines.forEach((line) => {
            const align = alignments.find(a => a.lineId === line.id);
            
            newTimeline.push({
                id: line.id,
                scriptLineId: line.id,
                startTime: align ? align.startTime : 0,
                endTime: align ? align.endTime : 0,
                text: line.spokenText,
                image: `data:image/png;base64,${line.imageData}`
            });
        });

        // Fallback Logic: Fix gaps, overlaps, min duration
        let lastEnd = 0;
        // Estimate total duration if ASR fails completely: 3s per image
        const fallbackDurationPerSlide = 3;

        for (let i = 0; i < newTimeline.length; i++) {
            const t = newTimeline[i];
            
            // If timing is invalid (0) or overlaps backwards, push it forward
            if (t.startTime < lastEnd) {
                t.startTime = lastEnd;
            }

            // If duration is too short or end is before start
            if (t.endTime <= t.startTime + MIN_IMAGE_DURATION) {
                // If we have no valid end time from ASR, give it default duration
                if (t.endTime === 0) {
                    t.endTime = t.startTime + fallbackDurationPerSlide;
                } else {
                    t.endTime = t.startTime + MIN_IMAGE_DURATION;
                }
            }

            lastEnd = t.endTime;
        }

        setTimeline(newTimeline);
        setIsSyncing(false);
        setStage(AppStage.RENDERING);
        generateManifest(); // Prepare manifest
      };
    } catch (err: any) {
      setError(`Sync failed: ${err.message}. Please try again (check Key).`);
      setIsSyncing(false);
    }
  };

  const handleRender = async () => {
    if (timeline.length === 0 || !audioUrl) return;
    
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    const renderer = new VideoRenderer({
      width: 1920,
      height: 1080,
      fps: 30,
      fadeInDuration: FADE_IN_DURATION
    });

    addLog("Starting render...");
    const blob = await renderer.render(timeline, audioBuffer, (progress) => {
      setRenderProgress(Math.round(progress));
    });

    setFinalVideoBlob(blob);
    setStage(AppStage.COMPLETED);
    addLog("Render Complete.");
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white font-sans selection:bg-agent-500 selection:text-black">
      
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700 p-4 sticky top-0 z-10 shadow-lg">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-agent-500 rounded flex items-center justify-center text-gray-900 font-bold">
                    <Film size={20} />
                </div>
                <h1 className="text-xl font-bold tracking-tight">AutoMedia Agent</h1>
            </div>
            <div className="flex items-center gap-4 text-sm text-gray-400">
               {apiKeySession && (
                 <span className="hidden md:inline bg-gray-900 px-3 py-1 rounded text-xs">
                    Batch #{apiKeySession.batchId} • Used: {apiKeySession.used}/{apiKeySession.limit}
                 </span>
               )}
               <span className="bg-gray-800 px-3 py-1 rounded border border-gray-700">
                 Stage: <span className="text-agent-400 font-bold">{stage.replace('_', ' ')}</span>
               </span>
            </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto p-6">
        
        {/* Error Banner */}
        {error && (
          <div className="mb-6 bg-red-900/40 border border-red-500/50 text-red-200 p-4 rounded-lg flex items-start gap-3 animate-pulse">
            <AlertCircle className="shrink-0 mt-0.5" />
            <div>
              <h3 className="font-bold">System Alert</h3>
              <p>{error}</p>
            </div>
          </div>
        )}

        {/* Modal: API Key Input (Reused for Batching & Quota) */}
        {showKeyModal && (
             <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-4">
                 <div className="bg-gray-800 rounded-xl p-8 shadow-2xl border border-gray-600 max-w-md w-full animate-in zoom-in-95">
                     <div className="flex items-center gap-3 mb-4 text-agent-400">
                        <Key size={32} />
                        <h2 className="text-2xl font-bold">API Access Required</h2>
                     </div>
                     <p className="text-white font-medium mb-2">{keyModalMessage}</p>
                     
                     <div className="bg-gray-900 p-3 rounded mb-6 text-sm text-gray-400 border border-gray-700">
                        Progress: {scriptLines.filter(l => l.status === 'completed').length} / {scriptLines.length} images generated.
                     </div>
                     
                     <div className="space-y-4">
                         <div>
                            <label className="block text-xs font-bold uppercase text-gray-500 mb-1">Google GenAI Key</label>
                            <input 
                                type="password" 
                                value={tempKey}
                                onChange={(e) => setTempKey(e.target.value)}
                                placeholder="Paste API Key here..."
                                className="w-full bg-gray-900 border border-gray-600 rounded p-3 focus:border-agent-500 outline-none text-white font-mono"
                                autoFocus
                            />
                         </div>
                         {/* Only show limit input if we are in generation stage */}
                         {stage === AppStage.IMAGE_GENERATION && (
                             <div>
                                <label className="block text-xs font-bold uppercase text-gray-500 mb-1">Batch Limit (Images before pause)</label>
                                <input 
                                    type="number" 
                                    value={tempLimit}
                                    onChange={(e) => setTempLimit(e.target.value)}
                                    min="1"
                                    className="w-full bg-gray-900 border border-gray-600 rounded p-3 focus:border-agent-500 outline-none text-white"
                                />
                             </div>
                         )}
                         
                         <button 
                            onClick={handleKeySubmit}
                            disabled={!tempKey || isKeyValidating}
                            className="w-full bg-agent-600 hover:bg-agent-500 text-white font-bold py-3 rounded flex items-center justify-center gap-2 mt-4 transition-colors"
                         >
                            {isKeyValidating ? <Loader2 className="animate-spin" /> : <CheckCircle />}
                            Validate & Continue
                         </button>
                     </div>
                 </div>
             </div>
        )}

        {/* Stage 1: Script Input */}
        {stage === AppStage.SCRIPT_INPUT && (
            <div className="bg-gray-800 rounded-xl p-10 shadow-xl border border-gray-700 text-center max-w-2xl mx-auto">
                <div className="w-20 h-20 bg-gray-900 rounded-full flex items-center justify-center mx-auto mb-6 text-agent-500 shadow-inner">
                    <FileText size={40} />
                </div>
                <h2 className="text-3xl font-bold mb-3">Upload Script</h2>
                <p className="text-gray-400 mb-8 max-w-md mx-auto">
                   Upload a <code className="text-agent-300">.txt</code> file.<br/>
                   Lines formatted as: <br/>
                   <code className="bg-gray-900 px-2 py-1 rounded text-sm block mt-2">Script line text | Picture prompt</code>
                </p>
                
                <div className="relative group cursor-pointer inline-block w-full max-w-md">
                    <input 
                        type="file" 
                        accept=".txt"
                        onChange={handleTxtUpload}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    />
                    <div className="border-2 border-dashed border-gray-600 rounded-xl p-12 group-hover:border-agent-500 group-hover:bg-gray-900/50 transition-all">
                        <Upload className="mx-auto text-gray-500 mb-4 group-hover:text-agent-400 scale-125 transition-transform" />
                        <span className="text-gray-400 group-hover:text-white font-medium text-lg">Select File</span>
                    </div>
                </div>
            </div>
        )}

        {/* Stage 2 & 3: Generation & Sync & Render UI */}
        {stage !== AppStage.SCRIPT_INPUT && (
            <div className="space-y-6">
                
                {/* Control Bar */}
                <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 flex flex-wrap justify-between items-center gap-4">
                   <div className="flex items-center gap-4">
                       <div className="bg-gray-900 p-2.5 rounded text-agent-400">
                           <ImageIcon size={24} />
                       </div>
                       <div>
                           <h2 className="font-bold text-white text-lg">Production Dashboard</h2>
                           <p className="text-xs text-gray-400">
                               {scriptLines.filter(l => l.status === 'completed').length} of {scriptLines.length} images ready
                           </p>
                       </div>
                   </div>
                   
                   <div className="flex gap-3">
                       {/* Manual Resume Button */}
                       {!isProcessingBatch && stage === AppStage.IMAGE_GENERATION && scriptLines.some(l => l.status === 'pending') && (
                           <button 
                               onClick={() => {
                                   setKeyModalMessage("Resume Generation: Enter API Key");
                                   setShowKeyModal(true);
                               }}
                               className="bg-agent-600 hover:bg-agent-500 text-white px-5 py-2 rounded font-bold flex items-center gap-2 shadow-lg shadow-agent-900/50"
                           >
                               <Play size={18} /> Resume Generation
                           </button>
                       )}
                       
                       {/* Processing Indicator */}
                       {isProcessingBatch && (
                           <div className="bg-blue-900/30 text-blue-200 border border-blue-800 px-5 py-2 rounded font-bold flex items-center gap-3">
                               <Loader2 className="animate-spin" size={18} /> 
                               Processing Batch...
                           </div>
                       )}

                       {/* Next Stage: Sync */}
                       {stage === AppStage.IMAGE_GENERATION && scriptLines.every(l => l.status === 'completed' || l.status === 'failed') && !isProcessingBatch && (
                           <button 
                               onClick={() => setStage(AppStage.AUDIO_SYNC)}
                               className="bg-green-600 hover:bg-green-500 text-white px-5 py-2 rounded font-bold flex items-center gap-2 animate-pulse"
                           >
                               Next: Audio Sync <CheckCircle size={18} />
                           </button>
                       )}
                   </div>
                </div>

                {/* Image Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4 h-[50vh] overflow-y-auto p-4 border border-gray-800 bg-gray-900/50 rounded-lg custom-scrollbar">
                    {scriptLines.map((line, idx) => (
                        <div key={line.id} className={`relative bg-gray-800 rounded-lg overflow-hidden border transition-all ${line.status === 'generating' ? 'border-agent-500 ring-2 ring-agent-500/50' : 'border-gray-700 hover:border-gray-500'}`}>
                            <div className="aspect-video bg-black flex items-center justify-center relative group">
                                {line.imageData ? (
                                    <img src={`data:image/png;base64,${line.imageData}`} alt="Gen" className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                                ) : (
                                    <div className="text-gray-700 flex flex-col items-center">
                                        <ImageIcon size={24} className="mb-2 opacity-30" />
                                        <span className="text-[10px] uppercase font-bold tracking-wider opacity-50">{line.status}</span>
                                    </div>
                                )}
                                
                                <div className="absolute top-1 right-1 z-10">
                                    {line.status === 'completed' && <CheckCircle size={16} className="text-green-400 bg-black rounded-full" />}
                                    {line.status === 'failed' && <AlertCircle size={16} className="text-red-500 bg-black rounded-full" />}
                                    {line.status === 'generating' && <Loader2 size={16} className="text-agent-400 animate-spin" />}
                                </div>
                                
                                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-2 pt-6">
                                    <span className="text-[10px] font-mono text-gray-400 block">#{idx + 1}</span>
                                </div>
                            </div>
                            <div className="p-2 border-t border-gray-700/50">
                                <p className="text-[10px] text-gray-400 line-clamp-2" title={line.spokenText}>{line.spokenText}</p>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Lower Panel: Sync & Render */}
                {(stage === AppStage.AUDIO_SYNC || stage === AppStage.RENDERING || stage === AppStage.COMPLETED) && (
                    <div className="grid md:grid-cols-2 gap-6 animate-in slide-in-from-bottom-4">
                        
                        {/* Audio Upload */}
                        <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
                             <h3 className="font-bold mb-4 flex items-center gap-2"><Music size={18} className="text-agent-400"/> Audio Source</h3>
                             <input 
                                type="file" 
                                accept="audio/*" 
                                onChange={handleAudioUpload}
                                className="block w-full text-sm text-gray-400
                                    file:mr-4 file:py-2 file:px-4
                                    file:rounded-full file:border-0
                                    file:text-sm file:font-semibold
                                    file:bg-agent-600 file:text-white
                                    hover:file:bg-agent-500 mb-4"
                             />
                             {audioUrl && <audio controls src={audioUrl} className="w-full mb-4" />}
                             
                             {stage === AppStage.AUDIO_SYNC && (
                                 <button 
                                    onClick={handleSync}
                                    disabled={isSyncing || !audioFile}
                                    className="w-full bg-agent-600 hover:bg-agent-500 text-white font-bold py-3 rounded disabled:opacity-50 transition-colors flex justify-center items-center gap-2"
                                 >
                                    {isSyncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                                    Sync Timeline
                                 </button>
                             )}
                        </div>

                        {/* Render Control */}
                        <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 flex flex-col justify-center items-center text-center">
                             <h3 className="font-bold mb-4 flex items-center gap-2"><Film size={18} className="text-agent-400"/> Final Output</h3>
                             
                             {stage === AppStage.RENDERING && !finalVideoBlob && (
                                 <div className="w-full">
                                     {renderProgress === 0 ? (
                                         <button 
                                            onClick={handleRender}
                                            className="w-full bg-gradient-to-r from-agent-600 to-teal-600 hover:from-agent-500 hover:to-teal-500 text-white font-bold py-4 rounded-xl shadow-lg transition-transform hover:scale-[1.02]"
                                         >
                                            Start Rendering (1080p)
                                         </button>
                                     ) : (
                                         <div className="w-full">
                                             <div className="flex justify-between text-xs text-gray-400 mb-1">
                                                 <span>Rendering...</span>
                                                 <span>{renderProgress}%</span>
                                             </div>
                                             <div className="w-full bg-gray-900 rounded-full h-3 overflow-hidden">
                                                 <div className="bg-agent-500 h-full transition-all duration-300" style={{ width: `${renderProgress}%` }} />
                                             </div>
                                         </div>
                                     )}
                                 </div>
                             )}

                             {finalVideoBlob && (
                                 <div className="w-full space-y-3">
                                     <a 
                                        href={URL.createObjectURL(finalVideoBlob)}
                                        download={`automedia_video_${Date.now()}.mp4`}
                                        className="block w-full bg-green-600 hover:bg-green-500 text-white font-bold py-3 rounded flex items-center justify-center gap-2"
                                     >
                                        <Download size={18} /> Download Video
                                     </a>
                                     {manifestUrl && (
                                         <a 
                                            href={manifestUrl}
                                            download={`automedia_manifest_${Date.now()}.json`}
                                            className="block w-full bg-gray-700 hover:bg-gray-600 text-gray-200 font-bold py-3 rounded flex items-center justify-center gap-2 border border-gray-600"
                                         >
                                            <FileJson size={18} /> Download Manifest
                                         </a>
                                     )}
                                 </div>
                             )}
                             
                             {stage === AppStage.AUDIO_SYNC && (
                                 <p className="text-sm text-gray-500">Waiting for sync...</p>
                             )}
                        </div>
                    </div>
                )}
            </div>
        )}

        {/* Console / Logs */}
        <div className="fixed bottom-4 right-4 w-80 max-h-48 overflow-y-auto bg-black/90 backdrop-blur-md text-green-400 p-3 rounded-lg border border-green-900/50 font-mono text-[10px] shadow-2xl z-40 pointer-events-none">
            <div className="uppercase text-gray-500 mb-1 font-bold tracking-widest border-b border-gray-800 pb-1">System Logs</div>
            <div className="space-y-0.5">
                {logs.length === 0 && <span className="opacity-30">System Ready.</span>}
                {logs.map((log, i) => (
                    <div key={i} className="break-words leading-tight">
                        <span className="text-gray-600 mr-1">[{new Date().toLocaleTimeString([], {hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit'})}]</span>
                        {log}
                    </div>
                ))}
            </div>
        </div>

      </main>
    </div>
  );
};

export default App;
