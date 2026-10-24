import { invoke } from "@tauri-apps/api/core";
import type { PreviewAdapter, PreviewData, PreviewKind } from "../types/preview";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "yaml", "yml", "toml",
  "ini", "conf", "cfg", "xml", "html", "htm", "css", "svg", "js", "jsx", "ts",
  "tsx", "rs", "py", "sh", "bash", "zsh", "c", "h", "cpp", "hpp", "java", "go",
  "rb", "php", "sql", "env", "gitignore", "gitconfig", "properties", "service",
]);

export function previewKind(name: string): PreviewKind | null {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["jpg", "jpeg", "png"].includes(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (!name.includes(".") || name.startsWith(".") || TEXT_EXTENSIONS.has(extension)) return "text";
  return null;
}

export function decodePreview(buffer: ArrayBuffer): PreviewData {
  if (buffer.byteLength < 4) throw new Error("Invalid preview response");
  const length = new DataView(buffer).getUint32(0, true);
  if (length > 1024 || length > buffer.byteLength - 4) throw new Error("Invalid preview response");
  const metadata = JSON.parse(new TextDecoder().decode(buffer.slice(4, length + 4)));
  if (!["image", "text", "pdf"].includes(metadata.kind) ||
      !Number.isSafeInteger(metadata.source_size) || metadata.source_size < 0 ||
      typeof metadata.truncated !== "boolean") throw new Error("Invalid preview metadata");
  return {
    kind: metadata.kind, sourceSize: metadata.source_size,
    truncated: metadata.truncated, bytes: buffer.slice(length + 4),
  };
}

export function createSftpPreviewAdapter(sessionId: string): PreviewAdapter {
  return {
    supports: (entry) => entry.entryType === "File" && previewKind(entry.name) !== null,
    async load(entry, signal) {
      signal.throwIfAborted();
      const requestId = await invoke<string>("sftp_preview_begin", {
        sftpSessionId: sessionId, path: entry.id,
      });
      const cancel = () => { void invoke("sftp_preview_cancel", { requestId }).catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        const bytes = await invoke<ArrayBuffer>("sftp_preview_read", { requestId });
        signal.throwIfAborted();
        return decodePreview(bytes);
      } finally {
        signal.removeEventListener("abort", cancel);
        cancel();
      }
    },
  };
}
