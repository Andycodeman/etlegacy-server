import { useState, useRef, useEffect } from 'react';

const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3000/api';

interface AudioPlayerProps {
  alias?: string; // For user's own sounds
  soundFileId?: number; // For public sounds
  onEnd?: () => void;
}

export default function AudioPlayer({ alias, soundFileId, onEnd }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(new Audio());
  const blobUrlRef = useRef<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [audioLoaded, setAudioLoaded] = useState(false);

  // Build the audio URL
  const getAudioUrl = () => {
    if (alias) {
      return `${API_BASE}/sounds/stream/${encodeURIComponent(alias)}`;
    } else if (soundFileId) {
      return `${API_BASE}/sounds/stream/public/${soundFileId}`;
    }
    return null;
  };

  // Set up audio element event listeners once
  useEffect(() => {
    const audio = audioRef.current;

    const handleTimeUpdate = () => setProgress(audio.currentTime);
    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
      setAudioLoaded(true);
      setIsLoading(false);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      setProgress(0);
      onEnd?.();
    };
    const handleError = () => {
      setError('Failed to load audio');
      setIsPlaying(false);
      setIsLoading(false);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
      audio.pause();
      audio.src = '';
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, [onEnd]);

  const loadAudio = async (): Promise<boolean> => {
    const url = getAudioUrl();
    if (!url) return false;

    const token = localStorage.getItem('accessToken');
    if (!token) {
      setError('Not authenticated');
      return false;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch audio');
      }

      const blob = await response.blob();

      // Revoke old blob URL if exists
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }

      const blobUrl = URL.createObjectURL(blob);
      blobUrlRef.current = blobUrl;

      audioRef.current.src = blobUrl;
      audioRef.current.load();

      return true;
    } catch (err) {
      setError('Failed to load audio');
      setIsLoading(false);
      console.error('Audio load error:', err);
      return false;
    }
  };

  const togglePlay = async () => {
    const audio = audioRef.current;

    // If already playing, pause
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      return;
    }

    // If audio not loaded yet, load it first
    if (!audioLoaded) {
      const loaded = await loadAudio();
      if (!loaded) return;

      // Wait a tick for the audio to be ready
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Play
    try {
      await audio.play();
      setIsPlaying(true);
      setError(null);
    } catch (err) {
      // Only show error if it's not an abort (which happens on rapid clicks)
      if (err instanceof Error && !err.message.includes('abort')) {
        setError('Failed to play');
        console.error('Play error:', err);
      }
    }
  };

  const stop = () => {
    const audio = audioRef.current;
    audio.pause();
    audio.currentTime = 0;
    setIsPlaying(false);
    setProgress(0);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const newTime = percentage * duration;

    audioRef.current.currentTime = newTime;
    setProgress(newTime);
  };

  const formatTime = (seconds: number) => {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const progressPercent = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-2">
      {/* Play/Pause Button */}
      <button
        onClick={togglePlay}
        disabled={isLoading}
        className={`w-8 h-8 flex items-center justify-center rounded-full transition-colors flex-shrink-0 ${
          isLoading
            ? 'bg-gray-600 text-gray-400 cursor-wait'
            : isPlaying
            ? 'bg-orange-600 text-white hover:bg-orange-500'
            : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white'
        }`}
        title={isLoading ? 'Loading...' : isPlaying ? 'Pause' : 'Play'}
      >
        {isLoading ? (
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        ) : isPlaying ? (
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
          </svg>
        ) : (
          <svg className="w-4 h-4 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      {/* Progress bar and controls - only show when playing or loaded */}
      {(isPlaying || audioLoaded) && (
        <>
          {/* Seekable Progress Bar */}
          <div
            className="flex-1 min-w-[80px] max-w-[120px] h-2 bg-gray-700 rounded-full cursor-pointer group"
            onClick={handleSeek}
            title="Click to seek"
          >
            <div
              className="h-full bg-orange-500 rounded-full relative transition-all duration-100 group-hover:bg-orange-400"
              style={{ width: `${progressPercent}%` }}
            >
              {/* Seek handle */}
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>

          {/* Time display */}
          <span className="text-xs text-gray-400 tabular-nums min-w-[70px] text-center flex-shrink-0">
            {formatTime(progress)} / {formatTime(duration)}
          </span>

          {/* Stop Button */}
          <button
            onClick={stop}
            className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors flex-shrink-0"
            title="Stop"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 6h12v12H6z" />
            </svg>
          </button>
        </>
      )}

      {/* Error indicator - only show if not playing (ignore transient errors) */}
      {error && !isPlaying && !isLoading && (
        <span className="text-xs text-red-400 flex-shrink-0" title={error}>
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
        </span>
      )}
    </div>
  );
}
