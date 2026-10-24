// The mask helpers of background removal (features/bgremove/mask.js) for the
// refine brush and the magic eraser. They load the first time one of those
// tools is picked, not at boot; maskLib() is null until then.

let lib = null;
let loading = null;

export function maskLib() {
  return lib;
}

// Resolves to the module (and keeps it for maskLib()); a failed load can be
// tried again.
export function loadMaskLib() {
  loading ||= import("../../features/bgremove/mask.js").then(
    (m) => (lib = m),
    (err) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}
