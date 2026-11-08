import { useEffect, useRef, useState } from "react";
import { api, json } from "./api";
import type { Lesson, Progress } from "./types";
export function Video({
  lesson,
  progress,
  onPictureInPictureChange,
}: {
  lesson: Lesson;
  progress: Progress;
  onPictureInPictureChange: (active: boolean) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const lastSave = useRef(0);
  const [error, setError] = useState("");
  const [pictureInPicture, setPictureInPicture] = useState(false);
  const togglePictureInPicture = async () => {
    setError("");
    try {
      if (document.pictureInPictureElement === video.current)
        await document.exitPictureInPicture();
      else await video.current?.requestPictureInPicture();
    } catch (error) {
      console.warn("画中画请求失败", error);
      setError("无法开启画中画，请确认浏览器支持且视频已加载");
    }
  };
  const save = (element = video.current) => {
    if (!element || !element.readyState) return;
    lastSave.current = Date.now();
    api(`/api/lessons/${lesson.id}/progress`, {
      ...json("PUT", {
        position: element.currentTime,
        rate: element.playbackRate,
      }),
      keepalive: true,
    }).catch((e) => setError(e.message));
  };
  useEffect(() => {
    const element = video.current;
    const enter = () => {
      setPictureInPicture(true);
      onPictureInPictureChange(true);
    };
    const leave = () => {
      setPictureInPicture(false);
      onPictureInPictureChange(false);
    };
    element?.addEventListener("enterpictureinpicture", enter);
    element?.addEventListener("leavepictureinpicture", leave);
    const visibility = () => {
      if (document.hidden) save();
    };
    const pagehide = () => save();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    return () => {
      save(element);
      element?.pause();
      element?.removeEventListener("enterpictureinpicture", enter);
      element?.removeEventListener("leavepictureinpicture", leave);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
    };
  }, [lesson.id, onPictureInPictureChange]);
  return (
    <>
      {pictureInPicture && (
        <button
          className="pip-return"
          onClick={() => void togglePictureInPicture()}
        >
          退出画中画
        </button>
      )}
      <div className="video-wrap">
        {lesson.video ? (
          <video
            ref={video}
            controls
            playsInline
            preload="metadata"
            aria-label={lesson.title}
            src={`/api/lessons/${lesson.id}/media?file=${encodeURIComponent("视频.mp4")}`}
            onLoadedMetadata={() => {
              const element = video.current!;
              element.currentTime = Math.min(
                progress.position,
                element.duration || progress.position,
              );
              element.playbackRate = progress.rate;
            }}
            onTimeUpdate={() => {
              if (Date.now() - lastSave.current > 5000) save();
            }}
            onPause={() => save()}
            onSeeked={() => save()}
            onRateChange={() => save()}
            onError={() => setError("视频无法播放，请检查文件是否完整")}
          />
        ) : (
          <div className="empty">本课节暂无视频</div>
        )}
        <div className="video-tools">
          {lesson.video && document.pictureInPictureEnabled && (
            <button onClick={() => void togglePictureInPicture()}>
              画中画
            </button>
          )}
          <label>
            倍速{" "}
            <select
              aria-label="播放倍速"
              defaultValue={progress.rate}
              onChange={(e) => {
                if (video.current)
                  video.current.playbackRate = Number(e.target.value);
              }}
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </select>
          </label>
          {error && (
            <span role="alert" className="error">
              {error}
            </span>
          )}
        </div>
      </div>
    </>
  );
}
