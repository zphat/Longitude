// Module worker for background removal, so downloads and inference never
// block the editor. Protocol (all plain data):
//   in:  { type: "job", id, job }  |  { type: "cancel", id }  |  { type: "release" }
//   out: { type: "ready" }
//        { type: "progress", id, phase, progress, message }
//        { type: "result", id, result }          (result.alpha is transferred)
//        { type: "error", id, error: { name, code, message, detail } }

import { friendlyError, releaseModel, runJob } from "./engine.js";

const inWorker = typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope;

if (inWorker) {
  const controllers = new Map();

  self.addEventListener("message", async (e) => {
    const msg = e.data || {};
    if (msg.type === "cancel") {
      controllers.get(msg.id)?.abort();
      return;
    }
    if (msg.type === "release") {
      await releaseModel();
      return;
    }
    if (msg.type !== "job") return;
    const controller = new AbortController();
    controllers.set(msg.id, controller);
    try {
      const result = await runJob(msg.job, {
        signal: controller.signal,
        onProgress: (p) => self.postMessage({ type: "progress", id: msg.id, ...p }),
      });
      self.postMessage({ type: "result", id: msg.id, result }, [result.alpha.buffer]);
    } catch (err) {
      const info = friendlyError(err);
      if (!["cancelled", "not-flat", "already-transparent"].includes(info.code)) console.error(err);
      self.postMessage({ type: "error", id: msg.id, error: info });
    } finally {
      controllers.delete(msg.id);
    }
  });

  self.postMessage({ type: "ready" });
}
