import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sounds } from '../api/client';

interface SoundClipEditorProps {
  tempId: string;
  durationSeconds: number;
  maxClipDuration: number;
  originalName: string;
  onSave: (alias: string, startTime: number, endTime: number, isPublic: boolean) => Promise<void>;
  onCancel: () => void;
  isSaving: boolean;
  saveError?: string;
}

// Format time with hundredths precision
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hundredths = Math.floor((seconds % 1) * 100);
  return `${mins}:${secs.toString().padStart(2, '0')}.${hundredths.toString().padStart(2, '0')}`;
}

// Format time for display (shorter format)
function formatTimeShort(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${mins}:${parseFloat(secs) < 10 ? '0' : ''}${secs}`;
}

// Parse time input - accepts M:SS.mm or just seconds
function parseTimeInput(input: string, maxDuration: number): number | null {
  const trimmed = input.trim();

  // Try M:SS.mm format (e.g., "1:23.45" or "0:05.00")
  const timeMatch = trimmed.match(/^(\d+):(\d{1,2})(?:\.(\d{1,2}))?$/);
  if (timeMatch) {
    const mins = parseInt(timeMatch[1], 10);
    const secs = parseInt(timeMatch[2], 10);
    const hundredths = timeMatch[3] ? parseInt(timeMatch[3].padEnd(2, '0'), 10) : 0;

    if (secs >= 60) return null;

    const totalSeconds = mins * 60 + secs + hundredths / 100;
    if (totalSeconds < 0 || totalSeconds > maxDuration) return null;
    return totalSeconds;
  }

  // Try plain seconds (e.g., "83.45" or "5")
  const num = parseFloat(trimmed);
  if (!isNaN(num) && num >= 0 && num <= maxDuration) {
    return num;
  }

  return null;
}

export default function SoundClipEditor({
  tempId,
  durationSeconds,
  maxClipDuration,
  originalName,
  onSave,
  onCancel,
  isSaving,
  saveError,
}: SoundClipEditorProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playMode, setPlayMode] = useState<'full' | 'selection'>('full');

  // Selection state (in seconds) - with hundredth precision
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(Math.min(maxClipDuration, durationSeconds));

  // Drag state
  const [isDragging, setIsDragging] = useState<'start' | 'end' | 'selection' | null>(null);
  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartValue, setDragStartValue] = useState({ start: 0, end: 0 });
  const [hasDragged, setHasDragged] = useState(false);

  // Zoom state (1 = fit to width, higher = zoomed in)
  const [zoom, setZoom] = useState(1);
  const minZoom = 1;
  const maxZoom = 20; // 20x zoom for precise selection

  // Form state
  const [alias, setAlias] = useState(
    originalName.replace(/\.mp3$/i, '').replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 32)
  );
  const [isPublic, setIsPublic] = useState(false);
  const [validationError, setValidationError] = useState('');

  // Manual time input state (separate from selection to allow typing)
  const [startTimeInput, setStartTimeInput] = useState(formatTime(selectionStart));
  const [endTimeInput, setEndTimeInput] = useState(formatTime(selectionEnd));
  const [isEditingStart, setIsEditingStart] = useState(false);
  const [isEditingEnd, setIsEditingEnd] = useState(false);

  // Update input fields when selection changes (but not while editing)
  useEffect(() => {
    if (!isEditingStart) {
      setStartTimeInput(formatTime(selectionStart));
    }
  }, [selectionStart, isEditingStart]);

  useEffect(() => {
    if (!isEditingEnd) {
      setEndTimeInput(formatTime(selectionEnd));
    }
  }, [selectionEnd, isEditingEnd]);

  // Fetch waveform data
  const { data: waveformData } = useQuery({
    queryKey: ['waveform', tempId],
    queryFn: () => sounds.getWaveform(tempId),
    staleTime: Infinity,
  });

  const peaks = waveformData?.peaks || [];

  // Audio loading state
  const [audioLoaded, setAudioLoaded] = useState(false);
  const [audioError, setAudioError] = useState('');

  // Load audio with authentication
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const loadAudio = async () => {
      try {
        const token = localStorage.getItem('accessToken');
        const streamUrl = sounds.getTempStreamUrl(tempId);

        const response = await fetch(streamUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to load audio');
        }

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        audio.src = blobUrl;
        setAudioLoaded(true);

        return () => URL.revokeObjectURL(blobUrl);
      } catch (err) {
        setAudioError('Failed to load audio file');
        console.error('Audio load error:', err);
      }
    };

    loadAudio();
  }, [tempId]);

  // Audio event handlers - use high-precision timer for selection end detection
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    let animationFrameId: number | null = null;

    // High-precision check using requestAnimationFrame
    const checkPlaybackPosition = () => {
      if (audio && !audio.paused) {
        setCurrentTime(audio.currentTime);

        // Check if we've reached selection end (with small buffer for precision)
        if (playMode === 'selection' && audio.currentTime >= selectionEnd - 0.01) {
          audio.pause();
          setIsPlaying(false);
          audio.currentTime = selectionStart;
        } else {
          animationFrameId = requestAnimationFrame(checkPlaybackPosition);
        }
      }
    };

    const handlePlay = () => {
      setIsPlaying(true);
      animationFrameId = requestAnimationFrame(checkPlaybackPosition);
    };

    const handlePause = () => {
      setIsPlaying(false);
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    };

    const handleEnded = () => {
      setIsPlaying(false);
      if (playMode === 'selection') {
        audio.currentTime = selectionStart;
      }
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    };

    const handleTimeUpdate = () => {
      // Still update time for when audio is paused and seeked
      if (audio.paused) {
        setCurrentTime(audio.currentTime);
      }
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [playMode, selectionStart, selectionEnd]);

  // Calculate timeline width based on zoom
  const timelineWidth = zoom * 100; // percentage

  // Convert pixel position to time (accounting for zoom and scroll)
  const pixelToTime = useCallback(
    (pixelX: number): number => {
      if (!timelineRef.current || !scrollContainerRef.current) return 0;
      const rect = timelineRef.current.getBoundingClientRect();
      const scrollLeft = scrollContainerRef.current.scrollLeft;
      const containerRect = scrollContainerRef.current.getBoundingClientRect();

      // Calculate position relative to the timeline start
      const relativeX = pixelX - containerRect.left + scrollLeft;
      const ratio = Math.max(0, Math.min(1, relativeX / rect.width));
      return ratio * durationSeconds;
    },
    [durationSeconds]
  );

  // Handle mouse down on timeline
  const handleTimelineClick = useCallback(
    (e: React.MouseEvent) => {
      // Only seek if it was a click, not a drag
      if (!hasDragged) {
        const time = pixelToTime(e.clientX);
        if (audioRef.current) {
          audioRef.current.currentTime = time;
          setCurrentTime(time);
        }
      }
    },
    [pixelToTime, hasDragged]
  );

  // Handle mouse down on handles/selection
  const handleMouseDown = useCallback(
    (e: React.MouseEvent, target: 'start' | 'end' | 'selection') => {
      e.preventDefault();
      e.stopPropagation();

      setIsDragging(target);
      setDragStartX(e.clientX);
      setDragStartValue({ start: selectionStart, end: selectionEnd });
      setHasDragged(false);
    },
    [selectionStart, selectionEnd]
  );

  // Handle mouse move during drag
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!timelineRef.current || !scrollContainerRef.current) return;

      const deltaX = e.clientX - dragStartX;

      // Mark as dragged if moved more than 3 pixels
      if (Math.abs(deltaX) > 3) {
        setHasDragged(true);
      }

      const rect = timelineRef.current.getBoundingClientRect();
      const deltaTime = (deltaX / rect.width) * durationSeconds;

      // Minimum selection duration: 0.1 seconds
      const minDuration = 0.1;

      if (isDragging === 'start') {
        let newStart = dragStartValue.start + deltaTime;
        // Clamp to valid range
        newStart = Math.max(0, Math.min(newStart, selectionEnd - minDuration));
        // Ensure doesn't exceed max duration
        if (selectionEnd - newStart > maxClipDuration) {
          newStart = selectionEnd - maxClipDuration;
        }
        setSelectionStart(newStart);
      } else if (isDragging === 'end') {
        let newEnd = dragStartValue.end + deltaTime;
        // Clamp to valid range
        newEnd = Math.max(selectionStart + minDuration, Math.min(durationSeconds, newEnd));
        // Ensure doesn't exceed max duration
        if (newEnd - selectionStart > maxClipDuration) {
          newEnd = selectionStart + maxClipDuration;
        }
        setSelectionEnd(newEnd);
      } else if (isDragging === 'selection') {
        const duration = dragStartValue.end - dragStartValue.start;
        let newStart = dragStartValue.start + deltaTime;
        let newEnd = dragStartValue.end + deltaTime;

        // Clamp to bounds
        if (newStart < 0) {
          newStart = 0;
          newEnd = duration;
        }
        if (newEnd > durationSeconds) {
          newEnd = durationSeconds;
          newStart = durationSeconds - duration;
        }

        setSelectionStart(newStart);
        setSelectionEnd(newEnd);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(null);
      // Reset hasDragged after a short delay to allow click handler to check it
      setTimeout(() => setHasDragged(false), 50);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragStartX, dragStartValue, durationSeconds, maxClipDuration, selectionStart, selectionEnd]);

  // Play functions
  const playFull = () => {
    const audio = audioRef.current;
    if (!audio) return;

    setPlayMode('full');
    if (isPlaying) {
      audio.pause();
    } else {
      // Resume from current position (don't reset to 0)
      audio.play();
    }
  };

  const playSelection = () => {
    const audio = audioRef.current;
    if (!audio) return;

    setPlayMode('selection');
    if (isPlaying) {
      audio.pause();
    } else {
      // If playhead is outside selection, start at selection start
      // If playhead is inside selection, resume from current position
      if (audio.currentTime < selectionStart || audio.currentTime >= selectionEnd) {
        audio.currentTime = selectionStart;
      }
      audio.play();
    }
  };

  const stop = () => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.pause();
    audio.currentTime = playMode === 'selection' ? selectionStart : 0;
    setIsPlaying(false);
  };

  // Zoom functions
  const zoomIn = () => setZoom((z) => Math.min(maxZoom, z * 1.5));
  const zoomOut = () => setZoom((z) => Math.max(minZoom, z / 1.5));
  const resetZoom = () => setZoom(1);

  // Scroll to selection when zoomed
  const scrollToSelection = () => {
    if (!scrollContainerRef.current || !timelineRef.current) return;
    const container = scrollContainerRef.current;
    const timeline = timelineRef.current;
    const selectionCenter = (selectionStart + selectionEnd) / 2 / durationSeconds;
    const scrollPos = selectionCenter * timeline.scrollWidth - container.clientWidth / 2;
    container.scrollTo({ left: Math.max(0, scrollPos), behavior: 'smooth' });
  };

  // Validate and save
  const handleSave = async () => {
    if (!alias || !/^[a-zA-Z0-9_]+$/.test(alias)) {
      setValidationError('Alias can only contain letters, numbers, and underscores');
      return;
    }
    if (alias.length > 32) {
      setValidationError('Alias must be 32 characters or less');
      return;
    }

    setValidationError('');
    await onSave(alias, selectionStart, selectionEnd, isPublic);
  };

  const selectionDuration = selectionEnd - selectionStart;
  const selectionLeftPercent = (selectionStart / durationSeconds) * 100;
  const selectionWidthPercent = (selectionDuration / durationSeconds) * 100;
  const playheadPercent = (currentTime / durationSeconds) * 100;

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h3 className="text-lg font-semibold mb-2">Edit Sound Clip</h3>
      <p className="text-sm text-gray-400 mb-4">
        Select up to {maxClipDuration} seconds from the audio. Use zoom for precise selection.
      </p>

      {/* Hidden audio element */}
      <audio ref={audioRef} preload="auto" />

      {/* Audio loading/error states */}
      {audioError && (
        <div className="bg-red-900/30 border border-red-600 rounded-lg p-4 mb-4">
          <p className="text-red-400">{audioError}</p>
        </div>
      )}

      {!audioLoaded && !audioError && (
        <div className="bg-gray-700 rounded-lg p-4 mb-4 flex items-center gap-3">
          <div className="animate-spin w-5 h-5 border-2 border-orange-500 border-t-transparent rounded-full" />
          <span className="text-gray-300">Loading audio...</span>
        </div>
      )}

      {/* Zoom controls */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-gray-400">Zoom:</span>
        <button
          onClick={zoomOut}
          disabled={zoom <= minZoom}
          className="px-2 py-1 text-sm bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed rounded"
        >
          −
        </button>
        <span className="text-xs text-gray-300 w-12 text-center">{zoom.toFixed(1)}x</span>
        <button
          onClick={zoomIn}
          disabled={zoom >= maxZoom}
          className="px-2 py-1 text-sm bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed rounded"
        >
          +
        </button>
        <button
          onClick={resetZoom}
          className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded ml-1"
        >
          Reset
        </button>
        {zoom > 1 && (
          <button
            onClick={scrollToSelection}
            className="px-2 py-1 text-xs bg-orange-600 hover:bg-orange-500 rounded ml-2"
          >
            Go to Selection
          </button>
        )}
      </div>

      {/* Timeline */}
      <div className="mb-4">
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          <span>0:00.00</span>
          <span>{formatTimeShort(durationSeconds)}</span>
        </div>

        {/* Scrollable container */}
        <div
          ref={scrollContainerRef}
          className="overflow-x-auto rounded-lg"
          style={{ scrollbarColor: '#4B5563 #1F2937' }}
        >
          <div
            ref={timelineRef}
            className="relative h-28 bg-gray-900 rounded-lg cursor-crosshair"
            style={{ width: `${timelineWidth}%`, minWidth: '100%' }}
            onClick={handleTimelineClick}
          >
            {/* Waveform */}
            <div className="absolute inset-0 flex items-center">
              <div className="flex items-center h-full w-full px-1">
                {peaks.length > 0 ? (
                  peaks.map((peak, i) => {
                    const height = Math.max(4, peak * 85);
                    const peakTime = (i / peaks.length) * durationSeconds;
                    const isInSelection = peakTime >= selectionStart && peakTime <= selectionEnd;
                    return (
                      <div
                        key={i}
                        className={`flex-1 mx-px rounded-sm transition-colors ${
                          isInSelection ? 'bg-orange-500' : 'bg-gray-600'
                        }`}
                        style={{ height: `${height}%` }}
                      />
                    );
                  })
                ) : (
                  <div className="w-full h-8 bg-gray-700 rounded animate-pulse" />
                )}
              </div>
            </div>

            {/* Selection overlay */}
            <div
              className="absolute top-0 bottom-0 bg-orange-500/20"
              style={{
                left: `${selectionLeftPercent}%`,
                width: `${selectionWidthPercent}%`,
              }}
            >
              {/* Left handle - larger grab area */}
              <div
                className="absolute left-0 top-0 bottom-0 w-4 -ml-2 cursor-ew-resize group z-10"
                onMouseDown={(e) => handleMouseDown(e, 'start')}
              >
                {/* Visual handle */}
                <div className="absolute left-1/2 top-0 bottom-0 w-1 -ml-0.5 bg-orange-500 group-hover:bg-orange-400 group-hover:w-1.5 transition-all">
                  {/* Handle grip dots */}
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-1">
                    <div className="w-1.5 h-1.5 bg-orange-300 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                    <div className="w-1.5 h-1.5 bg-orange-300 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                    <div className="w-1.5 h-1.5 bg-orange-300 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </div>
                {/* Extended hover area indicator */}
                <div className="absolute inset-0 bg-orange-500/10 opacity-0 group-hover:opacity-100 transition-opacity rounded" />
              </div>

              {/* Center drag area */}
              <div
                className="absolute inset-0 left-4 right-4 cursor-grab active:cursor-grabbing"
                onMouseDown={(e) => handleMouseDown(e, 'selection')}
              />

              {/* Right handle - larger grab area */}
              <div
                className="absolute right-0 top-0 bottom-0 w-4 -mr-2 cursor-ew-resize group z-10"
                onMouseDown={(e) => handleMouseDown(e, 'end')}
              >
                {/* Visual handle */}
                <div className="absolute left-1/2 top-0 bottom-0 w-1 -ml-0.5 bg-orange-500 group-hover:bg-orange-400 group-hover:w-1.5 transition-all">
                  {/* Handle grip dots */}
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-1">
                    <div className="w-1.5 h-1.5 bg-orange-300 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                    <div className="w-1.5 h-1.5 bg-orange-300 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                    <div className="w-1.5 h-1.5 bg-orange-300 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </div>
                {/* Extended hover area indicator */}
                <div className="absolute inset-0 bg-orange-500/10 opacity-0 group-hover:opacity-100 transition-opacity rounded" />
              </div>
            </div>

            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-white pointer-events-none z-20"
              style={{ left: `${playheadPercent}%` }}
            >
              <div className="absolute -top-1 -left-1.5 w-3 h-3 bg-white rounded-full" />
            </div>

            {/* Time markers when zoomed */}
            {zoom > 2 && (
              <div className="absolute bottom-0 left-0 right-0 h-4 flex items-end pointer-events-none">
                {Array.from({ length: Math.ceil(durationSeconds) + 1 }).map((_, i) => (
                  <div
                    key={i}
                    className="absolute bottom-0 flex flex-col items-center"
                    style={{ left: `${(i / durationSeconds) * 100}%` }}
                  >
                    <div className="w-px h-2 bg-gray-500" />
                    <span className="text-[8px] text-gray-500">{i}s</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Selection info - with editable time inputs */}
        <div className="flex justify-between items-center text-xs mt-2 gap-2">
          <div className="flex items-center gap-1">
            <span className="text-gray-400">Start:</span>
            <input
              type="text"
              value={startTimeInput}
              onFocus={() => setIsEditingStart(true)}
              onChange={(e) => setStartTimeInput(e.target.value)}
              onBlur={(e) => {
                setIsEditingStart(false);
                const time = parseTimeInput(e.target.value, durationSeconds);
                if (time !== null) {
                  let newStart = Math.max(0, Math.min(time, selectionEnd - 0.1));
                  // Ensure max duration constraint
                  if (selectionEnd - newStart > maxClipDuration) {
                    newStart = selectionEnd - maxClipDuration;
                  }
                  setSelectionStart(newStart);
                } else {
                  // Reset to current value if invalid
                  setStartTimeInput(formatTime(selectionStart));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-0.5 text-orange-400 font-mono text-xs text-center focus:outline-none focus:border-orange-500"
            />
          </div>
          <span className="text-gray-300 font-mono">
            Duration: {formatTime(selectionDuration)}
            {selectionDuration > maxClipDuration && (
              <span className="text-red-400 ml-2">
                (max {maxClipDuration}s)
              </span>
            )}
          </span>
          <div className="flex items-center gap-1">
            <span className="text-gray-400">End:</span>
            <input
              type="text"
              value={endTimeInput}
              onFocus={() => setIsEditingEnd(true)}
              onChange={(e) => setEndTimeInput(e.target.value)}
              onBlur={(e) => {
                setIsEditingEnd(false);
                const time = parseTimeInput(e.target.value, durationSeconds);
                if (time !== null) {
                  let newEnd = Math.max(selectionStart + 0.1, Math.min(time, durationSeconds));
                  // Ensure max duration constraint
                  if (newEnd - selectionStart > maxClipDuration) {
                    newEnd = selectionStart + maxClipDuration;
                  }
                  setSelectionEnd(newEnd);
                } else {
                  // Reset to current value if invalid
                  setEndTimeInput(formatTime(selectionEnd));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              className="w-20 bg-gray-700 border border-gray-600 rounded px-2 py-0.5 text-orange-400 font-mono text-xs text-center focus:outline-none focus:border-orange-500"
            />
          </div>
        </div>
        <p className="text-[10px] text-gray-500 mt-1 text-center">
          Enter time as M:SS.mm (e.g., 1:23.45) or seconds (e.g., 83.45)
        </p>
      </div>

      {/* Playback controls */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={playFull}
          className={`px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors ${
            isPlaying && playMode === 'full'
              ? 'bg-gray-600 text-white'
              : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
          }`}
        >
          {isPlaying && playMode === 'full' ? (
            <>
              <span>⏸</span> Pause
            </>
          ) : (
            <>
              <span>▶</span> Play Full
            </>
          )}
        </button>

        <button
          onClick={playSelection}
          className={`px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors ${
            isPlaying && playMode === 'selection'
              ? 'bg-orange-700 text-white'
              : 'bg-orange-600 hover:bg-orange-500 text-white'
          }`}
        >
          {isPlaying && playMode === 'selection' ? (
            <>
              <span>⏸</span> Pause
            </>
          ) : (
            <>
              <span>▶</span> Play Selection
            </>
          )}
        </button>

        <button
          onClick={stop}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg font-medium text-gray-200 transition-colors"
        >
          <span>⏹</span> Stop
        </button>

        <span className="ml-auto text-sm text-gray-400 font-mono">
          {formatTime(currentTime)} / {formatTimeShort(durationSeconds)}
        </span>
      </div>

      {/* Save form */}
      <div className="border-t border-gray-700 pt-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Sound Alias (used in-game)
            </label>
            <input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
              placeholder="my_sound"
              maxLength={32}
              className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-orange-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Only letters, numbers, and underscores
            </p>
          </div>

          <div className="flex items-center">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
                className="w-5 h-5 bg-gray-700 border-gray-600 rounded focus:ring-orange-500 focus:ring-2"
              />
              <div>
                <span className="text-gray-200">Make Public</span>
                <p className="text-xs text-gray-500">
                  Others can add this sound to their library
                </p>
              </div>
            </label>
          </div>
        </div>

        {(validationError || saveError) && (
          <p className="text-red-400 text-sm mb-4">
            {validationError || saveError}
          </p>
        )}

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isSaving}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !alias || selectionDuration > maxClipDuration}
            className="px-6 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg font-medium transition-colors flex items-center gap-2"
          >
            {isSaving ? (
              <>
                <span className="animate-spin">⏳</span> Saving...
              </>
            ) : (
              <>
                <span>💾</span> Save Sound
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
