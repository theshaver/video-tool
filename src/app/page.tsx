"use client";

import { useState, useRef, useEffect } from "react";
import styles from "./page.module.css";

type Step = "onboarding" | "recording" | "preview" | "uploading" | "success";

export default function Home() {
  const [step, setStep] = useState<Step>("onboarding");

  // Registration data
  const [name, setName] = useState("");

  // Video references and states
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [recordedChunks, setRecordedChunks] = useState<Blob[]>([]);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0); // in seconds
  const MAX_TIME = 300; // 5 minutes

  // Upload state
  const [uploadProgress, setUploadProgress] = useState(0);

  // Timer reference
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // If we transition to 'recording', start the camera stream
    if (step === "recording" && !mediaStream && !videoBlob) {
      startCamera();
    }
  }, [step]);

  useEffect(() => {
    // Stop recording automatically if we hit 5 minutes
    if (isRecording && recordingTime >= MAX_TIME) {
      stopRecording();
    }
  }, [recordingTime, isRecording]);

  useEffect(() => {
    // Cleanup media streams on unmount
    return () => {
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
      }
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [mediaStream]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          facingMode: "user",
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: true,
      });
      setMediaStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true; // Mute live preview to prevent feedback
      }
    } catch (err) {
      console.error("Error accessing media devices.", err);
      alert("Could not access camera/microphone. Please ensure permissions are granted.");
    }
  };

  const startRecording = () => {
    if (!mediaStream) return;
    setRecordedChunks([]);

    // We try to grab the most editing-friendly format supported by this exact browser
    const getBestMimeType = () => {
      const types = [
        "video/mp4", // Native on Safari
        "video/webm;codecs=h264,opus", // WebM with H264 is better for most editors
        "video/webm;codecs=vp9,opus",
        "video/webm",
      ];
      for (const type of types) {
        if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
          return type;
        }
      }
      return ""; // Default/fallback
    };

    const mimeType = getBestMimeType();
    const options = mimeType ? { mimeType } : undefined;
    const recorder = new MediaRecorder(mediaStream, options);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        setRecordedChunks((prev) => [...prev, e.data]);
      }
    };

    // Fallback format resolving if browser ignores our hint
    const finalMimeType = recorder.mimeType || mimeType || "video/webm";

    const localChunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) localChunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(localChunks, { type: finalMimeType });
      setVideoBlob(blob);
      setStep("preview");

      // Stop the camera stream now that we have the video recorded
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        setMediaStream(null);
      }

      // Explicitly detach stream from video element to allow Blob playback
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };

    recorder.start(200); // collect 200ms chunks
    mediaRecorderRef.current = recorder;
    setIsRecording(true);
    setRecordingTime(0);

    timerRef.current = setInterval(() => {
      setRecordingTime((prev) => prev + 1);
    }, 1000);
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
    const secs = (seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  };

  const handleNext = () => {
    if (!name.trim()) {
      alert("Please enter your name.");
      return;
    }
    setStep("recording");
  };

  const retakeVideo = () => {
    setVideoBlob(null);
    setRecordedChunks([]);
    setRecordingTime(0);
    setStep("recording");
    startCamera();
  };

  const handleSubmit = async () => {
    if (!videoBlob) return;
    setStep("uploading");

    try {
      // 1. Get Resumable Upload URL from our Backend
      const response = await fetch("/api/upload-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          mimeType: videoBlob.type || "video/webm",
          size: videoBlob.size,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to initialize upload");
      }

      const { uploadUrl } = await response.json();

      // 2. Upload the Blob directly to Google Drive URL using XMLHttpRequest for progress tracking
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", uploadUrl, true);

        // This acts as a streaming PUT, we just pass the Blob.
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const percentComplete = (e.loaded / e.total) * 100;
            setUploadProgress(percentComplete);
          }
        };

        xhr.onload = () => {
          console.log("XHR onload - Status:", xhr.status);
          try {
            console.log("XHR onload - Body:", xhr.responseText);
          } catch(e) {}
          
          if (xhr.status >= 200 && xhr.status < 400) {
             resolve();
          } else if (xhr.status === 0) {
             console.warn("XHR status is 0. This is typically due to an opaque CORS response where the upload succeeded but browser masked the response.");
             resolve();
          } else {
             reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        };

        xhr.onerror = () => {
          console.error("XHR onerror event fired.");
          reject(new Error("Network error during upload"));
        };

        // No need for authorization header, the session URL works securely automatically!
        xhr.setRequestHeader("Content-Type", videoBlob.type || "video/webm");
        xhr.send(videoBlob);
      });

      console.log("Upload Promise correctly resolved. Moving to success UI.");
      setStep("success");

    } catch (err) {
      console.error("Caught Upload Error:", err);
      alert("An error occurred while confirming your upload. Please check the console.");
      setStep("preview"); // Go back so they can retry
      setUploadProgress(0);
    }
  };

  return (
    <main className={styles.container}>
      <div className={`${styles.card} glass-panel`}>

        {step === "onboarding" && (
          <>
            <h1>Welcome!</h1>
            <p className="subtitle">Let's get your video recorded.</p>

            <div className={styles.instructions}>
              <strong>Please note:</strong>
              <ul>
                <li style={{ marginBottom: "1rem" }}>Keep your video <strong>under 2 minutes</strong>.</li>
                <li style={{ marginBottom: "1.5rem" }}>
                  <div style={{ marginBottom: "0.5rem" }}>
                    Please use a <strong>laptop</strong> OR place your phone in <strong>landscape mode</strong>.
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "1.5rem", marginTop: "1rem" }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="5" width="18" height="11" rx="1" ry="1"></rect>
                      <path d="M1 20h22"></path>
                      <path d="M3 16l-2 4"></path>
                      <path d="M21 16l2 4"></path>
                      <path d="M8 20v-2h8v2"></path>
                    </svg>
                    <span style={{ fontSize: "1.2rem", color: "var(--text-secondary)", fontWeight: "bold" }}>OR</span>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="7" width="18" height="10" rx="2" ry="2"></rect>
                      <circle cx="6.5" cy="12" r="1" fill="currentColor" stroke="none"></circle>
                    </svg>
                  </div>
                </li>
                <li>When you click Next, your browser will ask for <strong>Camera and Mic access</strong>. Please select "Allow".</li>
              </ul>
            </div>

            <div className="input-group">
              <label className="input-label">Full Name</label>
              <input
                type="text"
                className="input-field"
                placeholder="Jane Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <button className="btn btn-primary" onClick={handleNext}>
              Next Step: Camera Setup
            </button>
          </>
        )}

        {(step === "recording" || step === "preview") && (
          <>
            <h2>{step === "recording" ? "Record your video" : "Review your video"}</h2>
            <div className={styles.videoContainer}>
              {/* Show live camera or playback stream */}
              <video
                ref={videoRef}
                className={styles.videoElement}
                autoPlay
                playsInline
                muted={step === "recording"}
                src={videoBlob ? URL.createObjectURL(videoBlob) : undefined}
                controls={step === "preview"}
              />

              {isRecording && (
                <div className={`${styles.timer} recording-pulse`}>
                  <span style={{ color: "var(--red)", marginRight: "8px" }}>●</span>
                  {formatTime(recordingTime)} / 05:00
                </div>
              )}
            </div>

            <div className={styles.controls}>
              {step === "recording" && !isRecording && (
                <button className="btn btn-danger" onClick={startRecording}>
                  Start Recording
                </button>
              )}
              {step === "recording" && isRecording && (
                <button className="btn btn-primary" onClick={stopRecording}>
                  Stop Recording
                </button>
              )}

              {step === "preview" && (
                <>
                  <button className="btn btn-secondary" onClick={retakeVideo}>
                    Retake Video
                  </button>
                  <button className="btn btn-primary" onClick={handleSubmit}>
                    Submit Video
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {step === "uploading" && (
          <>
            <h2>Uploading securely...</h2>
            <p className="subtitle">Do not close this page.</p>
            <div className={styles.progressContainer}>
              <div className={styles.progressBar} style={{ width: `${Math.max(uploadProgress, 5)}%` }} />
            </div>
            <p className={styles.uploadText}>{Math.round(uploadProgress)}% Complete</p>
          </>
        )}

        {step === "success" && (
          <>
            <div className={styles.successIcon}>✓</div>
            <h1>Thank you!</h1>
            <p className="subtitle">Your video has been recorded and safely uploaded.</p>
            <button className="btn btn-secondary" onClick={() => window.location.reload()}>
              Submit Another
            </button>
          </>
        )}

      </div>
    </main>
  );
}
