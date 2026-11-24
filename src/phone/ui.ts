import type { Storage } from "../api.ts";
import type { App } from "../app.ts";

export function showOutsideEven(): void {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (root && !root.childElementCount) root.textContent = "Open this page in the Even Realities app or the Even Hub simulator.";
}

export function mountPhone(app: App, _storage: Storage): void {
  const root = document.querySelector<HTMLDivElement>("#app")!;
  const draw = () => {
    root.textContent = `Chengzhang · ${app.screen.name}`;
  };
  app.subscribe(draw);
  draw();
}
