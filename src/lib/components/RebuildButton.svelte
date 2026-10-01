<script lang="ts">
  import { onMount } from "svelte";

  let {
    step,
    pageId,
    chapterSelected = false,
    onbefore,
  }: {
    step?: string;
    pageId?: string;
    chapterSelected?: boolean;
    onbefore?: () => Promise<unknown>;
  } = $props();

  const STORAGE_KEY = "scan.rebuild";

  let running = $state(false);
  let message = $state("Rebuilding Komatose…");

  function returnUrl() {
    const url = new URL(location.href);
    if (step) url.searchParams.set("step", step);
    if (pageId && !chapterSelected) url.searchParams.set("page", pageId);
    else url.searchParams.delete("page");
    return url.pathname + url.search;
  }

  function persist(href: string) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ href, at: Date.now() }));
  }

  function savedHref() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return "";
      const data = JSON.parse(raw) as { href?: string };
      return typeof data.href === "string" ? data.href : "";
    } catch {
      return "";
    }
  }

  async function ping(): Promise<"up" | "down" | "failed"> {
    try {
      const health = await fetch(`/login?rebuild=${Date.now()}`, { cache: "no-store" });
      if (!health.ok && health.status >= 500) return "down";
      const status = await fetch("/api/rebuild", { cache: "no-store" });
      if (status.ok) {
        const data = (await status.json()) as { phase?: string };
        if (data.phase === "failed") return "failed";
      }
      return "up";
    } catch {
      return "down";
    }
  }

  async function waitThenReload(href: string) {
    const deadline = Date.now() + 15 * 60 * 1000;
    let sawDown = false;
    while (Date.now() < deadline) {
      const state = await ping();
      if (state === "failed") throw new Error("Rebuild failed. Check data/logs/production.log.");
      if (state === "down") {
        sawDown = true;
        message = "Waiting for the server to come back…";
      } else if (sawDown) {
        message = "Restarting…";
        sessionStorage.removeItem(STORAGE_KEY);
        location.replace(href);
        return;
      } else {
        message = "Stopping and rebuilding…";
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error("Rebuild timed out. Check data/logs/production.log.");
  }

  async function rebuild() {
    if (running) return;
    running = true;
    message = "Saving and starting rebuild…";
    const next = returnUrl();
    persist(next);
    history.replaceState(null, "", next);
    try {
      await onbefore?.();
      const res = await fetch("/api/rebuild", { method: "POST" });
      if (res.status === 401 || res.status === 403) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not start rebuild");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Could not start rebuild") {
        sessionStorage.removeItem(STORAGE_KEY);
        running = false;
        alert(error.message);
        return;
      }
      message = "Waiting for the server to come back…";
    }
    try {
      await waitThenReload(next);
    } catch (error) {
      sessionStorage.removeItem(STORAGE_KEY);
      running = false;
      message = "Rebuilding Komatose…";
      alert(error instanceof Error ? error.message : "Rebuild failed");
    }
  }

  onMount(() => {
    const href = savedHref();
    if (!href) return;
    running = true;
    message = "Waiting for the server to come back…";
    void (async () => {
      const state = await ping();
      if (state === "failed") throw new Error("Rebuild failed. Check data/logs/production.log.");
      if (state === "up") {
        sessionStorage.removeItem(STORAGE_KEY);
        location.replace(href);
        return;
      }
      await waitThenReload(href);
    })().catch((error) => {
      sessionStorage.removeItem(STORAGE_KEY);
      running = false;
      alert(error instanceof Error ? error.message : "Rebuild failed");
    });
  });
</script>

<button
  class="rebuild-btn"
  type="button"
  title="Rebuild and restart, then return here"
  aria-label="Rebuild and restart"
  disabled={running}
  onclick={() => void rebuild()}
>
  <i class="bi bi-arrow-repeat" aria-hidden="true"></i>
</button>

{#if running}
  <div class="rebuild-overlay" role="status" aria-live="polite">
    <span class="spin" aria-hidden="true"></span>
    <p>{message}</p>
  </div>
{/if}

<style>
  .rebuild-btn {
    display: inline-grid;
    place-items: center;
    width: 1.7rem;
    height: 1.7rem;
    padding: 0;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: inherit;
    opacity: 0.7;
  }
  .rebuild-btn:hover:not(:disabled) {
    opacity: 1;
    background: var(--ed-hover, rgba(255, 255, 255, 0.08));
  }
  .rebuild-btn:disabled {
    opacity: 0.4;
  }
  .rebuild-overlay {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    background: var(--hud-panel);
    color: var(--hud-text);
    font: 600 14px Inter, system-ui, sans-serif;
  }
  .rebuild-overlay p {
    margin: 0;
  }
  .spin {
    width: 22px;
    height: 22px;
    border: 2px solid var(--hud-line);
    border-top-color: var(--hud-teal);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
