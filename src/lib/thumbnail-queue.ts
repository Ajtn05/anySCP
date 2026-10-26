// One background fetch at a time across tabs, with shared in-flight requests.
// Store compressed bytes, never decoded images or object URLs, in the LRU.
interface Consumer { resolve: (data: ArrayBuffer) => void; reject: (error: unknown) => void; cleanup: () => void }
interface Job {
  key: string; session: string; controller: AbortController;
  run: (signal: AbortSignal) => Promise<ArrayBuffer>;
  consumers: Set<Consumer>; cacheable: boolean;
}
interface Cached { data: ArrayBuffer; session: string; expires: number }

export class ThumbnailQueue {
  private cache = new Map<string, Cached>();
  private bytes = 0;
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private active: Job | null = null;

  constructor(private byteLimit = 16 * 1024 * 1024, private entryLimit = 128, private ttl = 30_000) {}

  /** Read completed work without starting or joining a background request. */
  getCached(session: string, key: string): ArrayBuffer | undefined {
    key = JSON.stringify([session, key]);
    const cached = this.cache.get(key);
    if (!cached) return;
    this.cache.delete(key);
    if (cached.expires <= Date.now()) {
      this.bytes -= cached.data.byteLength;
      return;
    }
    this.cache.set(key, cached);
    return cached.data;
  }

  request(session: string, key: string, run: Job["run"], signal: AbortSignal, cacheable = true): Promise<ArrayBuffer> {
    signal.throwIfAborted();
    const cached = cacheable ? this.getCached(session, key) : undefined;
    if (cached) return Promise.resolve(cached);
    key = JSON.stringify([session, key]);
    let job = this.jobs.get(key);
    if (!job) {
      if (this.jobs.size >= 128) return Promise.reject({ kind: "preview_deferred" });
      job = { key, session, run, consumers: new Set(), controller: new AbortController(), cacheable };
      this.jobs.set(key, job); this.queue.push(job);
    }
    const current = job;
    const result = new Promise<ArrayBuffer>((resolve, reject) => {
      const consumer: Consumer = { resolve, reject, cleanup: () => signal.removeEventListener("abort", cancel) };
      const cancel = () => {
        current.consumers.delete(consumer); consumer.cleanup(); reject(new DOMException("Preview cancelled", "AbortError"));
        if (!current.consumers.size) {
          current.controller.abort();
          if (this.jobs.get(key) === current) this.jobs.delete(key);
          this.queue = this.queue.filter((queued) => queued !== current);
        }
      };
      current.consumers.add(consumer);
      signal.addEventListener("abort", cancel, { once: true });
    });
    this.pump();
    return result;
  }

  clear(session: string) {
    for (const [key, entry] of this.cache) {
      if (entry.session === session) { this.bytes -= entry.data.byteLength; this.cache.delete(key); }
    }
    for (const [key, job] of this.jobs) {
      if (job.session !== session) continue;
      job.controller.abort(); this.jobs.delete(key);
      for (const consumer of job.consumers) { consumer.cleanup(); consumer.reject(new DOMException("Preview invalidated", "AbortError")); }
      job.consumers.clear();
    }
    this.queue = this.queue.filter((job) => job.session !== session);
  }

  private pump() {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    void Promise.resolve().then(() => {
      job.controller.signal.throwIfAborted();
      return job.run(job.controller.signal);
    }).then((data) => {
      if (job.controller.signal.aborted) return;
      if (job.cacheable && data.byteLength <= 512 * 1024) {
        while (this.cache.size >= this.entryLimit || this.bytes + data.byteLength > this.byteLimit) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.bytes -= this.cache.get(oldest)!.data.byteLength; this.cache.delete(oldest);
        }
        if (data.byteLength <= this.byteLimit && this.entryLimit > 0) {
          this.cache.set(job.key, { data, session: job.session, expires: Date.now() + this.ttl });
          this.bytes += data.byteLength;
        }
      }
      // Remove before notifying consumers: a consumer may immediately request
      // the same uncached key again while this promise's finally is pending.
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      for (const consumer of job.consumers) consumer.resolve(data);
    }, (error: unknown) => {
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      for (const consumer of job.consumers) consumer.reject(error);
    }).finally(() => {
      for (const consumer of job.consumers) consumer.cleanup();
      job.consumers.clear();
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      this.active = null; this.pump();
    });
  }
}

export const thumbnailQueue = new ThumbnailQueue();
