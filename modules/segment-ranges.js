import { SEGMENT_CONFIG } from "./config.js";

/** Splits a finite VOD duration into contiguous equal ranges. */
export function calculateSegmentRanges(durationSeconds, segmentCount) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("A positive finite VOD duration is required.");
  }
  if (
    !Number.isInteger(segmentCount) ||
    segmentCount < SEGMENT_CONFIG.minSegments ||
    segmentCount > SEGMENT_CONFIG.maxSegments
  ) {
    throw new Error(
      `Segment count must be an integer between ${SEGMENT_CONFIG.minSegments} and ${SEGMENT_CONFIG.maxSegments}.`,
    );
  }

  return Array.from({ length: segmentCount }, (_, index) => {
    const startTime = (durationSeconds * index) / segmentCount;
    const endTime =
      index === segmentCount - 1 ? durationSeconds : (durationSeconds * (index + 1)) / segmentCount;
    return {
      id: `segment-${index + 1}`,
      index,
      startTime,
      endTime,
      duration: endTime - startTime,
    };
  });
}

/** Formats media seconds as MM:SS or HH:MM:SS without affecting range precision. */
export function formatMediaTime(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  /** Pads one clock component to two digits. */
  const pad = (value) => String(value).padStart(2, "0");
  return hours
    ? `${pad(hours)}:${pad(minutes)}:${pad(remainingSeconds)}`
    : `${pad(minutes)}:${pad(remainingSeconds)}`;
}
