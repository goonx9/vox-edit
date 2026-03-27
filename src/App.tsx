import { useState, useEffect, useRef, useMemo } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { motion, AnimatePresence } from 'motion/react';
import { 
  Upload, 
  Play, 
  Pause, 
  Scissors, 
  Sparkles, 
  Video as VideoIcon, 
  Mic, 
  FileText, 
  Trash2, 
  Plus, 
  Loader2, 
  Wand2,
  Layers,
  Clock,
  ChevronRight,
  Volume2
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { VideoAsset, AudioAsset, TimelineSegment, EditProject } from './types';
import { cn } from './lib/utils';

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export default function App() {
  const [project, setProject] = useState<EditProject>({
    title: "Untitled Project",
    script: "",
    voiceover: null,
    clips: [],
    timeline: []
  });

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isAnalyzingClips, setIsAnalyzingClips] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number | null>(null);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Utility to capture a frame from a video
  const captureFrame = (videoUrl: string): Promise<string> => {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.src = videoUrl;
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.currentTime = 1; // Capture at 1 second
      video.onloadeddata = () => {
        video.currentTime = Math.min(1, video.duration / 2);
      };
      video.onseeked = () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.6).split(',')[1]); // Base64
      };
    });
  };

  // Handle File Uploads
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: 'video' | 'audio') => {
    const files = e.target.files;
    if (!files) return;

    const newAssets: VideoAsset[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const url = URL.createObjectURL(file);
      
      if (type === 'video') {
        const video = document.createElement('video');
        video.src = url;
        await new Promise((resolve) => {
          video.onloadedmetadata = () => {
            newAssets.push({
              id: uuidv4(),
              name: file.name,
              url,
              duration: video.duration,
              description: "Analyzing..." 
            });
            resolve(null);
          };
        });
      } else {
        const audio = document.createElement('audio');
        audio.src = url;
        await new Promise((resolve) => {
          audio.onloadedmetadata = () => {
            setProject(prev => ({
              ...prev,
              voiceover: {
                id: uuidv4(),
                name: file.name,
                url,
                duration: audio.duration
              }
            }));
            resolve(null);
          };
        });
      }
    }

    if (type === 'video') {
      setProject(prev => ({
        ...prev,
        clips: [...prev.clips, ...newAssets]
      }));

      // Analyze clips in background
      setIsAnalyzingClips(true);
      const analyzedClips = [...newAssets];
      for (let i = 0; i < analyzedClips.length; i++) {
        try {
          const frame = await captureFrame(analyzedClips[i].url);
          const response = await genAI.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: {
              parts: [
                { text: "Describe this video clip in 10 words or less. What is happening? Be specific about visual content." },
                { inlineData: { mimeType: "image/jpeg", data: frame } }
              ]
            }
          });
          const description = response.text || "No description";
          
          setProject(prev => ({
            ...prev,
            clips: prev.clips.map(c => c.id === analyzedClips[i].id ? { ...c, description } : c)
          }));
        } catch (err) {
          console.error("Clip analysis error:", err);
        }
      }
      setIsAnalyzingClips(false);
    }
  };

  // AI Analysis: Match Clips to Script
  const analyzeAndAssemble = async () => {
    if (!project.script || project.clips.length === 0) return;
    setIsAnalyzing(true);

    try {
      const clipInfo = project.clips.map(c => ({ 
        id: c.id, 
        name: c.name, 
        duration: c.duration,
        description: c.description 
      }));
      
      const response = await genAI.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `I have a video editing project for YouTube. 
        Script: "${project.script}"
        Available Clips: ${JSON.stringify(clipInfo)}
        
        Analyze the script and available clips. Create a high-retention YouTube timeline by matching segments of the script to the most relevant clips.
        Return a JSON object with a "timeline" array of { assetId: string, duration: number, scriptSnippet: string, zoom: number }.
        
        YouTube Optimization Rules:
        1. PACING: Use fast cuts. Each segment should ideally be 2-4 seconds long to keep the viewer engaged.
        2. DYNAMIC ZOOM: Assign a "zoom" level (1.0 to 1.3) to each segment. Use a mix of normal (1.0) and "punch-ins" (1.1-1.3) to emphasize key points in the script.
        3. TOTAL DURATION: The total duration of the timeline MUST match the voiceover duration if available (${project.voiceover?.duration || 'unknown'}s).
        4. RELEVANCE: Match each segment to the clip that best fits the visual description.
        5. FLOW: Ensure the sequence of clips feels logical and maintains high energy.`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              timeline: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    assetId: { type: Type.STRING },
                    duration: { type: Type.NUMBER },
                    scriptSnippet: { type: Type.STRING },
                    zoom: { type: Type.NUMBER, description: "Digital zoom level from 1.0 to 1.3" }
                  }
                }
              }
            }
          }
        }
      });

      const data = JSON.parse(response.text || '{}');
      let startTime = 0;
      const timelineWithTimes = data.timeline.map((seg: any) => {
        const segment = { ...seg, id: uuidv4(), startTime };
        startTime += seg.duration;
        return segment;
      });

      setProject(prev => ({
        ...prev,
        timeline: timelineWithTimes
      }));
      setCurrentTime(0);
      setActiveSegmentIndex(null);
    } catch (error) {
      console.error("Analysis error:", error);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const totalDuration = useMemo(() => {
    if (project.timeline.length === 0) return 0;
    const last = project.timeline[project.timeline.length - 1];
    return last.startTime + last.duration;
  }, [project.timeline]);

  // Playback Logic driven by Audio or Timer
  useEffect(() => {
    let animationFrame: number;
    let lastTime = performance.now();

    const update = () => {
      const now = performance.now();
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      if (isPlaying) {
        setCurrentTime(prev => {
          let next = prev;
          if (audioRef.current && !audioRef.current.paused) {
            next = audioRef.current.currentTime;
          } else {
            next = prev + delta;
          }

          // Find current segment
          const segmentIndex = project.timeline.findIndex(s => next >= s.startTime && next < s.startTime + s.duration);
          
          if (segmentIndex !== -1 && segmentIndex !== activeSegmentIndex) {
            setActiveSegmentIndex(segmentIndex);
            const segment = project.timeline[segmentIndex];
            const asset = project.clips.find(c => c.id === segment.assetId);
            if (asset && videoRef.current) {
              // Calculate offset within the clip
              const offset = next - segment.startTime;
              videoRef.current.src = asset.url;
              videoRef.current.currentTime = offset % asset.duration;
              // Apply zoom
              const zoom = segment.zoom || 1.0;
              videoRef.current.style.transform = `scale(${zoom})`;
              videoRef.current.play().catch(() => {});
            }
          }

          if (next > totalDuration) {
            setIsPlaying(false);
            return 0;
          }
          return next;
        });
      }
      animationFrame = requestAnimationFrame(update);
    };

    animationFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationFrame);
  }, [isPlaying, project.timeline, activeSegmentIndex, totalDuration]);

  const togglePlayback = () => {
    if (isPlaying) {
      setIsPlaying(false);
      videoRef.current?.pause();
      audioRef.current?.pause();
    } else {
      setIsPlaying(true);
      if (audioRef.current) {
        audioRef.current.currentTime = currentTime;
        audioRef.current.play().catch(() => {});
      }
      // Sync video to current segment
      const segmentIndex = project.timeline.findIndex(s => currentTime >= s.startTime && currentTime < s.startTime + s.duration);
      if (segmentIndex !== -1) {
        setActiveSegmentIndex(segmentIndex);
        const segment = project.timeline[segmentIndex];
        const asset = project.clips.find(c => c.id === segment.assetId);
        if (asset && videoRef.current) {
          const offset = currentTime - segment.startTime;
          videoRef.current.src = asset.url;
          videoRef.current.currentTime = offset % asset.duration;
          // Apply zoom
          const zoom = segment.zoom || 1.0;
          videoRef.current.style.transform = `scale(${zoom})`;
          videoRef.current.play().catch(() => {});
        }
      }
    }
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + timelineRef.current.scrollLeft - 24; // 24 is padding
    const newTime = Math.max(0, x / 100);
    setCurrentTime(newTime);
    if (audioRef.current) audioRef.current.currentTime = newTime;
    
    // Sync video
    const segmentIndex = project.timeline.findIndex(s => newTime >= s.startTime && newTime < s.startTime + s.duration);
    if (segmentIndex !== -1) {
      setActiveSegmentIndex(segmentIndex);
      const segment = project.timeline[segmentIndex];
      const asset = project.clips.find(c => c.id === segment.assetId);
      if (asset && videoRef.current) {
        const offset = newTime - segment.startTime;
        videoRef.current.src = asset.url;
        videoRef.current.currentTime = offset % asset.duration;
        // Apply zoom
        const zoom = segment.zoom || 1.0;
        videoRef.current.style.transform = `scale(${zoom})`;
        if (isPlaying) videoRef.current.play().catch(() => {});
      }
    }
  };

  const deleteSegment = (id: string) => {
    setProject(prev => {
      const newTimeline = prev.timeline.filter(s => s.id !== id);
      let currentStart = 0;
      const updatedTimeline = newTimeline.map(s => {
        const updated = { ...s, startTime: currentStart };
        currentStart += s.duration;
        return updated;
      });
      return { ...prev, timeline: updatedTimeline };
    });
    setActiveSegmentIndex(null);
  };

  const updateSegment = (id: string, updates: Partial<TimelineSegment>) => {
    setProject(prev => {
      const newTimeline = prev.timeline.map(s => s.id === id ? { ...s, ...updates } : s);
      let currentStart = 0;
      const updatedTimeline = newTimeline.map(s => {
        const updated = { ...s, startTime: currentStart };
        currentStart += s.duration;
        return updated;
      });
      return { ...prev, timeline: updatedTimeline };
    });
  };

  const moveSegment = (index: number, direction: 'left' | 'right') => {
    if (direction === 'left' && index === 0) return;
    if (direction === 'right' && index === project.timeline.length - 1) return;

    const newTimeline = [...project.timeline];
    const targetIndex = direction === 'left' ? index - 1 : index + 1;
    [newTimeline[index], newTimeline[targetIndex]] = [newTimeline[targetIndex], newTimeline[index]];

    let currentStart = 0;
    const updatedTimeline = newTimeline.map(s => {
      const updated = { ...s, startTime: currentStart };
      currentStart += s.duration;
      return updated;
    });

    setProject(prev => ({ ...prev, timeline: updatedTimeline }));
    setActiveSegmentIndex(targetIndex);
  };

  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement>(null);

  // Sync preview modal video zoom
  useEffect(() => {
    if (isPreviewOpen && activeSegmentIndex !== null && project.timeline[activeSegmentIndex]) {
      const segment = project.timeline[activeSegmentIndex];
      if (previewVideoRef.current) {
        const zoom = segment.zoom || 1.0;
        previewVideoRef.current.style.transform = `scale(${zoom})`;
      }
    }
  }, [isPreviewOpen, activeSegmentIndex, project.timeline]);

  const [isHelpOpen, setIsHelpOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white font-sans selection:bg-purple-500/30">
      {/* Top Navigation */}
      <header className="h-16 border-b border-white/10 px-6 flex items-center justify-between bg-black/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => setIsHelpOpen(true)}
            className="w-8 h-8 bg-gradient-to-br from-purple-500 to-blue-500 rounded-lg flex items-center justify-center hover:scale-110 transition-transform"
          >
            <Layers size={18} className="text-white" />
          </button>
          <h1 className="font-bold tracking-tight text-lg">VoxEdit AI</h1>
          <div className="flex items-center gap-2 px-2 py-0.5 bg-red-500/10 border border-red-500/20 rounded text-[9px] font-bold text-red-400 uppercase tracking-tighter">
            YouTube Optimized
          </div>
          <div className="h-4 w-[1px] bg-white/20 mx-2" />
          <input 
            value={project.title}
            onChange={e => setProject(prev => ({ ...prev, title: e.target.value }))}
            className="bg-transparent border-none focus:ring-0 text-white/60 hover:text-white transition-colors font-medium"
          />
        </div>
        
        <div className="flex items-center gap-3">
          {isAnalyzingClips && (
            <div className="flex items-center gap-2 text-[10px] font-bold text-purple-400 uppercase tracking-widest bg-purple-500/10 px-3 py-1.5 rounded-full border border-purple-500/20">
              <Loader2 className="animate-spin" size={12} />
              Analyzing Clips...
            </div>
          )}
          <button 
            onClick={() => setIsPreviewOpen(true)}
            className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2 rounded-full text-sm font-bold transition-all"
          >
            <Play size={16} />
            Preview
          </button>
          <button 
            onClick={analyzeAndAssemble}
            disabled={isAnalyzing || !project.script || project.clips.length === 0}
            className="flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:bg-white/10 disabled:text-white/30 px-4 py-2 rounded-full text-sm font-bold transition-all shadow-lg shadow-purple-500/20"
          >
            {isAnalyzing ? <Loader2 className="animate-spin" size={16} /> : <Wand2 size={16} />}
            AI Assemble
          </button>
        </div>
      </header>

      {/* Fullscreen Preview Modal */}
      <AnimatePresence>
        {isPreviewOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black flex flex-col items-center justify-center p-12"
          >
            <button 
              onClick={() => setIsPreviewOpen(false)}
              className="absolute top-8 right-8 p-3 bg-white/10 hover:bg-white/20 rounded-full transition-all"
            >
              <Plus size={24} className="rotate-45" />
            </button>
            
            <div className="w-full max-w-5xl aspect-video bg-black rounded-3xl overflow-hidden shadow-2xl shadow-purple-500/20 ring-1 ring-white/10 relative">
              <video 
                ref={previewVideoRef}
                src={project.timeline[activeSegmentIndex || 0]?.assetId ? project.clips.find(c => c.id === project.timeline[activeSegmentIndex || 0].assetId)?.url : ''}
                className="w-full h-full object-contain transition-transform duration-500 ease-out"
                autoPlay
                muted={!isPlaying}
              />
              <div className="absolute bottom-12 left-1/2 -translate-x-1/2 max-w-2xl text-center">
                <p className="text-2xl font-bold text-white drop-shadow-lg italic">
                  {project.timeline[activeSegmentIndex || 0]?.scriptSnippet}
                </p>
              </div>
            </div>

            <div className="mt-8 flex items-center gap-8">
              <button 
                onClick={togglePlayback}
                className="w-20 h-20 bg-purple-600 hover:bg-purple-500 rounded-full flex items-center justify-center shadow-xl shadow-purple-500/40 transition-all transform hover:scale-105"
              >
                {isPlaying ? <Pause size={40} fill="white" /> : <Play size={40} fill="white" className="ml-2" />}
              </button>
              <div className="text-center">
                <p className="text-3xl font-mono font-bold text-purple-400">{currentTime.toFixed(1)}s</p>
                <p className="text-xs text-white/40 uppercase tracking-widest font-bold">Current Time</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Help Modal */}
      <AnimatePresence>
        {isHelpOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] bg-black/80 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-[#111] border border-white/10 rounded-3xl p-8 max-w-xl w-full shadow-2xl relative"
            >
              <button 
                onClick={() => setIsHelpOpen(false)}
                className="absolute top-6 right-6 p-2 hover:bg-white/5 rounded-full transition-all"
              >
                <Plus size={20} className="rotate-45" />
              </button>
              
              <div className="flex items-center gap-4 mb-8">
                <div className="w-12 h-12 bg-gradient-to-br from-purple-500 to-blue-500 rounded-2xl flex items-center justify-center">
                  <Layers size={24} className="text-white" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold tracking-tight">How to use VoxEdit AI</h2>
                  <p className="text-white/40 text-sm">Create professional videos in minutes</p>
                </div>
              </div>

              <div className="space-y-6">
                <div className="flex gap-4">
                  <div className="w-8 h-8 bg-white/5 rounded-full flex items-center justify-center font-bold text-xs text-purple-400 border border-purple-500/20">1</div>
                  <div>
                    <h3 className="font-bold text-sm mb-1">Upload Assets</h3>
                    <p className="text-xs text-white/40 leading-relaxed">Upload your video clips and a voiceover file. The AI will automatically analyze your clips to understand their content.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-8 h-8 bg-white/5 rounded-full flex items-center justify-center font-bold text-xs text-purple-400 border border-purple-500/20">2</div>
                  <div>
                    <h3 className="font-bold text-sm mb-1">Write Script</h3>
                    <p className="text-xs text-white/40 leading-relaxed">Paste your script into the editor. This helps the AI match the right clips to the right words.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-8 h-8 bg-white/5 rounded-full flex items-center justify-center font-bold text-xs text-purple-400 border border-purple-500/20">3</div>
                  <div>
                    <h3 className="font-bold text-sm mb-1">AI Assemble (YouTube Optimized)</h3>
                    <p className="text-xs text-white/40 leading-relaxed">Click "AI Assemble" and watch as the AI builds your timeline with fast cuts and dynamic zoom levels designed to maximize viewer retention.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-8 h-8 bg-white/5 rounded-full flex items-center justify-center font-bold text-xs text-purple-400 border border-purple-500/20">4</div>
                  <div>
                    <h3 className="font-bold text-sm mb-1">Fine-tune</h3>
                    <p className="text-xs text-white/40 leading-relaxed">Adjust durations, reorder segments, or swap clips manually in the timeline for the perfect edit.</p>
                  </div>
                </div>
              </div>

              <button 
                onClick={() => setIsHelpOpen(false)}
                className="w-full mt-10 bg-purple-600 hover:bg-purple-500 py-3 rounded-xl font-bold text-sm transition-all shadow-lg shadow-purple-500/20"
              >
                Got it, let's edit!
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="h-[calc(100vh-4rem)] grid grid-cols-12 overflow-hidden">
        {/* Left Sidebar: Assets & Script */}
        <aside className="col-span-3 border-r border-white/10 bg-black/20 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
            {/* Segment Editor (Conditional) */}
            <AnimatePresence mode="wait">
              {activeSegmentIndex !== null && project.timeline[activeSegmentIndex] ? (
                <motion.section 
                  key="segment-editor"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="space-y-4 p-4 bg-purple-500/5 border border-purple-500/20 rounded-2xl"
                >
                  <div className="flex items-center justify-between">
                    <h2 className="text-[10px] font-bold uppercase tracking-widest text-purple-400 flex items-center gap-2">
                      <Sparkles size={12} /> Segment Editor
                    </h2>
                    <button 
                      onClick={() => setActiveSegmentIndex(null)}
                      className="text-[10px] font-bold text-white/40 hover:text-white"
                    >
                      Close
                    </button>
                  </div>
                  
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-[10px] text-white/40 uppercase font-bold">Duration (s)</label>
                      <input 
                        type="number" 
                        step="0.1"
                        value={project.timeline[activeSegmentIndex].duration}
                        onChange={e => updateSegment(project.timeline[activeSegmentIndex].id, { duration: parseFloat(e.target.value) || 1 })}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs focus:ring-1 focus:ring-purple-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-white/40 uppercase font-bold flex justify-between">
                        Zoom Level <span>{project.timeline[activeSegmentIndex].zoom?.toFixed(2) || '1.00'}x</span>
                      </label>
                      <input 
                        type="range" 
                        min="1" 
                        max="1.5" 
                        step="0.05"
                        value={project.timeline[activeSegmentIndex].zoom || 1}
                        onChange={e => updateSegment(project.timeline[activeSegmentIndex].id, { zoom: parseFloat(e.target.value) })}
                        className="w-full accent-purple-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-white/40 uppercase font-bold">Script Snippet</label>
                      <textarea 
                        value={project.timeline[activeSegmentIndex].scriptSnippet}
                        onChange={e => updateSegment(project.timeline[activeSegmentIndex].id, { scriptSnippet: e.target.value })}
                        className="w-full h-20 bg-white/5 border border-white/10 rounded-lg p-3 text-xs focus:ring-1 focus:ring-purple-500 resize-none"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button 
                        onClick={() => moveSegment(activeSegmentIndex, 'left')}
                        className="flex-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg py-2 text-[10px] font-bold uppercase tracking-wider transition-all"
                      >
                        Move Left
                      </button>
                      <button 
                        onClick={() => moveSegment(activeSegmentIndex, 'right')}
                        className="flex-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg py-2 text-[10px] font-bold uppercase tracking-wider transition-all"
                      >
                        Move Right
                      </button>
                    </div>
                    <button 
                      onClick={() => deleteSegment(project.timeline[activeSegmentIndex].id)}
                      className="w-full bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded-lg py-2 text-[10px] font-bold uppercase tracking-wider transition-all"
                    >
                      Delete Segment
                    </button>
                  </div>
                </motion.section>
              ) : null}
            </AnimatePresence>

            {/* Script Section */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[10px] font-bold uppercase tracking-widest text-white/40 flex items-center gap-2">
                  <FileText size={12} /> Script
                </h2>
                <button 
                  onClick={() => setProject(prev => ({ ...prev, script: "Welcome to VoxEdit AI. This is a revolutionary video editor that uses artificial intelligence to match your clips to your voiceover automatically. Simply upload your videos, add a script, and let the AI do the heavy lifting. You can then fine-tune your timeline manually for the perfect result." }))}
                  className="text-[10px] font-bold text-purple-400 hover:text-purple-300 transition-colors"
                >
                  Try Sample
                </button>
              </div>
              <textarea 
                value={project.script}
                onChange={e => setProject(prev => ({ ...prev, script: e.target.value }))}
                placeholder="Paste your script here..."
                className="w-full h-48 bg-white/5 border border-white/10 rounded-xl p-4 text-sm focus:ring-2 focus:ring-purple-500/50 transition-all resize-none placeholder:text-white/20"
              />
            </section>

            {/* Voiceover Section */}
            <section className="space-y-4">
              <h2 className="text-[10px] font-bold uppercase tracking-widest text-white/40 flex items-center gap-2">
                <Mic size={12} /> Voiceover
              </h2>
              {project.voiceover ? (
                <div className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-center justify-between group">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-purple-500/20 rounded-lg flex items-center justify-center text-purple-400">
                      <Volume2 size={16} />
                    </div>
                    <div className="overflow-hidden">
                      <p className="text-xs font-bold truncate w-32">{project.voiceover.name}</p>
                      <p className="text-[10px] text-white/40">{project.voiceover.duration.toFixed(1)}s</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => setProject(prev => ({ ...prev, voiceover: null }))}
                    className="opacity-0 group-hover:opacity-100 p-2 hover:bg-red-500/20 text-red-400 rounded-lg transition-all"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center gap-2 h-24 border-2 border-dashed border-white/10 rounded-xl hover:border-purple-500/50 hover:bg-purple-500/5 transition-all cursor-pointer group">
                  <Upload size={20} className="text-white/20 group-hover:text-purple-400 transition-colors" />
                  <span className="text-[10px] font-bold text-white/40 uppercase tracking-wider">Upload Audio</span>
                  <input type="file" accept="audio/*" className="hidden" onChange={e => handleFileUpload(e, 'audio')} />
                </label>
              )}
            </section>

            {/* Video Clips Section */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[10px] font-bold uppercase tracking-widest text-white/40 flex items-center gap-2">
                  <VideoIcon size={12} /> Clips ({project.clips.length})
                </h2>
                <label className="p-1 hover:bg-white/10 rounded-md cursor-pointer transition-colors">
                  <Plus size={14} />
                  <input type="file" multiple accept="video/*" className="hidden" onChange={e => handleFileUpload(e, 'video')} />
                </label>
              </div>
              
              <div className="grid grid-cols-2 gap-3">
                {project.clips.map(clip => (
                  <div key={clip.id} className="group relative aspect-video bg-white/5 rounded-lg overflow-hidden border border-white/10 hover:border-purple-500/50 transition-all">
                    <video src={clip.url} className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent p-2 flex flex-col justify-end">
                      <p className="text-[9px] font-bold truncate">{clip.name}</p>
                      <p className="text-[8px] text-white/40 truncate italic">{clip.description}</p>
                    </div>
                    <button 
                      onClick={() => setProject(prev => ({ ...prev, clips: prev.clips.filter(c => c.id !== clip.id) }))}
                      className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 p-1 bg-black/50 hover:bg-red-500/50 rounded-md transition-all"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
                {project.clips.length === 0 && (
                  <label className="col-span-2 flex flex-col items-center justify-center gap-2 h-32 border-2 border-dashed border-white/10 rounded-xl hover:border-purple-500/50 hover:bg-purple-500/5 transition-all cursor-pointer group">
                    <VideoIcon size={24} className="text-white/20 group-hover:text-purple-400 transition-colors" />
                    <span className="text-[10px] font-bold text-white/40 uppercase tracking-wider">Add Video Clips</span>
                    <input type="file" multiple accept="video/*" className="hidden" onChange={e => handleFileUpload(e, 'video')} />
                  </label>
                )}
              </div>
            </section>
          </div>
        </aside>

        {/* Center: Preview & Timeline */}
        <div className="col-span-9 flex flex-col bg-black overflow-hidden">
          {/* Preview Area */}
          <div className="flex-1 flex items-center justify-center p-8 bg-[#050505] relative">
            {project.timeline.length > 0 ? (
              <div className="w-full max-w-4xl aspect-video bg-black rounded-2xl shadow-2xl shadow-purple-500/5 overflow-hidden ring-1 ring-white/10 relative group">
                <video 
                  ref={videoRef}
                  className="w-full h-full object-contain transition-transform duration-500 ease-out"
                />
                {project.voiceover && (
                  <audio ref={audioRef} src={project.voiceover.url} className="hidden" />
                )}
                
                {/* Playback Overlay */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
                  <button 
                    onClick={togglePlayback}
                    className="w-16 h-16 bg-white/10 backdrop-blur-md hover:bg-white/20 rounded-full flex items-center justify-center transition-all transform hover:scale-110"
                  >
                    {isPlaying ? <Pause size={32} fill="white" /> : <Play size={32} fill="white" className="ml-1" />}
                  </button>
                </div>

                {/* Active Script Snippet Overlay */}
                {activeSegmentIndex !== null && project.timeline[activeSegmentIndex] && (
                  <div className="absolute bottom-8 left-1/2 -translate-x-1/2 max-w-lg text-center">
                    <motion.div 
                      key={activeSegmentIndex}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="bg-black/60 backdrop-blur-md border border-white/10 px-6 py-3 rounded-2xl"
                    >
                      <p className="text-sm font-medium text-white/90 italic">
                        "{project.timeline[activeSegmentIndex].scriptSnippet}"
                      </p>
                    </motion.div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center space-y-6 max-w-md">
                <div className="w-20 h-20 bg-white/5 rounded-3xl flex items-center justify-center mx-auto border border-white/10">
                  <VideoIcon size={32} className="text-white/20" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold tracking-tight">Ready to edit?</h3>
                  <p className="text-sm text-white/40 leading-relaxed">
                    Upload your clips and voiceover, then click <span className="text-purple-400 font-bold">AI Assemble</span> to generate your first edit automatically.
                  </p>
                </div>
                <div className="flex items-center justify-center gap-4">
                  <div className="flex flex-col items-center gap-1">
                    <div className={cn("w-2 h-2 rounded-full", project.clips.length > 0 ? "bg-green-500" : "bg-white/10")} />
                    <span className="text-[8px] font-bold uppercase tracking-widest text-white/20">Clips</span>
                  </div>
                  <div className="w-8 h-[1px] bg-white/10" />
                  <div className="flex flex-col items-center gap-1">
                    <div className={cn("w-2 h-2 rounded-full", project.voiceover ? "bg-green-500" : "bg-white/10")} />
                    <span className="text-[8px] font-bold uppercase tracking-widest text-white/20">Audio</span>
                  </div>
                  <div className="w-8 h-[1px] bg-white/10" />
                  <div className="flex flex-col items-center gap-1">
                    <div className={cn("w-2 h-2 rounded-full", project.script ? "bg-green-500" : "bg-white/10")} />
                    <span className="text-[8px] font-bold uppercase tracking-widest text-white/20">Script</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Timeline Area */}
          <div className="h-64 bg-[#0A0A0A] border-t border-white/10 flex flex-col">
            {/* Timeline Controls */}
            <div className="h-10 px-6 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <span className="text-[10px] font-mono text-purple-400">
                  {currentTime.toFixed(1)}s / {totalDuration.toFixed(1)}s
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => {
                    if (project.clips.length > 0) {
                      const newSegment: TimelineSegment = {
                        id: uuidv4(),
                        assetId: project.clips[0].id,
                        startTime: totalDuration,
                        duration: 5,
                        scriptSnippet: "New Segment"
                      };
                      setProject(prev => ({ ...prev, timeline: [...prev.timeline, newSegment] }));
                    }
                  }}
                  className="flex items-center gap-1 px-2 py-1 bg-white/5 hover:bg-white/10 rounded-md text-[10px] font-bold transition-all"
                >
                  <Plus size={12} /> Add Segment
                </button>
                <button 
                  onClick={() => setProject(prev => ({ ...prev, timeline: [] }))}
                  className="p-1.5 hover:bg-red-500/10 rounded-md text-white/40 hover:text-red-400 transition-colors"
                  title="Clear Timeline"
                >
                  <Trash2 size={14} />
                </button>
                <div className="h-4 w-[1px] bg-white/10 mx-1" />
                <button className="p-1.5 hover:bg-white/5 rounded-md text-white/40 hover:text-white transition-colors">
                  <Scissors size={14} />
                </button>
              </div>
            </div>

            {/* Timeline Tracks */}
            <div 
              className="flex-1 overflow-x-auto overflow-y-hidden relative custom-scrollbar" 
              ref={timelineRef}
              onClick={handleTimelineClick}
            >
              <div 
                className="h-full relative p-6"
                style={{ width: Math.max(1000, totalDuration * 100) }}
              >
                {/* Time Markers */}
                <div className="absolute top-0 left-6 right-0 h-4 flex pointer-events-none">
                  {Array.from({ length: Math.ceil(totalDuration) + 5 }).map((_, i) => (
                    <div key={i} className="flex-shrink-0 w-[100px] border-l border-white/5 text-[8px] text-white/20 pl-1 pt-1">
                      {i}s
                    </div>
                  ))}
                </div>

                {/* Playhead */}
                <div 
                  className="absolute top-0 bottom-0 w-[2px] bg-purple-500 z-20 pointer-events-none transition-all duration-100"
                  style={{ left: 24 + (currentTime * 100) }}
                >
                  <div className="absolute -top-1 -left-[5px] w-3 h-3 bg-purple-500 rounded-full shadow-lg shadow-purple-500/50" />
                </div>

                {/* Video Track */}
                <div className="mt-6 space-y-4">
                  <div className="h-16 bg-white/5 rounded-xl border border-white/5 relative overflow-hidden">
                    <div className="absolute inset-y-0 left-0 flex">
                      {project.timeline.map((segment, idx) => {
                        const asset = project.clips.find(c => c.id === segment.assetId);
                        return (
                          <motion.div
                            key={segment.id}
                            className={cn(
                              "h-full border-r border-black/50 relative group cursor-pointer overflow-hidden",
                              activeSegmentIndex === idx ? "bg-purple-500/40 ring-2 ring-purple-500 inset-0 z-10" : "bg-purple-500/20"
                            )}
                            style={{ width: segment.duration * 100 }}
                            onClick={() => {
                              setCurrentTime(segment.startTime);
                              setActiveSegmentIndex(idx);
                              if (videoRef.current && asset) {
                                videoRef.current.src = asset.url;
                                videoRef.current.currentTime = 0;
                                videoRef.current.play();
                              }
                            }}
                          >
                            <div className="absolute inset-0 flex items-center px-2">
                              <p className="text-[9px] font-bold truncate text-white/60 group-hover:text-white transition-colors">
                                {asset?.name || 'Missing Clip'} {segment.zoom && segment.zoom > 1 ? `(${segment.zoom.toFixed(1)}x)` : ''}
                              </p>
                            </div>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteSegment(segment.id);
                              }}
                              className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 p-1 bg-black/50 hover:bg-red-500/50 rounded-md transition-all z-20"
                            >
                              <Trash2 size={10} />
                            </button>
                          </motion.div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Audio Track */}
                  {project.voiceover && (
                    <div className="h-12 bg-blue-500/10 rounded-xl border border-blue-500/20 relative overflow-hidden">
                      <div 
                        className="h-full bg-blue-500/20 flex items-center px-4"
                        style={{ width: project.voiceover.duration * 100 }}
                      >
                        <Volume2 size={12} className="text-blue-400 mr-2" />
                        <span className="text-[9px] font-bold text-blue-400/60 uppercase tracking-wider">Voiceover</span>
                      </div>
                    </div>
                  )}
                </div>

                {project.timeline.length === 0 && !isAnalyzing && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="text-center space-y-2 opacity-20">
                      <Layers size={32} className="mx-auto" />
                      <p className="text-xs font-bold uppercase tracking-widest">Timeline Empty</p>
                      <p className="text-[10px]">Add clips and script, then click AI Assemble</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}
