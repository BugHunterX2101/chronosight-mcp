export const CAMERA_MIME_TYPES = [
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm",
] as const;

export function recordingMimeType(supported: (mime: string) => boolean = (mime) => MediaRecorder.isTypeSupported(mime)): string {
  const mime = CAMERA_MIME_TYPES.find(supported);
  if (!mime) throw new Error("This browser cannot record a supported video format.");
  return mime;
}

export function recordingExtension(mime: string): "mp4" | "webm" {
  return mime.startsWith("video/mp4") ? "mp4" : "webm";
}

export async function recordCameraClip(durationMs = 5_000): Promise<File> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser does not provide camera capture.");
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  const mime = recordingMimeType();
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  try {
    const finished = new Promise<File>((resolve, reject) => {
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener("error", () => reject(new Error("Camera recording failed.")), { once: true });
      recorder.addEventListener("stop", () => {
        const type = recorder.mimeType || mime;
        resolve(new File([new Blob(chunks, { type })], `camera-${Date.now()}.${recordingExtension(type)}`, { type }));
      }, { once: true });
    });
    recorder.start();
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
    if (recorder.state !== "inactive") recorder.stop();
    return await finished;
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
